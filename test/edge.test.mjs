import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Transport } from '../lib/transport.js'
import { Queue, QueueError } from '../lib/queue.js'

/** 1 MiB of deterministic bytes so content comparison is meaningful. */
const PAYLOAD = Buffer.alloc(1024 * 1024)
for (let i = 0; i < PAYLOAD.length; i += 1) PAYLOAD[i] = i % 251

/** Serve PAYLOAD with Range support; records the Range headers it receives. */
async function withServer(run) {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push(request.headers.range ?? null)
    const header = request.headers.range
    if (typeof header === 'string' && header.startsWith('bytes=')) {
      const start = Number(header.slice('bytes='.length).split('-')[0])
      if (Number.isFinite(start) && start > 0) {
        const slice = PAYLOAD.subarray(start)
        response.writeHead(206, {
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
        })
        response.end(slice)
        return
      }
    }
    response.writeHead(200, { 'content-length': String(PAYLOAD.length) })
    response.end(PAYLOAD)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/payload.bin`
  try {
    await run(url, seen)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function scratchDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dls-test-'))
  return dir
}

/** Force the single-stream channel so the test never depends on a local aria2c. */
function directTransport() {
  const transport = new Transport({}, () => {})
  transport.mode = 'direct'
  return transport
}

test('single-stream fallback downloads the exact bytes', async () => {
  const dir = await scratchDir()
  try {
    await withServer(async (url) => {
      const dest = path.join(dir, 'full.bin')
      const result = await directTransport().transfer({ urls: [url], destPath: dest })
      const written = await fs.readFile(dest)
      assert.equal(result.bytes, PAYLOAD.length)
      assert.ok(written.equals(PAYLOAD), 'downloaded bytes must match the origin')
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('single-stream fallback resumes from an existing .part file', async () => {
  const dir = await scratchDir()
  try {
    await withServer(async (url, seen) => {
      const dest = path.join(dir, 'resume.bin')
      const half = PAYLOAD.length >> 1
      await fs.writeFile(`${dest}.part`, PAYLOAD.subarray(0, half))

      const result = await directTransport().transfer({ urls: [url], destPath: dest })
      const written = await fs.readFile(dest)

      assert.ok(
        seen.some((header) => typeof header === 'string' && header.startsWith('bytes=')),
        'the second attempt must ask for a range',
      )
      assert.equal(result.bytes, PAYLOAD.length)
      assert.ok(written.equals(PAYLOAD), 'resumed bytes must match the origin')
      await fs.access(`${dest}.part`).then(
        () => assert.fail('.part should be renamed away on success'),
        () => {},
      )
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('enqueue refuses a target filesystem without room', async () => {
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
    transport: { transfer: async () => ({ bytes: 0, total: 0 }) },
    config: {
      maxConcurrentJobs: 1,
      connectionsPerJob: 4,
      speedLimitKbps: 0,
      checkpointSeconds: 30,
      autoResumeOnHostRestart: false,
    },
    log: () => {},
  })

  const original = fs.statfs
  fs.statfs = async () => ({ bavail: 1, bsize: 4096 })
  try {
    await assert.rejects(
      () => queue.enqueue({ urls: ['https://example.com/x.bin'], destPath: path.join(dir, 'x.bin') }, { workspace: 'w', session: 's' }),
      (error) => error instanceof QueueError && error.code === 'disk-full',
    )
  } finally {
    fs.statfs = original
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
