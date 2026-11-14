import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expandMirrors, hostOf } from './mirrors.js'
import { headerNames, normalizeHeaders } from './headers.js'
import { formatJobId, isTerminal, parseJobId } from './types.js'

/** How many times one job may fail before it is parked as `failed`. */
export const MAX_ATTEMPTS = 3

/** Safe default for `download_cleanup`. */
export const DEFAULT_SCOPE = 'allWithoutFiles'

export const CLEANUP_SCOPES = ['records', 'cache', 'allWithoutFiles', 'all']

/** Free space always kept in reserve, on top of what queued jobs will consume. */
const MIN_FREE_BYTES = 512 * 1024 * 1024

/** Assumed size of a queued job whose total is not known yet. */
const UNKNOWN_SIZE_RESERVE = 256 * 1024 * 1024

/** A mirror host that fails this many times in a row is skipped for COOLDOWN_MS. */
const MIRROR_FAIL_THRESHOLD = 2
const MIRROR_COOLDOWN_MS = 10 * 60 * 1000

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

/**
 * Comparison key for a destination path. Windows folds case and accepts both
 * separators, so `D:\A\b.bin` and `d:/a/B.bin` are the same file there.
 * @param {string} destPath
 */
function destKeyOf(destPath) {
  const resolved = path.resolve(destPath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** @param {string} file */
async function fileExists(file) {
  try {
    const info = await fs.stat(file)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
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
    /** Session served last, so the next pass starts with a different one. */
    this.lastServed = undefined

    /** @type {{ errors: number, lastError?: string, lastAt?: number }} */
    this.storage = { errors: 0 }
    /** @type {Map<string, { fails: number, cooldownUntil: number }>} */
    this.mirrorHealth = new Map()
  }

  // ---------------------------------------------------------------- lifecycle

  /** Reconcile persisted state with reality. Call once before serving. */
  async recover() {
    const resumable = []

    for (const [, record] of this.jobs.entries()) {
      if (record.state === 'running') {
        record.state = 'paused'
        record.pauseReason = 'host_restart'
        record.updatedAt = this.now()
        await this.jobs.put(record.id, record)
        resumable.push(record)
      } else if (record.state === 'paused' && record.pauseReason === 'host_restart') {
        // A previous shutdown may persist the pause before the process exits; such a
        // record still deserves the same resume treatment as a freshly paused one.
        resumable.push(record)
      }
    }

    if (resumable.length > 0) {
      this.log('info', `${resumable.length} job(s) interrupted by a restart -> paused(host_restart)`)
    }

    if (this.config.autoResumeOnHostRestart) {
      for (const record of resumable) {
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
   * @param {{ urls: string[], destPath: string, expectSha256?: string, expectedBytes?: number, headers?: Record<string, string> }} spec
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

    // Bad headers must fail here, at enqueue time, not halfway through a
    // transfer with three mirrors already tried.
    let requestHeaders
    try {
      requestHeaders = normalizeHeaders(spec.headers)
    } catch (error) {
      throw new QueueError(error.code ?? 'header-invalid', error.message)
    }

    const expanded = expandMirrors(spec.urls)
    const destPath = path.resolve(spec.destPath)
    const key = destKeyOf(destPath)

    // Two jobs writing the same path is a conflict no matter which URL each one
    // uses: aria2 would fight over the same .aria2 control file. Dedupe on the
    // destination, not on the URL — one file can legitimately have many URLs.
    const sameDest = [...this.jobs.entries()].map(([, record]) => record).filter((record) => destKeyOf(record.destPath) === key)

    const active = sameDest.find((record) => !isTerminal(record.state))
    if (active) {
      if (active.urls[0] === expanded.urls[0]) {
        this.log('info', `${active.id} reused by ${caller.session.slice(0, 8)} (same destination and source)`)
        return { ...this.#view(active), deduplicated: true }
      }
      throw new QueueError(
        'dest-in-use',
        `${destPath} is already being downloaded as ${active.id} from ${active.urls[0]}; cancel it first or choose another destination`,
      )
    }

    // A finished job for the same file is what the caller wants far more often
    // than a second download. Only reuse it while the file is still on disk —
    // a deleted file must be fetched again.
    const finished = sameDest.find((record) => record.state === 'completed' && record.urls[0] === expanded.urls[0])
    if (finished && (await fileExists(finished.destPath))) {
      this.log('info', `${finished.id} reused by ${caller.session.slice(0, 8)} (already downloaded)`)
      return { ...this.#view(finished), deduplicated: true }
    }

    await this.#assertDestWritable(destPath)
    await this.#assertDiskSpace(destPath, spec.expectedBytes)

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
      urls: expanded.urls,
      mirrors: expanded.applied.length > 0 ? expanded.applied : undefined,
      destPath,
      // Persisted so a resume after a DSH restart still sends them: a signed
      // URL is worthless without its Referer. Already validated above.
      headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
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
      mirrors: this.#mirrorView(record),
      // Names only. A header value may be a session cookie or an API token, and
      // this view is what every session and every model gets to read.
      requestHeaders: headerNames(record.headers),
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

  /** Storage-write and mirror health, surfaced through `download_status`. */
  health() {
    const mirrors = this.mirrorStatus()
    return compact({
      storage: this.storage.errors > 0 ? { ...this.storage } : { errors: 0 },
      mirrorHealth: mirrors.length > 0 ? mirrors : undefined,
    })
  }

  /**
   * Candidates were recorded at enqueue time; the transport only learns which of
   * them actually proved to serve the same bytes once the transfer starts.
   * @param {import('./types.js').JobRecord} record
   */
  #mirrorView(record) {
    if (!record.mirrors) return undefined
    const report = this.transport?.mirrorReports?.get(record.urls[0])
    return {
      candidates: record.mirrors,
      verified: report?.verified ?? [],
      rejected: report?.rejected ?? [],
    }
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

    if (queued.length === 0) return

    // One session hogging every slot starves the others. Only enforce a cap
    // when at least two sessions are actually competing: a lone session keeps
    // the full concurrency it would get anyway.
    const sessionKeyOf = (record) => `${record.ownerWorkspace}::${record.ownerSession}`
    const sessions = new Set(queued.map(sessionKeyOf))
    const cap = sessions.size >= 2 ? Math.max(1, Math.floor(this.config.maxConcurrentJobs / 2)) : Infinity

    /** @type {Map<string, number>} */
    const running = new Map()
    for (const [id] of this.active) {
      const record = this.jobs.get(id)
      if (!record) continue
      const key = sessionKeyOf(record)
      running.set(key, (running.get(key) ?? 0) + 1)
    }

    /** @type {Map<string, import('./types.js').JobRecord[]>} */
    const bySession = new Map()
    for (const record of queued) {
      const key = sessionKeyOf(record)
      const list = bySession.get(key)
      if (list) list.push(record)
      else bySession.set(key, [record])
    }

    // Start each pass after the session that was served last, otherwise the
    // first session in iteration order wins every tie and round-robin is a lie.
    const order = [...bySession.keys()]
    const startAt = this.lastServed && order.includes(this.lastServed) ? (order.indexOf(this.lastServed) + 1) % order.length : 0
    const rotated = [...order.slice(startAt), ...order.slice(0, startAt)]

    let progressed = true
    while (progressed && this.active.size < this.config.maxConcurrentJobs) {
      progressed = false
      for (const key of rotated) {
        if (this.active.size >= this.config.maxConcurrentJobs) break
        const list = bySession.get(key)
        if (!list || list.length === 0) continue
        if ((running.get(key) ?? 0) >= cap) continue
        const record = list.shift()
        if (this.active.has(record.id)) continue
        running.set(key, (running.get(key) ?? 0) + 1)
        this.lastServed = key
        void this.#run(record)
        progressed = true
      }
    }
  }

  /** @param {import('./types.js').JobRecord} record */
  async #run(record) {
    const id = record.id
    const controller = new AbortController()
    this.active.set(id, { controller, startedAt: this.now() })

    record.state = 'running'
    record.updatedAt = this.now()
    await this.#persist(id, record)

    const stats = { done: record.bytesCheckpoint, total: record.bytesTotal, speed: 0, lastDone: record.bytesCheckpoint, lastAt: this.now() }
    this.progress.set(id, stats)

    const urls = this.#orderUrls(record.urls)

    try {
      const result = await this.transport.transfer({
        urls,
        destPath: record.destPath,
        headers: record.headers,
        connectionsCap: this.config.connectionsPerJob,
        speedLimitKbps: this.config.speedLimitKbps,
        bytesDone: record.bytesCheckpoint,
        signal: controller.signal,
        onUrlResult: (url, ok) => {
          if (ok) this.noteUrlSuccess(url)
          else this.noteUrlFailure(url)
        },
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
        // pause / cancel / close already recorded the target state. Only park it
        // here when nobody else transitioned the job — a resume that landed
        // while this transfer was unwinding must not be undone.
        if (record.state === 'running') {
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
    await this.#persist(id, record)
  }

  /** @param {string} id @param {'user'|'session_closed'|'host_restart'} reason */
  async #stopAs(id, reason) {
    const record = this.jobs.get(id)
    if (!record || isTerminal(record.state)) return
    // Only an in-flight job may be stopped. A pause already parked it, and a
    // resume may have re-queued it while the aborted transfer was still
    // unwinding — overwriting that would leave the job stuck in `paused`.
    if (record.state !== 'running' && record.state !== 'queued') return
    const stats = this.progress.get(id)
    record.state = 'paused'
    record.pauseReason = reason
    if (stats) record.bytesCheckpoint = stats.done
    record.updatedAt = this.now()
    await this.#persist(id, record)
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
    await this.#persist(id, record)
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
      try {
        await this.#persist(id, record)
      } catch (error) {
        // A failed checkpoint means the next resume restarts from a stale
        // offset, which corrupts the file. Report it instead of swallowing it.
        this.#noteStorageFailure(id, error)
      }
    }
  }

  /** @param {string} id @param {unknown} error */
  #noteStorageFailure(id, error) {
    const message = error instanceof Error ? error.message : String(error)
    this.storage.errors += 1
    this.storage.lastError = `${id}: ${message}`
    this.storage.lastAt = this.now()
    if (this.storage.errors === 3) {
      this.log('error', `checkpoint writes are failing (${message}); resume offsets may be stale`)
    }
  }

  /**
   * Persist a lifecycle transition. Unlike the user-facing mutations, these run
   * on the scheduler and during shutdown: a broken storage must not turn into an
   * unhandled rejection that takes the whole plugin down with it.
   * @param {string} id @param {import('./types.js').JobRecord} record
   */
  async #persist(id, record) {
    try {
      await this.jobs.put(id, record)
      return true
    } catch (error) {
      this.#noteStorageFailure(id, error)
      return false
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
      await this.#persist(record.id, record)
      await this.#dropPartialFiles(record)
      this.log('info', `${record.id} canceled: owner session is gone`)
    }
  }

  /**
   * Refuse a destination whose directory we cannot write to, before the download
   * starts. A sandbox can make a path readable but not writable; discovering that
   * at the first byte wastes the whole queue slot.
   * @param {string} destPath
   */
  async #assertDestWritable(destPath) {
    let dir = path.dirname(destPath)
    // Walk up to the nearest directory that exists: an absent leaf is fine,
    // it gets created at transfer time.
    for (;;) {
      try {
        await fs.access(dir, fs.constants?.W_OK ?? 2)
        return
      } catch (error) {
        const code = error?.code
        if (code === 'ENOENT') {
          const parent = path.dirname(dir)
          if (parent === dir) return
          dir = parent
          continue
        }
        if (code === 'EACCES' || code === 'EPERM') {
          throw new QueueError('permission-denied', `cannot write to ${path.dirname(destPath)} (${code})`)
        }
        // Anything else (e.g. an exotic filesystem) is not a reason to block.
        return
      }
    }
  }

  /**
   * Cheap guard against enqueueing onto a full disk. Sums what already-queued
   * jobs are expected to consume, so twenty small enqueues cannot add up to a
   * full disk one "looks fine" at a time.
   * @param {string} destPath
   * @param {number} [expectedBytes]
   */
  async #assertDiskSpace(destPath, expectedBytes) {
    const committed = [...this.jobs.entries()]
      .map(([, record]) => record)
      .filter((record) => !isTerminal(record.state))
      .reduce((sum, record) => {
        const remaining = record.bytesTotal > 0 ? record.bytesTotal - record.bytesCheckpoint : UNKNOWN_SIZE_RESERVE
        return sum + Math.max(0, remaining)
      }, 0)

    const reserve = Number.isFinite(expectedBytes) && expectedBytes > 0 ? expectedBytes : UNKNOWN_SIZE_RESERVE
    const needed = MIN_FREE_BYTES + committed + reserve

    try {
      const stats = await fs.statfs(path.dirname(destPath))
      const free = Number(stats.bavail) * Number(stats.bsize)
      if (Number.isFinite(free) && free < needed) {
        const shortfall = needed - free
        throw new QueueError(
          'disk-full',
          `need ${Math.ceil(needed / 1048576)} MB free for ${path.dirname(destPath)} ` +
            `(512 MB reserve + ${Math.ceil(committed / 1048576)} MB queued + ${Math.ceil(reserve / 1048576)} MB this job), ` +
            `only ${Math.floor(free / 1048576)} MB available, short by ${Math.ceil(shortfall / 1048576)} MB`,
        )
      }
    } catch (error) {
      if (error instanceof QueueError) throw error
      /* statfs is unavailable on some platforms; do not block the enqueue */
    }
  }

  // ------------------------------------------------------------------- mirrors

  /**
   * Mark a URL host as failed. Two consecutive failures park it for a while so a
   * dead mirror is not retried on every job; the cooldown is in memory only, so
   * a restart clears it rather than turning a blip into a permanent ban.
   * @param {string} url
   */
  noteUrlFailure(url) {
    const host = hostOf(url)
    if (!host) return
    const entry = this.mirrorHealth.get(host) ?? { fails: 0, cooldownUntil: 0 }
    entry.fails += 1
    if (entry.fails >= MIRROR_FAIL_THRESHOLD) {
      entry.cooldownUntil = this.now() + MIRROR_COOLDOWN_MS
      this.log('warn', `mirror ${host} cooling down for ${MIRROR_COOLDOWN_MS / 60000} min after ${entry.fails} failures`)
    }
    this.mirrorHealth.set(host, entry)
  }

  /** @param {string} url */
  noteUrlSuccess(url) {
    const host = hostOf(url)
    if (!host) return
    this.mirrorHealth.delete(host)
  }

  /** Hosts currently in cooldown, for `download_status`. */
  mirrorStatus() {
    const out = []
    for (const [host, entry] of this.mirrorHealth) {
      if (entry.cooldownUntil > this.now()) {
        out.push({ host, fails: entry.fails, cooldownUntil: entry.cooldownUntil })
      }
    }
    return out
  }

  /** Reorder URLs so cooling hosts are tried last. @param {string[]} urls */
  #orderUrls(urls) {
    const stamp = this.now()
    const warm = []
    const cold = []
    for (const url of urls) {
      const host = hostOf(url)
      const entry = host ? this.mirrorHealth.get(host) : undefined
      if (entry && entry.cooldownUntil > stamp) cold.push(url)
      else warm.push(url)
    }
    return cold.length === 0 ? urls : [...warm, ...cold]
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
