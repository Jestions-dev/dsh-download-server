import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { expandMirrors, hostOf } from '../lib/mirrors.js'
import { planTransfer } from '../lib/transport.js'
import { Queue, QueueError } from '../lib/queue.js'

const MB = 1024 * 1024

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dls-v11-'))
}

/** Minimal in-memory domain with the surface Queue actually uses. */
function memoryDomain({ failPut } = {}) {
  const table = new Map()
  return {
    table: () => ({
      entries: () => table.entries(),
      keys: () => table.keys(),
      get: (key) => table.get(key),
      put: async (key, value) => {
        if (failPut?.()) throw new Error('storage is read-only')
        table.set(key, value)
      },
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

function makeQueue({ transport, config = {}, failPut } = {}) {
  const domain = memoryDomain({ failPut })
  const queue = new Queue({
    domain,
    transport: transport ?? { transfer: async () => ({ bytes: 0, total: 0 }) },
    config: {
      maxConcurrentJobs: 2,
      connectionsPerJob: 16,
      speedLimitKbps: 0,
      checkpointSeconds: 30,
      autoResumeOnHostRestart: false,
      ...config,
    },
    log: () => {},
  })
  return { queue, domain }
}

const caller = (session) => ({ workspace: 'w', session })

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- ④ mirrors

test('mirror expansion keeps the original first and adds one known mirror', () => {
  const hf = 'https://huggingface.co/distilbert-base-uncased/resolve/main/pytorch_model.bin'
  const result = expandMirrors([hf])
  assert.equal(result.urls[0], hf, 'the original URL must stay first')
  assert.equal(result.urls.length, 2)
  assert.match(result.urls[1], /^https:\/\/hf-mirror\.com\//)
  assert.equal(result.applied[0].rule, 'huggingface')
})

test('mirror expansion covers github releases, raw files and pythonhosted', () => {
  const cases = [
    ['https://github.com/owner/repo/releases/download/v1/a.tgz', 'github-release', /^https:\/\/ghproxy\.net\//],
    ['https://raw.githubusercontent.com/owner/repo/main/x.yml', 'raw-githubusercontent', /raw\.gitmirror\.com/],
    ['https://files.pythonhosted.org/packages/ab/cd/x.whl', 'pythonhosted', /pypi\.tuna\.tsinghua\.edu\.cn/],
  ]
  for (const [url, rule, pattern] of cases) {
    const { urls, applied } = expandMirrors([url])
    assert.equal(urls[0], url)
    assert.equal(applied[0]?.rule, rule)
    assert.match(urls[1], pattern)
  }
})

test('mirror expansion is idempotent on urls that are already mirrors', () => {
  const url = 'https://hf-mirror.com/some/path'
  const { urls, applied } = expandMirrors([url])
  assert.deepEqual(urls, [url])
  assert.equal(applied.length, 0)
})

test('mirror expansion leaves unknown hosts alone', () => {
  const url = 'https://example.com/file.bin'
  assert.deepEqual(expandMirrors([url]), { urls: [url], applied: [] })
})

// ---------------------------------------------------------------- ⑥ sizing

test('transfer planner scales connections with the file size', () => {
  assert.deepEqual(planTransfer(500 * 1024), { connections: 1, direct: true }, 'tiny files skip aria2')
  assert.deepEqual(planTransfer(4 * MB), { connections: 4, direct: false })
  assert.deepEqual(planTransfer(50 * MB), { connections: 16, direct: false })
  assert.deepEqual(planTransfer(-1), { connections: 8, direct: false }, 'unknown size stays conservative')
  assert.deepEqual(planTransfer(50 * MB, 4), { connections: 4, direct: false }, 'the cap is honoured')
})

// ------------------------------------------------------------ ① disk budget

test('disk guard counts what queued jobs will still consume', async () => {
  const dir = await scratchDir()
  const original = fs.statfs
  // 1200 MB free: enough for one 256 MB placeholder, not for a second one on top.
  fs.statfs = async () => ({ bavail: 1200, bsize: MB })
  // The job must stay in flight: a completed job is no longer holding space.
  const { queue, domain } = makeQueue({
    transport: { transfer: async () => new Promise(() => {}) },
    config: { maxConcurrentJobs: 1 },
  })
  try {
    const first = await queue.enqueue({ urls: ['https://example.com/a.bin'], destPath: path.join(dir, 'a.bin') }, caller('s1'))
    assert.ok(first.id)

    // Pretend the first job turned out to be 900 MB: 512 + 900 + 256 > 1200.
    const stored = [...domain._table.values()][0]
    stored.bytesTotal = 900 * MB
    domain._table.set('j' + stored.seq, stored)

    await assert.rejects(
      () => queue.enqueue({ urls: ['https://example.com/b.bin'], destPath: path.join(dir, 'b.bin') }, caller('s1')),
      (error) => error instanceof QueueError && error.code === 'disk-full' && /short by/.test(error.message),
    )
  } finally {
    fs.statfs = original
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- ② silent failures

test('an unwritable destination is refused before the transfer starts', async () => {
  const { queue } = makeQueue()
  const original = fs.access
  // The test account may be an administrator, so deny it explicitly instead of
  // relying on a path Windows would refuse.
  fs.access = async () => {
    const error = new Error('EACCES')
    error.code = 'EACCES'
    throw error
  }
  try {
    await assert.rejects(
      () => queue.enqueue({ urls: ['https://example.com/x.bin'], destPath: 'C:\\forbidden\\x.bin' }, caller('s1')),
      (error) => error instanceof QueueError && error.code === 'permission-denied' && /cannot write to/.test(error.message),
    )
  } finally {
    fs.access = original
    await queue.close()
  }
})

test('a failing checkpoint write is reported instead of swallowed', async () => {
  let fail = false
  const { queue } = makeQueue({
    failPut: () => fail,
    config: { checkpointSeconds: 0.01, maxConcurrentJobs: 1 },
    transport: {
      transfer: async (options) => {
        // Keep reporting new bytes so every checkpoint tick has something to
        // write, and honour the abort signal so the test can finish.
        let done = 0
        for (;;) {
          if (options.signal?.aborted) throw new Error('aborted')
          await tick(15)
          done += 2048
          options.onProgress?.(done, 10_000_000)
        }
      },
    },
  })
  const dir = await scratchDir()
  try {
    // recover() is what starts the checkpoint timer in production.
    await queue.recover()
    await queue.enqueue({ urls: ['https://example.com/slow.bin'], destPath: path.join(dir, 'slow.bin') }, caller('s1'))
    await tick(50)
    fail = true
    await tick(150)

    const health = queue.health()
    assert.ok(health.storage.errors > 0, 'storage errors must be counted, not dropped')
    assert.match(String(health.storage.lastError), /read-only/)
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ③ fairness

test('a session that queued a batch does not starve the other one', async () => {
  const started = []
  /** @type {Map<string, () => void>} */
  const releases = new Map()
  const transport = {
    transfer: async (options) => {
      started.push(options.destPath)
      await new Promise((resolve) => releases.set(options.destPath, () => resolve({ bytes: 1, total: 1 })))
      return { bytes: 1, total: 1 }
    },
  }
  const { queue } = makeQueue({ config: { maxConcurrentJobs: 1 }, transport })
  const dir = await scratchDir()
  try {
    // Session A grabs the only slot; both sessions then have work queued.
    const a1 = await queue.enqueue({ urls: ['https://example.com/a1.bin'], destPath: path.join(dir, 'a1.bin') }, caller('session-a'))
    await tick(20)
    await queue.enqueue({ urls: ['https://example.com/a2.bin'], destPath: path.join(dir, 'a2.bin') }, caller('session-a'))
    await queue.enqueue({ urls: ['https://example.com/b1.bin'], destPath: path.join(dir, 'b1.bin') }, caller('session-b'))
    await tick(20)

    assert.deepEqual(started.map((p) => path.basename(p)), ['a1.bin'], 'only one slot exists')

    // Freeing the slot must hand it to the other session, not to A's second job.
    releases.get(path.join(dir, 'a1.bin'))?.()
    await queue.wait(a1.id, 5000)
    await tick(40)

    assert.equal(started.length, 2)
    assert.equal(path.basename(started[1]), 'b1.bin', 'round-robin must not keep serving the same session')
  } finally {
    await queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ ⑤ cooldown

test('a mirror host that keeps failing goes into cooldown and recovers', async () => {
  const { queue } = makeQueue()
  const mirror = 'https://hf-mirror.com/x/y.bin'
  assert.equal(hostOf(mirror), 'hf-mirror.com')

  queue.noteUrlFailure(mirror)
  assert.equal(queue.mirrorStatus().length, 0, 'one failure is not enough to ban a host')

  queue.noteUrlFailure(mirror)
  const cooling = queue.mirrorStatus()
  assert.equal(cooling.length, 1)
  assert.equal(cooling[0].host, 'hf-mirror.com')
  assert.ok(cooling[0].cooldownUntil > Date.now())
  assert.equal(queue.health().mirrorHealth.length, 1)

  queue.noteUrlSuccess(mirror)
  assert.equal(queue.mirrorStatus().length, 0, 'a success clears the cooldown')
  assert.deepEqual(queue.health().storage, { errors: 0 })
  await queue.close()
})
