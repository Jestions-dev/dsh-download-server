import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HeaderError, headerNames, normalizeHeaders, toAria2Headers } from '../lib/headers.js'
import { Queue } from '../lib/queue.js'
import { Transport } from '../lib/transport.js'

/**
 * SPEC §11.3 —— 自定义请求头（v1.3 / 0.4.0）。
 *
 * 背景：B站媒体 CDN 对不带 Referer 的请求一律 403，而旧的 download_enqueue
 * 只能给 urls/dest/sha256，于是这类直链根本下不了。这组用例守四件事：
 *
 *   ① 校验       坏 header 在入队时就失败，不要等传到一半
 *   ② 透传       两条通道（aria2 / 单流）和镜像探测都要带上
 *   ③ 脱敏       值可能是 cookie/token，输出里只能出现名字
 *   ④ 持久化     重启后接着下，header 不能丢
 */

const PAYLOAD = Buffer.from('dls-headers-'.repeat(4096))

/** Serves PAYLOAD, records the headers of every request it answers. */
async function headerServer({ requireReferer = true } = {}) {
  /** @type {{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders }[]} */
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method ?? 'GET', url: request.url ?? '/', headers: request.headers })

    if (requireReferer && !request.headers.referer) {
      response.writeHead(403)
      response.end('no referer')
      return
    }

    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': String(PAYLOAD.length), etag: '"v13"' })
      response.end()
      return
    }

    const range = request.headers.range
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      response.writeHead(206, {
        'content-length': String(PAYLOAD.length - start),
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      })
      response.end(PAYLOAD.subarray(start))
      return
    }

    response.writeHead(200, { 'content-length': String(PAYLOAD.length) })
    response.end(PAYLOAD)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    seen,
    url: (suffix = '/file.bin') => `http://127.0.0.1:${port}${suffix}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

function memoryDomain() {
  const table = new Map()
  return {
    entries: () => table.entries(),
    table: () => ({
      entries: () => table.entries(),
      keys: () => table.keys(),
      get: (key) => table.get(key),
      put: async (key, value) => void table.set(key, value),
      delete: async (key) => void table.delete(key),
    }),
    global: {
      _v: { nextSeq: 1 },
      get() {
        return this._v
      },
      async set(value) {
        this._v = value
      },
    },
  }
}

function makeQueue(domain, transport) {
  const t = transport ?? new Transport({}, () => {})
  t.mode = 'direct'
  return new Queue({
    domain,
    transport: t,
    config: {
      maxConcurrentJobs: 1,
      connectionsPerJob: 4,
      speedLimitKbps: 0,
      checkpointSeconds: 1,
      autoResumeOnHostRestart: true,
    },
    log: () => {},
  })
}

const CALLER = { workspace: 'ws', session: 'sess-1234' }

async function tempDest(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dls-hdr-'))
  return { dir, dest: path.join(dir, name) }
}

// ---------------------------------------------------------------- ① 校验

test('v13: 合法 header 原样保留，空对象等于没传', () => {
  assert.deepEqual(normalizeHeaders(undefined), {})
  assert.deepEqual(normalizeHeaders({}), {})

  const headers = normalizeHeaders({
    Referer: 'https://www.bilibili.com',
    'User-Agent': 'Mozilla/5.0',
  })
  assert.deepEqual(headers, {
    Referer: 'https://www.bilibili.com',
    'User-Agent': 'Mozilla/5.0',
  })
})

test('v13: 值里的换行被拒（防 header 注入）', () => {
  assert.throws(() => normalizeHeaders({ Referer: 'https://a\r\nX-Injected: 1' }), HeaderError)
  assert.throws(() => normalizeHeaders({ Referer: 'https://a\nX-Injected: 1' }), HeaderError)
  assert.throws(() => normalizeHeaders({ Referer: 'a\u0000b' }), HeaderError)
  assert.throws(() => normalizeHeaders({ Referer: 'a\u0007b' }), HeaderError)
})

test('v13: 非法名字、非字符串值、超量都要拒绝', () => {
  assert.throws(() => normalizeHeaders({ 'Bad Name': 'x' }), HeaderError)
  assert.throws(() => normalizeHeaders({ 'X:Y': 'x' }), HeaderError)
  assert.throws(() => normalizeHeaders({ '': 'x' }), HeaderError)
  assert.throws(() => normalizeHeaders({ Referer: 42 }), HeaderError)
  assert.throws(() => normalizeHeaders(['Referer', 'x']), HeaderError)
  assert.throws(() => normalizeHeaders('Referer: x'), HeaderError)

  const many = {}
  for (let i = 0; i < 33; i += 1) many[`X-N-${i}`] = 'v'
  assert.throws(() => normalizeHeaders(many), HeaderError)
})

test('v13: 传输层自己管的 header 不许覆盖', () => {
  for (const name of ['Range', 'range', 'Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Accept-Encoding']) {
    assert.throws(() => normalizeHeaders({ [name]: 'x' }), HeaderError, `${name} 应该被拒`)
  }
})

test('v13: 同名不同大小写算重复', () => {
  assert.throws(() => normalizeHeaders({ Referer: 'a', referer: 'b' }), HeaderError)
})

// ---------------------------------------------------------------- ② 透传

test('v13: 单流通道带上 header，镜像探测也带上', async () => {
  const server = await headerServer()
  const { dir, dest } = await tempDest('payload.bin')
  try {
    const queue = makeQueue(memoryDomain())
    // 两个地址：第二个会走 #verifiedUrls 的镜像探测（HEAD），必须同样带 Referer，
    // 否则探测 403、length 未知，好镜像会被当成坏的。
    const job = await queue.enqueue(
      {
        urls: [server.url('/a.bin'), server.url('/b.bin')],
        destPath: dest,
        headers: { Referer: 'https://www.bilibili.com', 'User-Agent': 'dls-test/1.0' },
      },
      CALLER,
    )

    const done = await queue.wait(job.id, 10_000)
    assert.equal(done.state, 'completed', `下载应成功，实际 ${done.state}: ${done.lastError ?? ''}`)

    const written = await fs.readFile(dest)
    assert.equal(written.length, PAYLOAD.length)

    // 每一个请求（HEAD 探测 + GET 下载）都必须带着 Referer
    assert.ok(server.seen.length >= 2, `应有探测 + 下载多次请求，实际 ${server.seen.length}`)
    for (const request of server.seen) {
      assert.equal(request.headers.referer, 'https://www.bilibili.com', `${request.method} ${request.url} 少了 Referer`)
      assert.equal(request.headers['user-agent'], 'dls-test/1.0')
    }
    assert.ok(server.seen.some((r) => r.method === 'HEAD'), '应有 HEAD 探测')
    assert.ok(server.seen.some((r) => r.method === 'GET'), '应有 GET 下载')
  } finally {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('v13: 不带 header 时仍然 403（证明这个用例真的在测 header）', async () => {
  const server = await headerServer()
  const { dir, dest } = await tempDest('nofail.bin')
  try {
    const queue = makeQueue(memoryDomain())
    const job = await queue.enqueue({ urls: [server.url()], destPath: dest }, CALLER)
    const done = await queue.wait(job.id, 10_000)
    assert.equal(done.state, 'failed')
    assert.match(String(done.lastError), /403/)
  } finally {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('v13: aria2 通道把它转成 "Name: Value" 列表', async () => {
  const { dir, dest } = await tempDest('aria.bin')
  const captured = []
  const transport = new Transport({}, () => {})
  transport.mode = 'aria2'
  transport.rpc = {
    call: async (method, params) => {
      captured.push({ method, params })
      if (method === 'aria2.addUri') return 'gid-1'
      if (method === 'aria2.tellStatus') {
        return { status: 'complete', totalLength: '4', completedLength: '4' }
      }
      return 'OK'
    },
  }
  try {
    await transport.transfer({
      urls: ['http://127.0.0.1:1/never.bin'],
      destPath: dest,
      headers: { Referer: 'https://www.bilibili.com', Cookie: 'sid=abc' },
    })

    const add = captured.find((c) => c.method === 'aria2.addUri')
    assert.ok(add, '应调用 aria2.addUri')
    assert.deepEqual(add.params[1].header, [
      'Referer: https://www.bilibili.com',
      'Cookie: sid=abc',
    ])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('v13: 没有 header 时 aria2 的 options 里不出现 header 字段', () => {
  assert.equal(toAria2Headers({}), undefined)
  assert.equal(toAria2Headers(undefined), undefined)
  assert.deepEqual(toAria2Headers({ A: 'b' }), ['A: b'])
})

// ---------------------------------------------------------------- ③ 脱敏

test('v13: 输出只列名字，值不出现', async () => {
  const server = await headerServer()
  const { dir, dest } = await tempDest('redact.bin')
  const secret = 'Bearer super-secret-token-42'
  try {
    const queue = makeQueue(memoryDomain())
    const job = await queue.enqueue(
      { urls: [server.url()], destPath: dest, headers: { Referer: 'https://www.bilibili.com', Authorization: secret } },
      CALLER,
    )
    await queue.wait(job.id, 10_000)

    const view = queue.get(job.id)
    assert.deepEqual(view.requestHeaders, ['Referer', 'Authorization'])

    const serialized = JSON.stringify(queue.list())
    assert.ok(!serialized.includes('super-secret-token-42'), '输出里不该出现 header 的值')
    assert.ok(serialized.includes('Authorization'), '但名字应该出现')
  } finally {
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('v13: headerNames 空值返回 undefined（不让输出出现空数组）', () => {
  assert.equal(headerNames(undefined), undefined)
  assert.equal(headerNames({}), undefined)
  assert.deepEqual(headerNames({ A: '1', B: '2' }), ['A', 'B'])
})

// ---------------------------------------------------------------- ④ 持久化

test('v13: 坏 header 在入队时就失败，不会建出 job', async () => {
  const { dir, dest } = await tempDest('never.bin')
  try {
    const domain = memoryDomain()
    const queue = makeQueue(domain)
    await assert.rejects(
      () => queue.enqueue({ urls: ['http://127.0.0.1:1/x'], destPath: dest, headers: { Range: 'bytes=0-1' } }, CALLER),
      (error) => error.code === 'header-invalid',
    )
    assert.equal([...domain.entries()].length, 0, '被拒的入队不该留下记录')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('v13: 重启后 header 还在（断点续传靠它）', async () => {
  const { dir, dest } = await tempDest('resume.bin')
  const domain = memoryDomain()
  try {
    const first = makeQueue(domain)
    const job = await first.enqueue(
      {
        urls: ['http://127.0.0.1:1/slow.bin'],
        destPath: dest,
        headers: { Referer: 'https://www.bilibili.com', Cookie: 'sid=keep' },
      },
      CALLER,
    )

    // 换一个 Queue 复用同一份存储 = 模拟 DSH 重启
    const second = makeQueue(domain)
    await second.recover()

    const record = second.jobs.get(job.id)
    assert.ok(record, 'job 应该还在')
    assert.deepEqual(record.headers, { Referer: 'https://www.bilibili.com', Cookie: 'sid=keep' })

    const view = second.get(job.id)
    assert.deepEqual(view.requestHeaders, ['Referer', 'Cookie'])
    assert.ok(!JSON.stringify(view).includes('sid=keep'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
