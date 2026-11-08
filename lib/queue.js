import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { formatJobId, isTerminal, parseJobId } from './types.js'

/** How many times one job may fail before it is parked as `failed`. */
export const MAX_ATTEMPTS = 3

/** Safe default for `download_cleanup`. */
export const DEFAULT_SCOPE = 'allWithoutFiles'

export const CLEANUP_SCOPES = ['records', 'cache', 'allWithoutFiles', 'all']

/** Drop undefined properties: the tool registry requires lossless JSON. */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** `J#1042` → `j1042`: the path-safe key used by the per-record storage layout. */
function storageKeyOf(id) {
  const seq = parseJobId(id)
  return seq === undefined ? id : `j${seq}`
}

export class QueueError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @typedef {object} Caller
 * @property {string} workspace  WorkspaceId
 * @property {string} session    SessionId of the parent session
 * @property {string} [origin]   subagent name, when the call came from one
 */

/**
 * The queue engine. Owns scheduling, state transitions and checkpoints; the
 * transport owns bytes and the domain owns durability.
 */
export class Queue {
  /**
   * @param {object} deps
   * @param {any} deps.domain                         opened DLS domain
   * @param {import('./transport.js').Transport} deps.transport
   * @param {object} deps.config
   * @param {(level: string, message: string) => void} [deps.log]
   * @param {() => number} [deps.now]
   * @param {(sessionId: string) => boolean | Promise<boolean>} [deps.isOwnerAlive]
   */
  constructor({ domain, transport, config, log = () => {}, now = Date.now, isOwnerAlive }) {
    // Per-record keys must match /^[a-zA-Z0-9_-]+$/ while the public id is
    // `J#1042`; translate at the storage boundary so callers stay on job ids.
    const rawJobs = domain.table('jobs')
    this.jobs = {
      entries: () => rawJobs.entries(),
      get: (id) => rawJobs.get(storageKeyOf(id)),
      put: (id, record) => rawJobs.put(storageKeyOf(id), record),
      // `deleteMany` only exists from 0.2.2; loop over `delete` so the plugin
      // also runs on 0.2.1 profiles.
      deleteMany: async (ids) => {
        let removed = 0
        for (const id of ids) {
          if (await rawJobs.delete(storageKeyOf(id))) removed += 1
        }
        return removed
      },
    }
    this.domain = domain
    this.transport = transport
    this.config = config
    this.log = log
    this.now = now
    this.isOwnerAlive = isOwnerAlive

    /** @type {Map<string, { controller: AbortController, startedAt: number }>} */
    this.active = new Map()
    /** @type {Map<string, { done: number, total: number, speed: number, lastDone: number, lastAt: number }>} */
    this.progress = new Map()
    this.closed = false
    this.timer = undefined
    this.checkpointTimer = undefined
  }

  // ---------------------------------------------------------------- lifecycle

  /** Reconcile persisted state with reality. Call once before serving. */
  async recover() {
    const resumed = []

    for (const [, record] of this.jobs.entries()) {
      if (record.state === 'running') {
        record.state = 'paused'
        record.pauseReason = 'host_restart'
        record.updatedAt = this.now()
        await this.jobs.put(record.id, record)
        resumed.push(record)
      }
    }

    if (resumed.length > 0) {
      this.log('info', `${resumed.length} job(s) interrupted by a restart -> paused(host_restart)`)
    }

    if (this.config.autoResumeOnHostRestart) {
      for (const record of resumed) {
        await this.resume(record.id, { workspace: record.ownerWorkspace, session: record.ownerSession }, { internal: true })
      }
    }

    await this.#cancelOrphans()

    this.checkpointTimer = setInterval(() => void this.#checkpointAll(), this.config.checkpointSeconds * 1000)
    this.checkpointTimer.unref?.()
    this.#schedule()
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    if (this.checkpointTimer) clearInterval(this.checkpointTimer)

    const pending = []
    for (const [id, entry] of this.active) {
      entry.controller.abort()
      pending.push(this.#stopAs(id, 'host_restart'))
    }
    await Promise.allSettled(pending)
  }

  // ------------------------------------------------------------------- reading

  /** Every session sees every job. */
  list() {
    return [...this.jobs.entries()].map(([, record]) => this.#view(record))
  }

  /** @param {string} id */
  get(id) {
    const record = this.jobs.get(id)
    return record ? this.#view(record) : undefined
  }

  /**
   * Block until a job reaches a terminal state or the timeout expires.
   * @param {string} id
   * @param {number} timeoutMs
   */
  async wait(id, timeoutMs = 60_000) {
    const deadline = this.now() + timeoutMs
    for (;;) {
      const record = this.jobs.get(id)
      if (!record) throw new QueueError('not-found', `job ${id} does not exist`)
      if (isTerminal(record.state)) return this.#view(record)
      if (this.now() >= deadline) return this.#view(record)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // ------------------------------------------------------------------- writing

  /**
   * Add a job. Returns immediately; the scheduler picks it up.
   * @param {{ urls: string[], destPath: string, expectSha256?: string }} spec
   * @param {Caller} caller
   */
  async enqueue(spec, caller) {
    if (!Array.isArray(spec.urls) || spec.urls.length === 0) {
      throw new QueueError('url-invalid', 'at least one URL is required')
    }
    for (const url of spec.urls) {
      try {
        const parsed = new URL(url)
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme')
      } catch {
        throw new QueueError('url-invalid', `not an http(s) URL: ${url}`)
      }
    }

    await this.#assertDiskSpace(spec.destPath)

    const seq = await this.#nextSeq()
    const id = formatJobId(seq)
    const stamp = this.now()

    /** @type {import('./types.js').JobRecord} */
    const record = {
      id,
      seq,
      ownerWorkspace: caller.workspace,
      ownerSession: caller.session,
      origin: caller.origin,
      urls: [...spec.urls],
      destPath: spec.destPath,
      state: 'queued',
      createdAt: stamp,
      updatedAt: stamp,
      bytesTotal: -1,
      bytesCheckpoint: 0,
      attempts: 0,
      expectSha256: spec.expectSha256,
    }

    await this.jobs.put(id, record)
    this.log('info', `${id} enqueued by ${caller.workspace}#${caller.session.slice(0, 8)}`)
    this.#schedule()
    return this.#view(record)
  }

  /** @param {string} id @param {Caller} caller */
  async pause(id, caller) {
    const record = this.#writable(id, caller)
    if (record.state !== 'running' && record.state !== 'queued') {
      throw new QueueError('bad-state', `${id} is ${record.state}, cannot pause`)
    }
    if (record.state === 'queued') {
      record.state = 'paused'
      record.pauseReason = 'user'
      record.updatedAt = this.now()
      await this.jobs.put(id, record)
      return this.#view(record)
    }
    this.active.get(id)?.controller.abort()
    await this.#stopAs(id, 'user')
    return this.#view(this.jobs.get(id))
  }

  /** @param {string} id @param {Caller} caller @param {{ internal?: boolean }} [options] */
  async resume(id, caller, options = {}) {
    const record = options.internal ? this.#must(id) : this.#writable(id, caller)
    if (record.state !== 'paused' && record.state !== 'queued') {
      throw new QueueError('bad-state', `${id} is ${record.state}, cannot resume`)
    }
    record.state = 'queued'
    delete record.pauseReason
    record.updatedAt = this.now()
    await this.jobs.put(id, record)
    this.#schedule()
    return this.#view(record)
  }

  /** @param {string} id @param {Caller} caller */
  async cancel(id, caller) {
    const record = this.#must(id)
    if (!this.#canWrite(record, caller)) {
      throw new QueueError('not-owner', `${id} belongs to another session`)
    }
    if (isTerminal(record.state)) {
      throw new QueueError('bad-state', `${id} is already ${record.state}`)
    }

    const controller = this.active.get(id)?.controller
    controller?.abort()

    record.state = 'canceled'
    record.updatedAt = this.now()
    await this.jobs.put(id, record)
    this.progress.delete(id)

    await this.#dropPartialFiles(record)
    this.log('info', `${id} canceled`)
    return this.#view(record)
  }

  /**
   * @param {string} scope
   * @param {Caller} caller
   */
  async cleanup(scope, caller) {
    if (!CLEANUP_SCOPES.includes(scope)) {
      throw new QueueError('bad-state', `unknown scope: ${scope}`)
    }

    const mine = [...this.jobs.entries()]
      .map(([, record]) => record)
      .filter((record) => record.ownerWorkspace === caller.workspace && record.ownerSession === caller.session)

    let removedRecords = 0
    let removedCacheFiles = 0
    let removedFiles = 0
    let freedBytes = 0

    const touch = async (file) => {
      try {
        const info = await fs.stat(file)
        await fs.rm(file, { force: true })
        return info.size
      } catch {
        return undefined
      }
    }

    if (scope === 'records' || scope === 'allWithoutFiles' || scope === 'all') {
      const removable = mine.filter((record) => isTerminal(record.state)).map((record) => record.id)
      if (removable.length > 0) {
        removedRecords = await this.jobs.deleteMany(removable)
      }
    }

    if (scope === 'cache' || scope === 'allWithoutFiles' || scope === 'all') {
      for (const record of mine) {
        for (const file of [`${record.destPath}.part`, `${record.destPath}.aria2`]) {
          const freed = await touch(file)
          if (freed !== undefined) removedCacheFiles += 1
          freedBytes += freed ?? 0
        }
      }
    }

    if (scope === 'all') {
      for (const record of mine) {
        if (!isTerminal(record.state)) continue
        const freed = await touch(record.destPath)
        if (freed !== undefined) removedFiles += 1
        freedBytes += freed ?? 0
      }
    }

    return { scope, removedRecords, removedCacheFiles, removedFiles, freedBytes }
  }

  // ------------------------------------------------------------------ internals

  /** @param {string} id */
  #must(id) {
    const record = this.jobs.get(id)
    if (!record) throw new QueueError('not-found', `job ${id} does not exist`)
    return record
  }

  /** @param {string} id @param {Caller} caller */
  #writable(id, caller) {
    const record = this.#must(id)
    if (!this.#canWrite(record, caller)) {
      throw new QueueError('not-owner', `${id} belongs to another session`)
    }
    return record
  }

  /** @param {import('./types.js').JobRecord} record @param {Caller} caller */
  #canWrite(record, caller) {
    if (isTerminal(record.state)) return true
    return record.ownerWorkspace === caller.workspace && record.ownerSession === caller.session
  }

  async #nextSeq() {
    const state = this.domain.global.get()
    const seq = state.nextSeq
    await this.domain.global.set({ nextSeq: seq + 1 })
    return seq
  }

  /** @param {import('./types.js').JobRecord} record */
  #view(record) {
    const live = this.progress.get(record.id)
    const total = live?.total && live.total > 0 ? live.total : record.bytesTotal
    const done = isTerminal(record.state)
      ? (record.finalBytes ?? record.bytesCheckpoint)
      : (live?.done ?? record.bytesCheckpoint)

    return compact({
      id: record.id,
      state: record.state,
      pauseReason: record.pauseReason,
      owner: { workspace: record.ownerWorkspace, session: record.ownerSession },
      origin: record.origin,
      urls: record.urls,
      dest: record.destPath,
      bytesTotal: total,
      bytesDone: done,
      speedBps: live?.speed ?? 0,
      etaSeconds: live && live.speed > 0 && total > 0 ? Math.max(0, Math.round((total - done) / live.speed)) : undefined,
      attempts: record.attempts,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
  }

  #schedule() {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.#pump()
    }, 0)
    this.timer.unref?.()
  }

  async #pump() {
    if (this.closed) return
    const queued = [...this.jobs.entries()]
      .map(([, record]) => record)
      .filter((record) => record.state === 'queued')
      .sort((a, b) => a.seq - b.seq)

    for (const record of queued) {
      if (this.active.size >= this.config.maxConcurrentJobs) break
      if (this.active.has(record.id)) continue
      void this.#run(record)
    }
  }

  /** @param {import('./types.js').JobRecord} record */
  async #run(record) {
    const id = record.id
    const controller = new AbortController()
    this.active.set(id, { controller, startedAt: this.now() })

    record.state = 'running'
    record.updatedAt = this.now()
    await this.jobs.put(id, record)

    const stats = { done: record.bytesCheckpoint, total: record.bytesTotal, speed: 0, lastDone: record.bytesCheckpoint, lastAt: this.now() }
    this.progress.set(id, stats)

    try {
      const result = await this.transport.transfer({
        urls: record.urls,
        destPath: record.destPath,
        connections: this.config.connectionsPerJob,
        speedLimitKbps: this.config.speedLimitKbps,
        bytesDone: record.bytesCheckpoint,
        signal: controller.signal,
        onProgress: (done, total) => {
          const stamp = this.now()
          const elapsed = (stamp - stats.lastAt) / 1000
          if (elapsed >= 0.4) {
            stats.speed = Math.max(0, (done - stats.lastDone) / elapsed)
            stats.lastDone = done
            stats.lastAt = stamp
          }
          stats.done = done
          if (total > 0) stats.total = total
        },
      })

      if (record.expectSha256) {
        const actual = await sha256File(record.destPath)
        if (actual.toLowerCase() !== record.expectSha256.toLowerCase()) {
          throw new Error(`sha256 mismatch: expected ${record.expectSha256}, got ${actual}`)
        }
      }

      await this.#finish(id, 'completed', {
        bytesTotal: result.total > 0 ? result.total : stats.total,
        bytesCheckpoint: result.bytes,
        finalBytes: result.bytes,
      })
    } catch (error) {
      const aborted = controller.signal.aborted
      if (aborted) {
        // pause / cancel / close already recorded the target state
        if (!isTerminal(record.state)) {
          await this.#stopAs(id, 'host_restart')
        }
      } else {
        await this.#fail(id, error)
      }
    } finally {
      this.active.delete(id)
      this.progress.delete(id)
      this.#schedule()
    }
  }

  /** @param {string} id @param {Error} error */
  async #fail(id, error) {
    const record = this.jobs.get(id)
    if (!record || isTerminal(record.state)) return

    record.attempts += 1
    record.lastError = error?.message ?? String(error)
    record.updatedAt = this.now()

    if (record.attempts < MAX_ATTEMPTS) {
      record.state = 'queued'
      record.pauseReason = undefined
      this.log('warn', `${id} failed (attempt ${record.attempts}/${MAX_ATTEMPTS}), retrying: ${record.lastError}`)
    } else {
      record.state = 'failed'
      this.log('warn', `${id} failed permanently: ${record.lastError}`)
    }
    await this.jobs.put(id, record)
  }

  /** @param {string} id @param {'user'|'session_closed'|'host_restart'} reason */
  async #stopAs(id, reason) {
    const record = this.jobs.get(id)
    if (!record || isTerminal(record.state)) return
    const stats = this.progress.get(id)
    record.state = 'paused'
    record.pauseReason = reason
    if (stats) record.bytesCheckpoint = stats.done
    record.updatedAt = this.now()
    await this.jobs.put(id, record)
  }

  /**
   * @param {string} id
   * @param {'completed'} state
   * @param {Partial<import('./types.js').JobRecord>} patch
   */
  async #finish(id, state, patch) {
    const record = this.jobs.get(id)
    if (!record) return
    Object.assign(record, patch, { state, updatedAt: this.now() })
    delete record.pauseReason
    await this.jobs.put(id, record)
    this.log('info', `${id} ${state} (${record.finalBytes ?? record.bytesCheckpoint} bytes)`)
  }

  async #checkpointAll() {
    for (const [id] of this.active) {
      const stats = this.progress.get(id)
      const record = this.jobs.get(id)
      if (!stats || !record || record.state !== 'running') continue
      if (stats.done <= record.bytesCheckpoint) continue
      record.bytesCheckpoint = stats.done
      record.bytesTotal = stats.total > 0 ? stats.total : record.bytesTotal
      record.updatedAt = this.now()
      await this.jobs.put(id, record).catch(() => {})
    }
  }

  /** @param {import('./types.js').JobRecord} record */
  async #dropPartialFiles(record) {
    for (const file of [`${record.destPath}.part`, `${record.destPath}.aria2`]) {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  async #cancelOrphans() {
    if (!this.isOwnerAlive) {
      this.log('info', 'orphan scan skipped (no session probe wired in yet)')
      return
    }
    for (const [, record] of [...this.jobs.entries()]) {
      if (isTerminal(record.state)) continue
      if (await this.isOwnerAlive(record.ownerSession)) continue
      record.state = 'canceled'
      record.lastError = 'owner session no longer exists'
      record.updatedAt = this.now()
      await this.jobs.put(record.id, record)
      await this.#dropPartialFiles(record)
      this.log('info', `${record.id} canceled: owner session is gone`)
    }
  }

  /**
   * Cheap guard against enqueueing onto a full disk. The real file size is not
   * known yet, so this only catches the obvious case.
   * @param {string} destPath
   */
  async #assertDiskSpace(destPath) {
    const minimumFree = 512 * 1024 * 1024
    try {
      const stats = await fs.statfs(path.dirname(destPath))
      const free = Number(stats.bavail) * Number(stats.bsize)
      if (Number.isFinite(free) && free < minimumFree) {
        throw new QueueError('disk-full', `less than 512 MB free for ${path.dirname(destPath)}`)
      }
    } catch (error) {
      if (error instanceof QueueError) throw error
      /* statfs is unavailable on some platforms; do not block the enqueue */
    }
  }
}

/** @param {string} file */
async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return hash.digest('hex')
}
