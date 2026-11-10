/**
 * Mirror expansion for well-known hosts.
 *
 * Pure functions only: no network, no state. The point is to turn one URL into
 * a small ordered list so the transport can fall back when the origin is slow or
 * blocked — the original URL always stays first.
 *
 * What this deliberately does NOT do: prove that a mirror serves the same bytes.
 * A third-party mirror can return an older build, an HTML error page, or worse.
 * Only `expectSha256` can prove that, and it is checked after the download. The
 * mitigation here is the cooldown in `queue.js`: a host that fails twice stops
 * being tried for a while.
 */

/** @typedef {{ from: string, to: string, rule: string }} MirrorApplication */

const RULES = [
  {
    name: 'huggingface',
    test: (u) => u.hostname === 'huggingface.co',
    rewrite: (u) => {
      const out = new URL(u.href)
      out.hostname = 'hf-mirror.com'
      return out.href
    },
  },
  {
    name: 'github-release',
    test: (u) => u.hostname === 'github.com' && /\/releases\/download\//.test(u.pathname),
    rewrite: (u) => `https://ghproxy.net/${u.href}`,
  },
  {
    name: 'raw-githubusercontent',
    test: (u) => u.hostname === 'raw.githubusercontent.com',
    rewrite: (u) => {
      const out = new URL(u.href)
      out.hostname = 'raw.gitmirror.com'
      return out.href
    },
  },
  {
    name: 'pythonhosted',
    test: (u) => u.hostname === 'files.pythonhosted.org',
    rewrite: (u) => {
      const out = new URL(u.href)
      out.hostname = 'pypi.tuna.tsinghua.edu.cn'
      return out.href
    },
  },
]

/** Hosts we already treat as mirrors; expanding them again would recurse. */
const ALREADY_MIRROR = new Set(['hf-mirror.com', 'ghproxy.net', 'raw.gitmirror.com', 'pypi.tuna.tsinghua.edu.cn'])

/**
 * @param {string[]} urls
 * @returns {{ urls: string[], applied: MirrorApplication[] }}
 */
export function expandMirrors(urls) {
  const out = []
  const seen = new Set()
  /** @type {MirrorApplication[]} */
  const applied = []

  const push = (url) => {
    if (seen.has(url)) return
    seen.add(url)
    out.push(url)
  }

  for (const url of urls) {
    push(url)

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (ALREADY_MIRROR.has(parsed.hostname)) continue

    for (const rule of RULES) {
      if (!rule.test(parsed)) continue
      const mirror = rule.rewrite(parsed)
      if (seen.has(mirror)) continue
      push(mirror)
      applied.push({ from: url, to: mirror, rule: rule.name })
      break
    }
  }

  return { urls: out, applied }
}

/** Hostname of a URL, or `undefined` when it does not parse. */
export function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}
