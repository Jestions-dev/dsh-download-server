import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Transport } from '../lib/transport.js'
import { Queue } from '../lib/queue.js'

/**
 * SPEC §12 的十条验收标准。这个文件就是那张清单，一条一个用例。
 *
 * 用的是真实的 Transport 和真实的 HTTP 服务器（不是桩），只有「关掉 DSH 再
 * 重开」用「新建一个 Queue 复用同一份存储」来模拟 —— 那正是 recover() 的全部
 * 职责。
 */

const PAYLOAD = Buffer.alloc(512 * 1024)
for (let i = 0; i < PAYLOAD.length; i += 1) PAYLOAD[i] = (i * 7) % 251

/**
 * Serves PAYLOAD slowly, so a download can be caught mid-flight and paused.
 * Records every Range header and can be told to stop after N chunks.
 */
async function slowServer({ chunkSize = 16 * 1024, delayMs = 60 } = {}) {
  const ranges = []
  const server = http.createServer(async (request, response) => {
    const header = request.headers.range
    ranges.push(header ?? null)

    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': String(PAYLOAD.length), etag: '"v1"' })
      response.end()
      return
    }

    let start = 0
    if (typeof header === 'string' && header.startsWith('bytes=')) {
      const parsed = Number(header.slice('bytes='.length).split('-')[0])
      if (Number.isFinite(parsed) && parsed > 0) start = parsed
    }

    const body = PAYLOAD.subarray(start)
    if (start > 0) {
      response.writeHead(206, {
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      })
    } else {
      response.writeHead(200, { 'content-length': String(body.length) })
    }

    for (let offset = 0; offset < body.length; offset += chunkSize) {
      if (response.destroyed) return
      response.write(body.subarray(offset, offset + chunkSize))
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    response.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/payload.bin`,
    ranges,
    close: () =>
      new Promise((resolve) => {
        // A paused download leaves a keep-alive socket behind; close() alone
        // would wait for it forever.
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** In-memory domain. Reusing one across two Queue instances simulates a restart. */
function memoryDomain() {
  const table = new Map()
  return {
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
    _table: table,
  }
}

function makeQueue(domain, { transport, autoResume = true } = {}) {
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
      autoResumeOnHostRestart: autoResume,
    },
    log: () => {},
  })
}

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dls-spec-'))
}

const caller = (session) => ({ workspace: 'w', session })
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until the job reports at least `bytes` downloaded, or give up. */
async function waitForProgress(queue, id, bytes = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = queue.get(id)
    if (view && view.bytesDone >= bytes) return view
    if (Date.now() > deadline) return queue.get(id)
    await tick(20)
  }
}

// ------------------------------------------------------------------ 1

test('① enqueue a file, watch the progress, see it complete', async () => {
  const server = await slowServer({ chunkSize: 64 * 1024, delayMs: 1 })
  const dir = await scratchDir()
  const domain = memoryDomain()
  const queue = makeQueue(domain)
  try {
    const dest = path.join(dir, 'one.bin')
    const job = await queue.enqueue({ urls: [server.url], destPath: dest }, caller('s1'))

    const midway = await waitForProgress(queue, job.id, 64 * 1024)
    assert.ok(midway.bytesDone > 0, 'status must show progress while the job runs')

    const done = await queue.wait(job.id, 15000)
    assert.equal(done.state, 'completed')
    assert.equal(done.bytesDone, PAYLOAD.length)
    assert.ok((await fs.readFile(dest)).equals(PAYLOAD))
  } finally {
    await queue.close()
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 2

test('② pause mid-flight, resume, and continue from the checkpoint', async () => {
  const server = await slowServer()
  const dir = await scratchDir()
  const queue = makeQueue(memoryDomain())
  try {
    const dest = path.join(dir, 'two.bin')
    const job = await queue.enqueue({ urls: [server.url], destPath: dest }, caller('s1'))
    await waitForProgress(queue, job.id, 64 * 1024)

    const paused = await queue.pause(job.id, caller('s1'))
    assert.equal(paused.state, 'paused')
    assert.ok(paused.bytesDone > 0, 'bytes already on disk must survive the pause')

    const resumed = await queue.resume(job.id, caller('s1'))
    assert.ok(['queued', 'running'].includes(resumed.state))

    const done = await queue.wait(job.id, 20000)
    assert.equal(done.state, 'completed')
    assert.ok((await fs.readFile(dest)).equals(PAYLOAD), 'the resumed file must be byte-identical')

    assert.ok(
      server.ranges.some((header) => typeof header === 'string' && header.startsWith('bytes=')),
      'resuming must ask the server for a range instead of starting over',
    )
  } finally {
    await queue.close()
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- 3 + 4

test('③ a restart leaves the job paused, and ④ recover resumes it from the checkpoint', async () => {
  const server = await slowServer()
  const dir = await scratchDir()
  const domain = memoryDomain()
  const dest = path.join(dir, 'three.bin')

  const first = makeQueue(domain)
  let jobId
  try {
    const job = await first.enqueue({ urls: [server.url], destPath: dest }, caller('s1'))
    jobId = job.id
    await waitForProgress(first, jobId, 64 * 1024)
  } finally {
    await first.close() // stands in for DSH shutting down mid-download
  }

  const stored = [...domain._table.values()][0]
  assert.equal(stored.state, 'paused', 'a shutdown must leave the job paused, not lost')
  assert.equal(stored.pauseReason, 'host_restart')
  assert.ok(stored.bytesCheckpoint > 0, 'the checkpoint must be on disk')

  // A fresh Queue over the same storage — this is what a DSH restart looks like.
  const second = makeQueue(domain, { autoResume: false })
  try {
    await second.recover()
    const recovered = second.get(jobId)
    assert.ok(recovered, 'the job must still be there after the restart')
    assert.ok(['paused', 'queued', 'running'].includes(recovered.state))

    // ④ resume from the checkpoint and finish without re-downloading from zero.
    if (recovered.state === 'paused') await second.resume(jobId, caller('s1'))
    const done = await second.wait(jobId, 20000)
    assert.equal(done.state, 'completed')
    assert.ok((await fs.readFile(dest)).equals(PAYLOAD))
    assert.ok(
      server.ranges.some((header) => typeof header === 'string' && header.startsWith('bytes=')),
      'the continuation must use a range request',
    )
  } finally {
    await second.close()
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- 5 + 6

test('⑤ another session cannot pause my job, ⑥ but it can watch it', async () => {
  const server = await slowServer()
  const dir = await scratchDir()
  const queue = makeQueue(memoryDomain())
  try {
    const dest = path.join(dir, 'five.bin')
    const job = await queue.enqueue({ urls: [server.url], destPath: dest }, caller('session-a'))
    await waitForProgress(queue, job.id, 32 * 1024)

    // ⑥ every session sees every job
    const seenByB = queue.get(job.id)
    assert.equal(seenByB.owner.session, 'session-a')
    assert.ok(seenByB.bytesDone > 0)

    // ⑤ only the owner may mutate it
    for (const action of ['pause', 'resume', 'cancel']) {
      await assert.rejects(
        () => queue[action](job.id, caller('session-b')),
        (error) => error.code === 'not-owner',
        `${action} by a non-owner must be refused`,
      )
    }
  } finally {
    await queue.close()
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- 7 + 8

test('⑦ cleanup(allWithoutFiles) drops records but keeps the file, ⑧ cleanup(all) removes both', async () => {
  const server = await slowServer({ chunkSize: 64 * 1024, delayMs: 1 })
  const dir = await scratchDir()
  const queue = makeQueue(memoryDomain())
  try {
    const keep = path.join(dir, 'keep.bin')
    const drop = path.join(dir, 'drop.bin')

    for (const dest of [keep, drop]) {
      const job = await queue.enqueue({ urls: [server.url], destPath: dest }, caller('s1'))
      const done = await queue.wait(job.id, 20000)
      assert.equal(done.state, 'completed')
    }
    assert.equal(queue.list().length, 2)

    // ⑦ records only
    const records = await queue.cleanup('allWithoutFiles', caller('s1'))
    assert.equal(records.removedRecords, 2)
    assert.equal(queue.list().length, 0, 'records must be gone')
    await fs.access(keep)
    await fs.access(drop)

    // ⑧ records + files
    const again = []
    for (const dest of [keep, drop]) {
      const job = await queue.enqueue({ urls: [server.url], destPath: dest }, caller('s1'))
      again.push(await queue.wait(job.id, 20000))
    }
    assert.equal(again.filter((j) => j.state === 'completed').length, 2)

    const all = await queue.cleanup('all', caller('s1'))
    assert.equal(all.removedRecords, 2)
    assert.equal(all.removedFiles, 2, 'scope=all must delete the downloaded files too')
    for (const dest of [keep, drop]) {
      await fs.access(dest).then(
        () => assert.fail(`${path.basename(dest)} should have been deleted`),
        () => {},
      )
    }
  } finally {
    await queue.close()
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- 9 + 10

test('⑨ without aria2 the single stream still finishes the file', async () => {
  const server = await slowServer({ chunkSize: 64 * 1024, delayMs: 1 })
  const dir = await scratchDir()
  const transport = new Transport({}, () => {})
  transport.mode = 'direct' // no aria2 available
  const queue = makeQueue(memoryDomain(), { transport })
  try {
    const dest = path.join(dir, 'nine.bin')
    const job = await queue.enqueue({ urls: [server.url], destPath: dest }, caller('s1'))
    const done = await queue.wait(job.id, 20000)
    assert.equal(done.state, 'completed')
    assert.ok((await fs.readFile(dest)).equals(PAYLOAD))
  } finally {
    await queue.close()
    await server.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('⑩ a destination without room is refused at enqueue time', async () => {
  const dir = await scratchDir()
  const queue = makeQueue(memoryDomain())
  const original = fs.statfs
  fs.statfs = async () => ({ bavail: 8, bsize: 4096 }) // 32 KB free
  try {
    await assert.rejects(
      () => queue.enqueue({ urls: ['https://example.com/big.iso'], destPath: path.join(dir, 'big.iso') }, caller('s1')),
      (error) => error.code === 'disk-full',
    )
  } finally {
    fs.statfs = original
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
