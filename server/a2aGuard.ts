// Outbound HTTP for A2A: every request to a remote agent, its Agent Card or an
// OAuth identity provider goes through guardedFetch, never through the global
// fetch. The guards live here because the @a2a-js/sdk card resolver and
// transports do no host/scheme/redirect validation of their own:
//
//   • scheme: https only; http is accepted only for loopback hosts and only with
//     A2A_ALLOW_INSECURE_LOCAL=1 (local dev and the offline QA);
//   • destination: the URL must satisfy the caller's `allowUrl` predicate (the
//     auth strategy decides which hosts may see its credential — see a2aAuth.js);
//   • addresses: literal IPs and every DNS answer are checked at connect time
//     (custom `lookup`); RFC1918 is allowed only for a proven workspace host,
//     while loopback, link-local, metadata, ULA and other reserved ranges stay
//     blocked;
//   • redirects are never followed (a 3xx is an error), requests and streams time
//     out, and response bodies are capped;
//   • headers are rebuilt from a short allowlist and the credential is attached
//     here, so nothing else (cookies, forwarded headers) leaks to the remote.
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import { Readable, Transform } from 'node:stream'

type Env = Record<string, string | undefined>

interface HostPattern {
  text: string
  re: RegExp
  port: number | null
  path: string | null
}
interface A2aConfig {
  allowInsecureLocal: boolean
  workspaceHost: string
  apps: { workspaceId: string | null; suffix: string | null }
  databricksPatterns: HostPattern[]
  ignoredAllowlist: string[]
  requestTimeoutMs: number
  streamTimeoutMs: number
  cardTimeoutMs: number
  maxResponseBytes: number
  maxStreamBytes: number
  maxCardBytes: number
}
interface AddressOptions {
  allowLoopback?: boolean
  allowPrivate?: boolean
}
interface LookupAddr {
  address: string
  family: number
}
type LookupCallback = (err: Error | null, address?: string | LookupAddr[], family?: number) => void
// dns.lookup-shaped; `addresses` may also be a bare string (a non-`all` resolver).
type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true; family: number },
  cb: (err: Error | null, addresses?: LookupAddr[] | string) => void
) => void
// Mutable record the guarded fetch fills so callers can classify failures.
interface FetchState {
  lastStatus?: number
  authStatus?: number
  frontDoor?: boolean
  insufficientScope?: boolean
}
// What the guarded fetch reads from a request init (a subset of RequestInit
// plus the module's own timeoutMs / maxBytes).
interface GuardedInit {
  method?: string
  headers?: unknown
  body?: unknown
  signal?: AbortSignal | null
  timeoutMs?: number
  maxBytes?: number
}
interface GuardedFetchOptions {
  token?: string | null
  authorization?: string | null
  requireToken?: boolean
  allowUrl: (url: URL) => boolean
  frontDoor?: { idToken?: string | null } | null
  route?: ((url: URL) => { token: string | null; frontDoorIdToken: string | null }) | null
  cfg?: A2aConfig
  state?: FetchState
  resolver?: Resolver
}

export class A2aError extends Error {
  // code: no_token | blocked_url | invalid_card | unsupported_auth | auth_required |
  //       no_access | unavailable | timeout | canceled | oauth_disabled | oauth_failed
  code: string
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'A2aError'
    this.code = code
    Object.assign(this, extra)
  }
}

const DEFAULTS = {
  requestTimeoutMs: 60_000,
  streamTimeoutMs: 300_000,
  cardTimeoutMs: 10_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxStreamBytes: 8 * 1024 * 1024,
  maxCardBytes: 256 * 1024,
}

function intEnv(env: Env, name: string, fallback: number): number {
  const n = Number.parseInt(env[name] || '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function hostOf(value: string | null | undefined): string {
  if (!value) return ''
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// Databricks App URLs are https://<app-name>-<workspace-id>.<cloud>.databricksapps.com.
// The workspace id comes from the Apps runtime (DATABRICKS_WORKSPACE_ID) or from
// this app's own URL. Without either, no *.databricksapps.com host qualifies:
// the OBO token must never go to another workspace's App on a guess. Explicit
// `databricks:` entries in A2A_ALLOWED_HOSTS stay the only opt-in.
function workspaceAppsSuffix(env: Env): { workspaceId: string | null; suffix: string | null } {
  const wsid = String(env.DATABRICKS_WORKSPACE_ID || '').trim()
  if (/^\d+$/.test(wsid)) return { workspaceId: wsid, suffix: null }
  const own = hostOf(env.DATABRICKS_APP_URL)
  const m = own.match(/^[a-z0-9-]+?-(\d{6,})(\.[a-z0-9.-]+\.databricksapps\.com)$/)
  if (m) return { workspaceId: m[1] as string, suffix: m[2] as string }
  return { workspaceId: null, suffix: null }
}

/** Reads the A2A settings from the environment; cheap, so callers read it per use. */
export function a2aConfig(env: Env = process.env): A2aConfig {
  const databricksPatterns: (HostPattern | null)[] = []
  const ignoredAllowlist: string[] = []
  for (const raw of String(env.A2A_ALLOWED_HOSTS || '').split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    const m = entry.match(/^databricks:(.+)$/i)
    if (m) databricksPatterns.push(parsePattern((m[1] as string).trim()))
    else ignoredAllowlist.push(entry)
  }
  return {
    allowInsecureLocal: env.A2A_ALLOW_INSECURE_LOCAL === '1',
    workspaceHost: hostOf(env.DATABRICKS_HOST),
    apps: workspaceAppsSuffix(env),
    databricksPatterns: databricksPatterns.filter((p): p is HostPattern => p !== null),
    ignoredAllowlist,
    requestTimeoutMs: intEnv(env, 'A2A_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs),
    streamTimeoutMs: intEnv(env, 'A2A_STREAM_TIMEOUT_MS', DEFAULTS.streamTimeoutMs),
    cardTimeoutMs: DEFAULTS.cardTimeoutMs,
    maxResponseBytes: intEnv(env, 'A2A_MAX_RESPONSE_BYTES', DEFAULTS.maxResponseBytes),
    maxStreamBytes: DEFAULTS.maxStreamBytes,
    maxCardBytes: DEFAULTS.maxCardBytes,
  }
}

// ---- host patterns ------------------------------------------------------------
// `host[:port][/path-prefix]`. A leading `*.` matches one or more labels, any
// other `*` stays inside one label (`*-aiplatform.googleapis.com`). Without a
// port the pattern only matches the scheme's default port; a path prefix matches
// on segment boundaries. Host and port are case-insensitive; the path keeps its
// case, as URL paths do (`/reasoningEngines/…` on Vertex AI).
export function parsePattern(text: unknown): HostPattern | null {
  const m = String(text || '').trim().match(/^([A-Za-z0-9*.\-[\]:]+?)(?::(\d+))?(\/[^\s]*)?$/)
  if (!m || !m[1]) return null
  let host = m[1].toLowerCase()
  let port = m[2] ? Number(m[2]) : null
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const anySub = host.startsWith('*.')
  const rest = anySub ? host.slice(2) : host
  const label = rest
    .split('.')
    .map((part) => part.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]*'))
    .join('\\.')
  const re = new RegExp(`^${anySub ? '(?:[a-z0-9-]+\\.)+' : ''}${label}$`)
  const path = m[3] ? m[3].replace(/\/+$/, '') || '/' : null
  return { text: String(text).trim(), re, port, path }
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'http:' ? 80 : 443
}

// Under a path prefix the URL's path may only carry RFC 3986 pchar without `%`
// and `;`: no escape (%2F, %5C, %2E, %25…) that a hop could decode into a
// separator or dot segment after the match, and no matrix parameters. Every
// segment is non-empty and none is `.` or `..`; only the last may be empty
// (trailing slash).
const PREFIXED_PATH_CHARS = /^[A-Za-z0-9\-._~:@!$&'()*+,=/]*$/

function isPlainPath(pathname: string): boolean {
  if (!PREFIXED_PATH_CHARS.test(pathname)) return false
  const segments = pathname.split('/').slice(1)
  return segments.every((seg, i) => (seg === '' ? i === segments.length - 1 : seg !== '.' && seg !== '..'))
}

// A host label (RFC 1123: letters, digits and inner hyphens, at most 63
// characters) where at most one `*` stands for part of the label.
const PATTERN_LABEL = /^(?=[A-Za-z0-9*-]{1,63}$)(?!.*\*.*\*)(?![-])(?!.*-$)[A-Za-z0-9*-]+$/

/**
 * Whether `text` is a well-formed provider host pattern: hostname labels (a
 * leading `*.` for any subdomains, otherwise at most one `*` per label), an
 * optional port 1-65535 and an optional path prefix starting with `/`. No
 * scheme, userinfo, query, fragment, whitespace, escape or dot segment.
 */
export function isStrictHostPattern(text: unknown): boolean {
  if (typeof text !== 'string' || !text || /[\s@?#%\\]/.test(text)) return false
  const slash = text.indexOf('/')
  const authority = slash < 0 ? text : text.slice(0, slash)
  const path = slash < 0 ? null : text.slice(slash)
  const m = authority.match(/^([^:]+)(?::([^:]*))?$/)
  if (!m) return false
  const host = m[1] as string
  const port = m[2]
  if (port !== undefined && !(/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535)) return false
  const labels = (host.startsWith('*.') ? host.slice(2) : host).split('.')
  if (host.length > 253 || !labels.every((l) => PATTERN_LABEL.test(l))) return false
  if (path !== null && !(PREFIXED_PATH_CHARS.test(path) && isPlainPath(path))) return false
  return true
}

/**
 * Whether `url` (WHATWG-serialized: the same URL object the guarded fetch sends,
 * pathname + search) is inside `pattern`. URLs with userinfo never match.
 */
export function urlMatchesPattern(url: string | URL, pattern: HostPattern | null | undefined): boolean {
  if (!pattern) return false
  const u = url instanceof URL ? url : new URL(url)
  if (u.username || u.password) return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!pattern.re.test(host)) return false
  const port = effectivePort(u)
  if (pattern.port != null ? port !== pattern.port : port !== (u.protocol === 'http:' ? 80 : 443)) return false
  if (pattern.path && pattern.path !== '/') {
    const p = u.pathname
    if (p !== pattern.path && !p.startsWith(`${pattern.path}/`)) return false
    if (!isPlainPath(p)) return false
  }
  return true
}

function belongsToWorkspaceHostname(host: string, cfg: A2aConfig): boolean {
  if (cfg.workspaceHost && host === cfg.workspaceHost) return true
  if (!host.endsWith('.databricksapps.com')) return false
  const { workspaceId, suffix } = cfg.apps
  if (suffix) return host.endsWith(suffix) && host.slice(0, -suffix.length).endsWith(`-${workspaceId}`)
  if (workspaceId) return (host.split('.')[0] as string).endsWith(`-${workspaceId}`)
  return false
}

function isProvenWorkspaceHostname(hostname: unknown, cfg: A2aConfig): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (belongsToWorkspaceHostname(host, cfg)) return true
  return cfg.databricksPatterns.some((pattern) => pattern.re.test(host))
}

/** True when the URL belongs to this Databricks workspace (OBO-eligible). */
export function isDatabricksUrl(url: string | URL, cfg: A2aConfig = a2aConfig()): boolean {
  const u = url instanceof URL ? url : new URL(url)
  if (u.protocol !== 'https:' && !(cfg.allowInsecureLocal && isLoopbackHost(u.hostname))) return false
  if (cfg.databricksPatterns.some((p) => urlMatchesPattern(u, p))) return true
  if (u.protocol !== 'https:' || effectivePort(u) !== 443) return false
  const host = u.hostname.toLowerCase()
  return belongsToWorkspaceHostname(host, cfg)
}

// ---- address classification ---------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}
function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
const V4_PRIVATE: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]

// Eight 16-bit words. A valid IPv6 address (callers check net.isIPv6 first)
// always expands to exactly eight; the tuple type only records that.
type V6Words = [number, number, number, number, number, number, number, number]

function expandV6(ip: string): V6Words {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] as string
  // trailing dotted IPv4 (::ffff:1.2.3.4)
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = ipv4ToInt(v4[1] as string)
    s = s.slice(0, -(v4[1] as string).length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : []
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : []
  return [...h, ...fill, ...t].map((x) => Number.parseInt(x || '0', 16)) as V6Words
}

function v4FromWords(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

export function isLoopbackHost(host: unknown): boolean {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (net.isIPv4(h)) return inV4(h, '127.0.0.0', 8)
  if (net.isIPv6(h)) return isLoopbackAddress(h)
  return false
}

function isLoopbackAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return inV4(ip, '127.0.0.0', 8)
  const w = expandV6(ip)
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return inV4(v4FromWords(w[6], w[7]), '127.0.0.0', 8)
  return false
}

/** Why an address must not be contacted, or null when it is a public address. */
export function blockedAddressReason(ip: string, { allowLoopback = false, allowPrivate = false }: AddressOptions = {}): string | null {
  if (net.isIPv4(ip)) {
    if (inV4(ip, '127.0.0.0', 8)) return allowLoopback ? null : 'loopback'
    if (ip === '255.255.255.255') return 'broadcast'
    for (const [base, bits] of V4_PRIVATE) {
      if (inV4(ip, base, bits)) return allowPrivate ? null : `reserved ${base}/${bits}`
    }
    for (const [base, bits] of V4_BLOCKED) if (inV4(ip, base, bits)) return `reserved ${base}/${bits}`
    return null
  }
  if (!net.isIPv6(ip)) return 'not an IP address'
  const w = expandV6(ip)
  if (w.every((x) => x === 0)) return 'unspecified'
  const mapped = w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff
  if (mapped) {
    const reason = blockedAddressReason(v4FromWords(w[6], w[7]), { allowLoopback, allowPrivate })
    return reason ? `${reason} via ::ffff` : null
  }
  // Prefixes that reach an embedded IPv4 through a relay or translator on the
  // path (defense in depth: unlikely on Databricks Apps, cheap to refuse).
  // SIIT ::ffff:0:0/96 (RFC 6145) and 6to4 2002::/16 (RFC 3056) carry the IPv4
  // in fixed words, so it is classified like the ::ffff form.
  const siit = w.slice(0, 4).every((x) => x === 0) && w[4] === 0xffff && w[5] === 0
  if (siit) {
    const reason = blockedAddressReason(v4FromWords(w[6], w[7]), { allowLoopback, allowPrivate })
    return reason ? `${reason} via ::ffff:0:0/96` : null
  }
  if (w[0] === 0x2002) {
    const reason = blockedAddressReason(v4FromWords(w[1], w[2]), { allowLoopback, allowPrivate })
    return reason ? `${reason} via 6to4` : null
  }
  // Teredo (RFC 4380) obfuscates the client IPv4, and in NAT64 local-use
  // (RFC 8215) the IPv4 position depends on the prefix length: refuse both.
  if (w[0] === 0x2001 && w[1] === 0) return 'reserved Teredo 2001::/32'
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return 'reserved NAT64 local-use 64:ff9b:1::/48'
  if (isLoopbackAddress(ip)) return allowLoopback ? null : 'loopback'
  if (w.slice(0, 6).every((x) => x === 0)) return 'reserved IPv4-compatible IPv6'
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return 'reserved NAT64 64:ff9b::/96'
  if ((w[0] & 0xfe00) === 0xfc00) return 'unique-local'
  if ((w[0] & 0xffc0) === 0xfe80) return 'link-local'
  if ((w[0] & 0xffc0) === 0xfec0) return 'site-local'
  if ((w[0] & 0xff00) === 0xff00) return 'multicast'
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'documentation'
  if (w[0] === 0x0100 && w.slice(1, 4).every((x) => x === 0)) return 'discard'
  return null
}

const BLOCKED_HOSTNAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data'])

/**
 * Static URL checks (no network): parses, enforces the scheme rule, refuses
 * credentials in the URL, metadata hostnames and blocked literal IPs. Returns the
 * parsed URL; throws A2aError('blocked_url').
 */
export function checkUrl(input: string | URL, cfg: A2aConfig = a2aConfig()): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input))
  } catch {
    throw new A2aError('blocked_url', 'URL inválida.')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = isLoopbackHost(host)
  if (url.protocol === 'http:') {
    if (!(cfg.allowInsecureLocal && loopback)) throw new A2aError('blocked_url', `Apenas https é permitido (${url.host}).`)
  } else if (url.protocol !== 'https:') {
    throw new A2aError('blocked_url', `Esquema não permitido: ${url.protocol}`)
  }
  if (url.username || url.password) throw new A2aError('blocked_url', 'URLs com credenciais embutidas não são permitidas.')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal')) {
    throw new A2aError('blocked_url', `Host bloqueado: ${host}`)
  }
  if (loopback && !cfg.allowInsecureLocal) throw new A2aError('blocked_url', `Host de loopback bloqueado: ${host}`)
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host, {
      allowLoopback: cfg.allowInsecureLocal,
      allowPrivate: isProvenWorkspaceHostname(host, cfg),
    })
    if (reason) throw new A2aError('blocked_url', `Endereço bloqueado (${reason}): ${host}`)
  }
  return url
}

/**
 * dns.lookup replacement used at connect time: resolves every address and fails
 * when ANY of them is blocked, so a hostname cannot mix a public and a private
 * answer. `resolver` is injectable for the offline QA.
 */
export function guardedLookup(cfg: A2aConfig = a2aConfig(), resolver: Resolver = dns.lookup as Resolver) {
  return (hostname: string, options: { all?: boolean; family?: number } | LookupCallback | undefined, callback?: LookupCallback): void => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const done = callback as LookupCallback
    resolver(hostname, { all: true, verbatim: true, family: options?.family || 0 }, (err, answer) => {
      if (err) return done(err)
      const addresses = answer as LookupAddr[] | string // always set when there is no error
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }]
      if (!list.length) return done(new A2aError('blocked_url', `Sem endereço para ${hostname}`))
      for (const a of list) {
        const reason = blockedAddressReason(a.address, {
          allowLoopback: cfg.allowInsecureLocal && isLoopbackHost(hostname),
          allowPrivate: isProvenWorkspaceHostname(hostname, cfg),
        })
        if (reason) return done(new A2aError('blocked_url', `Endereço bloqueado (${reason}) para ${hostname}`))
      }
      if (options?.all) return done(null, list)
      done(null, (list[0] as LookupAddr).address, (list[0] as LookupAddr).family)
    })
  }
}

// ---- secrets in text ------------------------------------------------------------

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\bdapi[0-9a-f]{32}(-\d+)?\b/gi,
  /\bdose[0-9a-f]{32}\b/gi,
  /\bya29\.[A-Za-z0-9._-]{10,}/g,
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,
]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Removes the given secrets and anything token-shaped from text bound for the
 * model, UI or logs. Every non-empty secret is removed exactly, whatever its
 * length (one pass, longest first, so a short secret never cuts a longer one).
 */
export function redactSecrets(text: unknown, secrets: unknown[] = []): string {
  let out = String(text ?? '')
  const exact = [...new Set(secrets.filter((s) => s != null && s !== '').map(String))].sort((a, b) => b.length - a.length)
  if (exact.length) out = out.replace(new RegExp(exact.map(escapeRegExp).join('|'), 'g'), '[redacted]')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

// ---- guarded fetch --------------------------------------------------------------

const FORWARDED_HEADERS = new Set(['content-type', 'accept', 'a2a-version', 'a2a-extensions', 'x-a2a-extensions'])
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 32 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 32 }),
}

function headerEntries(headers: unknown): [unknown, unknown][] {
  if (!headers) return []
  if (typeof (headers as { forEach?: unknown }).forEach === 'function' && !Array.isArray(headers)) {
    const out: [unknown, unknown][] = []
    ;(headers as Headers).forEach((v: unknown, k: unknown) => out.push([k, v]))
    return out
  }
  if (Array.isArray(headers)) return headers as [unknown, unknown][]
  return Object.entries(headers as object)
}

function capBytes(limit: number, onExceeded: () => Error): Transform {
  let seen = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length
      if (seen > limit) return cb(onExceeded())
      cb(null, chunk)
    },
  })
}

// A 403 from a front door that checks identity before the agent (Cloud Run IAM):
// no A2A/JSON body and no bearer challenge — the agent itself answers JSON-RPC,
// and a 401 of its own comes with WWW-Authenticate: Bearer.
const INSUFFICIENT_SCOPE = /insufficient_scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i
const REFUSAL_SNIFF_BYTES = 64 * 1024

function frontDoorRefusal(status: number, resHeaders: http.IncomingHttpHeaders): boolean {
  if (status !== 403) return false
  const contentType = String(resHeaders['content-type'] || '')
  const challenge = String(resHeaders['www-authenticate'] || '')
  return !/json/i.test(contentType) && !/\bbearer\b/i.test(challenge)
}

/**
 * Returns a fetch-compatible function bound to ONE credential:
 *   token     — the bearer to attach (null → the request carries no Authorization);
 *   authorization — a full Authorization value instead of a bearer (IdP client auth);
 *   allowUrl  — predicate every request URL must satisfy (the strategy's audience);
 *   frontDoor — { idToken } for a host behind an identity-checking front door
 *               (provider frontDoorAuth): the ID token goes in
 *               X-Serverless-Authorization, to the same allowUrl hosts only, and
 *               a 403 without an A2A body or bearer challenge is recorded as
 *               `state.frontDoor` (the front door refused, not the agent);
 *   route     — (url) → { token, frontDoorIdToken }: the credential chosen per
 *               request by its destination (a2aAuth destinationRoute); it wins
 *               over `token` / `frontDoor` and may throw to refuse the request;
 *   state     — optional object; records `lastStatus` / `authStatus` (401/403) /
 *               `frontDoor` / `insufficientScope` (a 401/403 naming an
 *               insufficient scope) so callers can classify SDK errors without
 *               parsing their messages.
 * `requireToken: true` fails closed before any request when the token is missing.
 * Redirects are never followed, so neither header can reach another host.
 */
export function createGuardedFetch({
  token = null,
  authorization = null,
  requireToken = true,
  allowUrl,
  frontDoor = null,
  route = null,
  cfg = a2aConfig(),
  state = {},
  resolver,
}: Partial<GuardedFetchOptions> = {}): (input: string | URL | { url?: string }, init?: GuardedInit) => Promise<Response> {
  if (typeof allowUrl !== 'function') throw new Error('createGuardedFetch: allowUrl is required')
  const lookup = guardedLookup(cfg, resolver)
  return async function guardedFetch(input: string | URL | { url?: string }, init: GuardedInit = {}): Promise<Response> {
    if (!route && requireToken && !token) {
      throw new A2aError('no_token', 'Sem token do usuário para chamar o agente; a chamada não foi feita.')
    }
    const url = checkUrl(typeof input === 'string' || input instanceof URL ? input : (input?.url as string | URL), cfg) // a missing url fails checkUrl's parse: 'URL inválida.'
    if (!allowUrl(url)) {
      throw new A2aError('blocked_url', `Host não autorizado para esta credencial: ${url.host}`)
    }
    let bearer = token
    let frontDoorIdToken = frontDoor?.idToken || null
    if (route) {
      ;({ token: bearer, frontDoorIdToken } = route(url))
      if (requireToken && !bearer) throw new A2aError('no_token', 'Sem token do usuário para chamar o agente; a chamada não foi feita.')
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of headerEntries(init.headers)) {
      const key = String(k).toLowerCase()
      if (FORWARDED_HEADERS.has(key)) headers[key] = String(v)
    }
    if (!headers['a2a-version']) headers['a2a-version'] = '1.0'
    headers['user-agent'] = 'ai-prism-a2a/1.0'
    if (authorization) headers.authorization = authorization
    else if (bearer) headers.authorization = `Bearer ${bearer}`
    if (frontDoorIdToken) headers['x-serverless-authorization'] = `Bearer ${frontDoorIdToken}`
    let body = init.body
    if (body instanceof URLSearchParams) {
      body = body.toString()
      headers['content-type'] ||= 'application/x-www-form-urlencoded'
    }
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new Error('guardedFetch: unsupported request body')
    }
    if (body != null) headers['content-length'] = String(Buffer.byteLength(body))

    const streaming = /text\/event-stream/i.test(headers.accept || '')
    const timeoutMs = init.timeoutMs || (streaming ? cfg.streamTimeoutMs : cfg.requestTimeoutMs)
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (init.signal) signals.push(init.signal)
    const signal = AbortSignal.any(signals)
    const maxBytes = init.maxBytes || (streaming ? cfg.maxStreamBytes : cfg.maxResponseBytes)
    const lib = url.protocol === 'https:' ? https : http

    return await new Promise((resolve, reject) => {
      const fail = (e: unknown) => {
        if (signal.aborted) {
          const reason = signal.reason as { name?: string } | undefined
          if (init.signal?.aborted) return reject(new A2aError('canceled', 'Chamada cancelada.'))
          if (reason?.name === 'TimeoutError') return reject(new A2aError('timeout', `Tempo esgotado (${Math.round(timeoutMs / 1000)}s) em ${url.host}.`))
        }
        if (e instanceof A2aError) return reject(e)
        const err = e as { code?: string; message?: string } | null | undefined
        reject(new A2aError('unavailable', `Falha de rede em ${url.host}: ${err?.code || err?.message || 'erro'}`))
      }
      if (signal.aborted) return fail(signal.reason)
      const req = lib.request(
        url,
        {
          method: init.method || 'GET',
          headers,
          agent: url.protocol === 'https:' ? agents.https : agents.http,
          lookup: lookup as unknown as net.LookupFunction, // same contract; our callback type is a looser superset
          signal,
        },
        (res) => {
          const status = res.statusCode || 0
          state.lastStatus = status
          if (status === 401 || status === 403) state.authStatus = status
          state.frontDoor = !!frontDoorIdToken && frontDoorRefusal(status, res.headers)
          if ((status === 401 || status === 403) && INSUFFICIENT_SCOPE.test(String(res.headers['www-authenticate'] || ''))) state.insufficientScope = true
          if (status < 200 || status > 599) {
            res.destroy()
            return reject(new A2aError('unavailable', `Resposta HTTP inválida (${status}) de ${url.host}.`))
          }
          if (status >= 300 && status < 400) {
            res.resume()
            return reject(new A2aError('blocked_url', `Redirecionamento bloqueado (HTTP ${status}) em ${url.host}.`))
          }
          const respHeaders = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => respHeaders.append(k, x))
            else if (v != null) respHeaders.set(k, String(v))
          }
          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy()
            return reject(new A2aError('unavailable', `Resposta grande demais de ${url.host}.`))
          }
          let webBody: ReadableStream | null = null
          if (!NULL_BODY_STATUSES.has(status) && (init.method || 'GET') !== 'HEAD') {
            const capped = res.pipe(capBytes(maxBytes, () => new A2aError('unavailable', `Resposta grande demais de ${url.host}.`)))
            res.on('error', (e) => capped.destroy(e))
            if (status === 401 || status === 403) {
              // a refusal body is small: read whole to tell an insufficient scope (Google: ACCESS_TOKEN_SCOPE_INSUFFICIENT)
              const chunks: Buffer[] = []
              let size = 0
              capped.on('data', (c) => {
                size += c.length
                if (size <= REFUSAL_SNIFF_BYTES) chunks.push(c)
              })
              capped.on('error', fail)
              capped.on('end', () => {
                const buf = Buffer.concat(chunks)
                if (INSUFFICIENT_SCOPE.test(buf.toString('utf8'))) state.insufficientScope = true
                resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : buf, { status, statusText: res.statusMessage || '', headers: respHeaders }))
              })
              return
            }
            webBody = Readable.toWeb(capped) as ReadableStream // node:stream/web type vs the global one
          } else {
            res.resume()
          }
          resolve(new Response(webBody, { status, statusText: res.statusMessage || '', headers: respHeaders }))
        }
      )
      req.on('error', fail)
      if (body != null) req.write(body)
      req.end()
    })
  }
}
