/**
 * Custom HTTP request headers for a download job.
 *
 * Why this exists (v1.3): some CDNs refuse a bare GET. Bilibili's media CDN
 * answers 403 unless the request carries `Referer: https://www.bilibili.com`;
 * private endpoints want `Cookie`; some hosts sniff `User-Agent`. Without a way
 * to send headers, a whole class of direct links is undownloadable no matter how
 * many mirrors are offered.
 *
 * What this module owns:
 *   · validation — a bad header must fail at enqueue time, not mid-transfer
 *   · the aria2 shape — `aria2.addUri` wants `["Name: Value", ...]`, not an object
 *   · redaction — values may be cookies or tokens, so output lists names only
 *
 * SPEC §11.3.
 */

/** RFC 7230 token: what a header name may legally contain. */
const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Headers the transfer layer already owns, or that would let a caller break it.
 * Rejecting these is not paranoia: a user-supplied `Range` silently corrupts
 * resume, and `Host`/`Content-Length` desync aria2's accounting.
 */
const RESERVED = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'content-encoding',
  'range',
  'accept-encoding',
])

/** Upper bounds, so one job cannot smuggle an unbounded blob into the store. */
const MAX_HEADERS = 32
const MAX_NAME_LEN = 64
const MAX_VALUE_LEN = 4096

export class HeaderError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'HeaderError'
    this.code = 'header-invalid'
  }
}

/**
 * Validate and copy a caller-supplied header map.
 *
 * @param {unknown} input `{ "Referer": "https://www.bilibili.com" }`
 * @returns {Record<string, string>} a fresh plain object, empty when `input` is empty
 * @throws {HeaderError} on anything the transport could not send faithfully
 */
export function normalizeHeaders(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HeaderError('headers must be an object of name/value strings')
  }

  const entries = Object.entries(input)
  if (entries.length === 0) return {}
  if (entries.length > MAX_HEADERS) {
    throw new HeaderError(`too many headers (${entries.length}); at most ${MAX_HEADERS} are supported`)
  }

  /** @type {Record<string, string>} */
  const out = {}
  const seen = new Set()

  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (!name) throw new HeaderError('header name must not be empty')
    if (name.length > MAX_NAME_LEN) {
      throw new HeaderError(`header name too long: ${name.slice(0, 32)}…`)
    }
    if (!NAME_RE.test(name)) {
      throw new HeaderError(`invalid header name: ${JSON.stringify(name)}`)
    }

    const lower = name.toLowerCase()
    if (RESERVED.has(lower)) {
      throw new HeaderError(
        `header ${name} is managed by the downloader and cannot be set per job`,
      )
    }
    if (seen.has(lower)) {
      throw new HeaderError(`duplicate header: ${name} (names are case-insensitive)`)
    }
    seen.add(lower)

    if (typeof rawValue !== 'string') {
      throw new HeaderError(`header ${name} must have a string value`)
    }
    // \r\n would let a value forge extra header lines; other control characters
    // are either illegal on the wire or mangled by a proxy.
    if (/[\r\n]/.test(rawValue)) {
      throw new HeaderError(`header ${name} contains a line break`)
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(rawValue)) {
      throw new HeaderError(`header ${name} contains a control character`)
    }
    if (rawValue.length > MAX_VALUE_LEN) {
      throw new HeaderError(`header ${name} value too long (${rawValue.length} > ${MAX_VALUE_LEN})`)
    }

    out[name] = rawValue
  }

  return out
}

/**
 * aria2's JSON-RPC takes headers as a flat list of `"Name: Value"` strings and
 * sends each one with `--header`. An empty list must stay absent, not `[]`.
 * @param {Record<string, string> | undefined} headers
 * @returns {string[] | undefined}
 */
export function toAria2Headers(headers) {
  if (!headers) return undefined
  const list = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  return list.length > 0 ? list : undefined
}

/**
 * The names alone, for anything a human or a model will read.
 * Values never leave the transfer layer — they may be cookies or tokens.
 * @param {Record<string, string> | undefined} headers
 * @returns {string[] | undefined}
 */
export function headerNames(headers) {
  if (!headers) return undefined
  const names = Object.keys(headers)
  return names.length > 0 ? names : undefined
}
