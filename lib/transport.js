import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { sameResource } from './mirrors.js'
import { toAria2Headers } from './headers.js'

/**
 * Transport layer. Two channels: an aria2c JSON-RPC daemon when one is
 * available, and a plain Node fetch stream otherwise.
 *
 * The queue never talks to aria2 directly; it calls {@link Transport#transfer}.
 *
 * @typedef {object} TransferOptions
 * @property {string[]} urls            candidate sources, tried in order
 * @property {string} destPath          absolute final file path
 * @property {number} [connections]     aria2 split for a large file, default 16
 * @property {number} [connectionsCap]  upper bound when the size picks the count
 * @property {boolean} [preferDirect]   skip aria2 for this job
 * @property {number} [speedLimitKbps]  0 or absent means unlimited
 * @property {string} [proxy]           e.g. http://127.0.0.1:65532
 * @property {number} [bytesDone]       resume hint for the direct channel
 * @property {Record<string, string>} [headers]  custom HTTP headers sent with
 *                                      every attempt (probe, aria2, direct)
 * @property {(url: string, ok: boolean) => void} [onUrlResult]
 * @property {(done: number, total: number) => void} [onProgress]
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} TransferResult
 * @property {number} bytes
 * @property {number} total             -1 when the server never reported one
 */

/** Below this, aria2's setup cost exceeds any segmentation gain. */
export const SMALL_FILE_BYTES = 1 * 1024 * 1024
/** From this size up, extra connections pay for themselves. */
export const LARGE_FILE_BYTES = 8 * 1024 * 1024

/**
 * Decide the channel and the number of connections from the file size.
 *
 * Segmentation only helps once `min-split-size=1M` can produce several pieces,
 * and too many connections on a per-IP-throttled host hurts rather than helps.
 * @param {number} sizeBytes
 * @param {number} [cap]
 * @returns {{ connections: number, direct: boolean }}
 */
export function planTransfer(sizeBytes, cap = 16) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { connections: Math.min(cap, 8), direct: false }
  if (sizeBytes < SMALL_FILE_BYTES) return { connections: 1, direct: true }
  if (sizeBytes < LARGE_FILE_BYTES) return { connections: Math.min(4, cap), direct: false }
  return { connections: cap, direct: false }
}


const IS_WIN = process.platform === 'win32'
const ARIA2_BIN = IS_WIN ? 'aria2c.exe' : 'aria2c'

/** Absolute locations worth checking beyond PATH. */
function extraCandidates() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? ''
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [
      path.join(pf, 'aria2', ARIA2_BIN),
      path.join(pf86, 'aria2', ARIA2_BIN),
      path.join(local, 'Programs', 'Motrix', 'resources', 'aria2', ARIA2_BIN),
      path.join(local, 'Motrix', 'resources', 'aria2', ARIA2_BIN),
    ]
  }
  return ['/usr/bin/aria2c', '/usr/local/bin/aria2c', '/opt/homebrew/bin/aria2c']
}

async function isExecutable(file) {
  try {
    await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** @param {string} name */
async function findInPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate an aria2c binary.
 * Order: explicit config, environment, PATH, well-known install locations.
 *
 * @param {string} [configured]
 * @returns {Promise<string | undefined>}
 */
export async function findAria2(configured) {
  if (configured) {
    try {
      await fs.access(configured, fs.constants.X_OK)
      return configured
    } catch {
      /* fall through */
    }
  }

  for (const key of ['DLS_ARIA2C_PATH', 'MT_ARIA2C_PATH', 'ARIA2C_PATH']) {
    const value = process.env[key]
    if (value) {
      try {
        await fs.access(value, fs.constants.X_OK)
        return value
      } catch {
        /* fall through */
      }
    }
  }

  const fromPath = await findInPath(ARIA2_BIN)
  if (fromPath) return fromPath

  for (const candidate of extraCandidates()) {
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/** Minimal JSON-RPC client for the aria2 daemon. */
class Aria2Rpc {
  /** @param {number} port @param {string} secret */
  constructor(port, secret) {
    this.port = port
    this.secret = secret
    this.url = `http://127.0.0.1:${port}/jsonrpc`
    this.nextId = 1
  }

  /** @param {string} method @param {unknown[]} params */
  async call(method, params = []) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params: [`token:${this.secret}`, ...params],
    })
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const payload = await response.json()
    if (payload.error) {
      throw new Error(`aria2 ${method}: ${payload.error.message}`)
    }
    return payload.result
  }

  /** Poll until the daemon answers, or give up. */
  async waitReady(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.call('aria2.getVersion')
        return true
      } catch {
        await sleep(120)
      }
    }
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The transport facade. One instance per plugin; the daemon is shared by every
 * concurrent job and torn down on dispose.
 */
export class Transport {
  /**
   * @param {{ aria2Path?: string, aria2Port?: number, connectionsPerJob?: number,
   *           speedLimitKbps?: number, proxy?: string }} config
   * @param {(level: string, message: string) => void} [log]
   */
  constructor(config = {}, log = () => {}) {
    this.config = config
    this.log = log
    this.mode = 'direct'
    this.aria2 = undefined
    this.rpc = undefined
    /** @type {Map<string, { verified: string[], rejected: { url: string, reason: string }[] }>} */
    this.mirrorReports = new Map()
  }

  /** Detect aria2 and start the daemon if possible. Never throws. */
  async init() {
    const binary = await findAria2(this.config.aria2Path)
    if (!binary) {
      this.log('info', 'aria2c not found, using the single-stream fallback')
      return
    }

    const port = this.config.aria2Port ?? 16801
    const secret = randomBytes(12).toString('hex')
    const args = [
      '--enable-rpc',
      `--rpc-listen-port=${port}`,
      '--rpc-listen-all=false',
      `--rpc-secret=${secret}`,
      '--continue=true',
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
      '--log-level=warn',
      '--console-log-level=warn',
      '--summary-interval=0',
      '--disable-ipv6=true',
    ]
    if (this.config.proxy) args.push(`--all-proxy=${this.config.proxy}`)

    try {
      this.aria2 = spawn(binary, args, { windowsHide: true, stdio: 'ignore' })
      this.aria2.unref()
      this.aria2.on('exit', () => {
        this.aria2 = undefined
        this.mode = 'direct'
      })

      const rpc = new Aria2Rpc(port, secret)
      if (await rpc.waitReady()) {
        this.rpc = rpc
        this.mode = 'aria2'
        this.log('info', `aria2c ready on port ${port} (${binary})`)
      } else {
        this.log('warn', 'aria2c started but never answered; falling back')
        this.aria2?.kill()
        this.aria2 = undefined
      }
    } catch (error) {
      this.log('warn', `aria2c failed to start: ${error.message}`)
      this.mode = 'direct'
    }
  }

  /** @param {TransferOptions} options @returns {Promise<TransferResult>} */
  async transfer(options) {
    const headers = options.headers
    const origin = await this.#probeHead(options.urls[0], options.signal, headers)
    const plan = planTransfer(origin.length, options.connectionsCap ?? options.connections ?? this.config.connectionsPerJob ?? 16)
    const connections = options.connections ?? plan.connections

    const urls = await this.#verifiedUrls(options.urls, origin, options.signal, headers)
    const useAria2 = this.mode === 'aria2' && this.rpc && !options.preferDirect && !plan.direct

    if (useAria2) {
      try {
        const result = await this.#transferAria2({ ...options, urls, connections })
        options.onUrlResult?.(urls[0], true)
        return result
      } catch (error) {
        if (options.signal?.aborted) throw error
        this.log('warn', `aria2 transfer failed, retrying single-stream: ${error.message}`)
      }
    }
    return this.#transferDirect({ ...options, urls })
  }

  /**
   * Keep only the mirrors that can be shown to serve the same bytes as the
   * origin. A mirror is a third party: it may hold an older build or answer with
   * an HTML error page, and `sha256` is the only proof of content. Length plus
   * ETag catches the common mistakes; the reasoning is documented in SPEC §11.2.
   * @param {string[]} urls
   * @param {{ length: number, etag?: string }} origin
   * @param {AbortSignal} [signal]
   * @param {Record<string, string>} [headers]
   */
  async #verifiedUrls(urls, origin, signal, headers) {
    if (urls.length <= 1) return urls

    const accepted = [urls[0]]
    /** @type {{ url: string, reason: string }[]} */
    const rejected = []

    for (const mirror of urls.slice(1)) {
      const head = await this.#probeHead(mirror, signal, headers)
      const verdict = sameResource(origin, head)
      if (verdict.ok) {
        accepted.push(mirror)
        if (verdict.reason === 'origin-unknown') {
          this.log('warn', `mirror ${mirror} kept unverified: the origin did not report a length`)
        }
      } else {
        rejected.push({ url: mirror, reason: verdict.reason ?? 'unverified' })
        this.log('warn', `mirror ${mirror} rejected: ${verdict.reason}`)
      }
    }

    this.mirrorReports.set(urls[0], { verified: accepted.slice(1), rejected })
    return accepted
  }

  /**
   * Best-effort HEAD: the length and validator used for sizing and for proving a
   * mirror matches. A failure is not an error — unknown size only means the
   * planner stays conservative.
   * @param {string} url
   * @param {AbortSignal} [signal]
   * @param {Record<string, string>} [headers] needed for CDNs that 403 a bare HEAD
   * @returns {Promise<{ length: number, etag?: string }>}
   */
  async #probeHead(url, signal, headers) {
    if (!url) return { length: -1 }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    timer.unref?.()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetch(url, { method: 'HEAD', headers, signal: controller.signal })
      if (!response.ok) return { length: -1 }
      const length = Number(response.headers.get('content-length') ?? 0)
      const etag = response.headers.get('etag') ?? undefined
      return { length: Number.isFinite(length) && length > 0 ? length : -1, etag }
    } catch {
      return { length: -1 }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** @param {TransferOptions} options */
  async #transferAria2({ urls, destPath, connections, speedLimitKbps, headers, onProgress, signal }) {
    const rpc = this.rpc
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    const options = {
      dir: path.dirname(destPath),
      out: path.basename(destPath),
      split: String(connections ?? this.config.connectionsPerJob ?? 16),
      'max-connection-per-server': String(connections ?? this.config.connectionsPerJob ?? 16),
      'min-split-size': '1M',
      continue: 'true',
      'auto-file-renaming': 'false',
      'allow-overwrite': 'true',
    }
    const limit = speedLimitKbps ?? this.config.speedLimitKbps ?? 0
    if (limit > 0) options['max-download-limit'] = `${limit}K`
    // aria2 wants one "Name: Value" string per `--header`; it applies them to
    // every URI of the download, which is what a mirror group needs.
    const headerList = toAria2Headers(headers)
    if (headerList) options.header = headerList

    const gid = await rpc.call('aria2.addUri', [urls, options])

    let aborted = false
    const onAbort = () => {
      aborted = true
      void rpc.call('aria2.remove', [gid]).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for (;;) {
        if (aborted) throw new Error('canceled')
        const status = await rpc.call('aria2.tellStatus', [
          gid,
          ['status', 'totalLength', 'completedLength', 'errorMessage'],
        ])
        const done = Number(status.completedLength ?? 0)
        const total = status.totalLength === '0' ? -1 : Number(status.totalLength)
        onProgress?.(done, total)

        if (status.status === 'complete') return { bytes: done, total }
        if (status.status === 'error' || status.status === 'removed') {
          throw new Error(status.errorMessage || `aria2 status ${status.status}`)
        }
        if (status.status === 'paused') return { bytes: done, total }
        await sleep(400)
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** @param {TransferOptions} options */
  async #transferDirect({ urls, destPath, bytesDone = 0, headers, onProgress, onUrlResult, signal }) {
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    const partPath = `${destPath}.part`
    let lastError

    for (const url of urls) {
      try {
        let offset = bytesDone
        try {
          offset = (await fs.stat(partPath)).size
        } catch {
          offset = bytesDone
        }

        // Custom headers first, then `range` — resume owns that one, and
        // `normalizeHeaders` already rejects a caller-supplied Range.
        const requestHeaders = { ...headers }
        if (offset > 0) requestHeaders.range = `bytes=${offset}-`

        const response = await fetch(url, { headers: requestHeaders, signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const ranged = response.status === 206
        const start = ranged ? offset : 0
        const declared = Number(response.headers.get('content-length') ?? 0)
        const total = declared > 0 ? declared + start : -1

        const sink = createWriteStream(partPath, { flags: ranged ? 'a' : 'w' })
        let written = start
        let lastTick = 0

        const source = Readable.fromWeb(response.body)
        source.on('data', (chunk) => {
          written += chunk.length
          const now = Date.now()
          if (now - lastTick > 400) {
            lastTick = now
            onProgress?.(written, total)
          }
        })

        await pipeline(source, sink)
        onProgress?.(written, total)
        await fs.rename(partPath, destPath)
        onUrlResult?.(url, true)
        return { bytes: written, total }
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error
        lastError = error
        onUrlResult?.(url, false)
      }
    }
    throw lastError ?? new Error('no source available')
  }

  /** Stop the daemon. Safe to call twice. */
  async dispose() {
    try {
      await this.rpc?.call('aria2.shutdown')
    } catch {
      /* daemon already gone */
    }
    this.rpc = undefined
    this.mode = 'direct'
    try {
      this.aria2?.kill()
    } catch {
      /* ignore */
    }
    this.aria2 = undefined
  }
}

/** Exposed for tests: resolve a candidate without starting anything. */
export const _internal = { findInPath, extraCandidates, Aria2Rpc, sleep, homeDir: os.homedir }
