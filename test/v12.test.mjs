import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeEtag, sameResource } from '../lib/mirrors.js'
import { Queue, QueueError } from '../lib/queue.js'

// --------------------------------------------------------- ② 同源判定

test('etag normalisation ignores the weak marker and quoting', () => {
  assert.equal(normalizeEtag('W/"ABC"'), 'abc')
  assert.equal(normalizeEtag('"abc"'), 'abc')
  assert.equal(normalizeEtag('abc'), 'abc')
  assert.equal(normalizeEtag(undefined), '')
})

test('sameResource accepts only a length-plus-etag match', () => {
  const origin = { length: 100, etag: '"a"' }
  assert.equal(sameResource(origin, { length: 100, etag: '"a"' }).ok, true)
  assert.equal(sameResource(origin, { length: 100, etag: 'W/abc' }).ok, false, 'different etag')
  assert.equal(sameResource(origin, { length: 100 }).ok, false, 'mirror hides its etag')
  assert.equal(sameResource(origin, { length: 99, etag: '"a"' }).ok, false, 'length differs')
  assert.equal(sameResource(origin, { length: -1 }).ok, false, 'mirror reports nothing')
})

test('sameResource falls back to length when the origin has no etag', () => {
  assert.equal(sameResource({ length: 100 }, { length: 100 }).ok, true)
  assert.equal(sameResource({ length: 100 }, { length: 50 }).ok, false)
})

test('sameResource keeps the mirror when the origin could not be probed', () => {
  // The blocked-origin case is exactly why mirrors exist; there is no baseline
  // to compare against, so the candidate is kept but flagged.
  const verdict = sameResource({ length: -1 }, { length: 1234 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.reason, 'origin-unknown')
})

// ------------------------------------------------------------ ① 队列去重

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dls-v12-'))
}

function makeQueue() {
  const table = new Map()
  const domain = {
    table: () => ({
      entries: () => table.entries(),
      keys: () => table.keys(),
      get: (key) => table.get(key),
      put: async (key, value) => void table.set(key, value),
      delete: async (key) => table.delete(key),
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
  const queue = new Queue({
    domain,
    transport: { transfer: async () => new Promise(() => {}), mirrorReports: new Map() },
    config: {
      maxConcurrentJobs: 1,
      connectionsPerJob: 16,
      speedLimitKbps: 0,
      checkpointSeconds: 30,
      autoResumeOnHostRestart: false,
    },
    log: () => {},
  })
  return { queue, table }
}

const caller = (session) => ({ workspace: 'w', session })

test('the same destination and source returns the running job instead of a second one', async () => {
  const dir = await scratchDir()
  const { queue } = makeQueue()
  try {
    const dest = path.join(dir, 'same.bin')
    const first = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: dest }, caller('s1'))
    const second = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: dest }, caller('s2'))

    assert.equal(second.id, first.id, 'the second call must reuse the first job')
    assert.equal(second.deduplicated, true)
    assert.equal(queue.list().length, 1, 'no second job may be created')
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the same destination from a different source is refused', async () => {
  const dir = await scratchDir()
  const { queue } = makeQueue()
  try {
    const dest = path.join(dir, 'clash.bin')
    await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: dest }, caller('s1'))
    await assert.rejects(
      () => queue.enqueue({ urls: ['https://other.example.org/a.bin'], destPath: dest }, caller('s2')),
      (error) => error instanceof QueueError && error.code === 'dest-in-use' && /already being downloaded/.test(error.message),
    )
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the same source into a different destination is allowed', async () => {
  const dir = await scratchDir()
  const { queue } = makeQueue()
  try {
    const a = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: path.join(dir, 'copy1.bin') }, caller('s1'))
    const b = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: path.join(dir, 'copy2.bin') }, caller('s1'))
    assert.notEqual(a.id, b.id, 'asking for two copies is a legitimate request')
    assert.equal(queue.list().length, 2)
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('path spelling differences are recognised as the same destination', async () => {
  const dir = await scratchDir()
  const { queue } = makeQueue()
  try {
    const first = await queue.enqueue(
      { urls: ['https://example.com/a.bin'], destPath: path.join(dir, 'sub', '..', 'file.bin') },
      caller('s1'),
    )
    const second = await queue.enqueue(
      { urls: ['https://example.com/a.bin'], destPath: path.join(dir, 'file.bin') },
      caller('s2'),
    )
    assert.equal(second.id, first.id, '.. must fold away before comparing')
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a finished job is reused while its file is still on disk', async () => {
  const dir = await scratchDir()
  const table = new Map()
  const domain = {
    table: () => ({
      entries: () => table.entries(),
      keys: () => table.keys(),
      get: (key) => table.get(key),
      put: async (key, value) => void table.set(key, value),
      delete: async (key) => table.delete(key),
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
  const queue = new Queue({
    domain,
    transport: {
      transfer: async ({ destPath }) => {
        await fs.writeFile(destPath, 'done')
        return { bytes: 4, total: 4 }
      },
      mirrorReports: new Map(),
    },
    config: {
      maxConcurrentJobs: 1,
      connectionsPerJob: 4,
      speedLimitKbps: 0,
      checkpointSeconds: 30,
      autoResumeOnHostRestart: false,
    },
    log: () => {},
  })
  try {
    const dest = path.join(dir, 'again.bin')
    const first = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: dest }, caller('s1'))
    const done = await queue.wait(first.id, 5000)
    assert.equal(done.state, 'completed')

    // Same file, already on disk: hand back the finished job instead of
    // downloading it a second time.
    const reuse = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: dest }, caller('s2'))
    assert.equal(reuse.id, first.id)
    assert.equal(reuse.deduplicated, true)
    assert.equal(queue.list().length, 1)

    // Once the file is gone, the same request must download again.
    await fs.rm(dest, { force: true })
    const again = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: dest }, caller('s2'))
    assert.notEqual(again.id, first.id, 'a deleted file has to be fetched again')
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------- ② 验证结果进入候选列表

test('only mirrors that prove the same bytes reach the transport', async () => {
  const payload = Buffer.alloc(4096, 3)
  const origin = http.createServer((request, response) => {
    response.writeHead(200, { 'content-length': String(payload.length), etag: '"v1"' })
    response.end(request.method === 'HEAD' ? undefined : payload)
  })
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const originUrl = `http://127.0.0.1:${origin.address().port}/f.bin`

  // A mirror that serves the same length and etag.
  const good = http.createServer((request, response) => {
    response.writeHead(200, { 'content-length': String(payload.length), etag: '"v1"' })
    response.end(request.method === 'HEAD' ? undefined : payload)
  })
  await new Promise((resolve) => good.listen(0, '127.0.0.1', resolve))
  const goodUrl = `http://127.0.0.1:${good.address().port}/f.bin`

  // A mirror serving a stale copy: same name, different length.
  const stale = http.createServer((request, response) => {
    const body = Buffer.alloc(1024, 9)
    response.writeHead(200, { 'content-length': String(body.length), etag: '"old"' })
    response.end(request.method === 'HEAD' ? undefined : body)
  })
  await new Promise((resolve) => stale.listen(0, '127.0.0.1', resolve))
  const staleUrl = `http://127.0.0.1:${stale.address().port}/f.bin`

  const { Transport } = await import('../lib/transport.js')
  const transport = new Transport({}, () => {})
  transport.mode = 'direct'

  const dir = await scratchDir()
  try {
    const dest = path.join(dir, 'verified.bin')
    const result = await transport.transfer({ urls: [originUrl, goodUrl, staleUrl], destPath: dest })
    assert.equal(result.bytes, payload.length)

    const report = transport.mirrorReports.get(originUrl)
    assert.deepEqual(report.verified, [goodUrl], 'the stale mirror must not be used')
    assert.equal(report.rejected.length, 1)
    assert.match(report.rejected[0].reason, /length/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await new Promise((resolve) => origin.close(resolve))
    await new Promise((resolve) => good.close(resolve))
    await new Promise((resolve) => stale.close(resolve))
  }
})
