import dns from 'node:dns/promises'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { blockedAddressReason } from './a2aGuard.ts'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const USER_AGENT = 'AI-Prism-Web/1.0 (+https://github.com/pedrotramos/ai-prism)'

// One address list for every user-URL fetch (a2aGuard.ts): loopback, RFC1918,
// CGNAT, link-local/metadata, ULA, documentation, multicast and the mapped/NAT64
// forms of those. The old local list missed several reserved ranges.
interface PinnedAddress {
  address: string
  family: number
}
interface RequestOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
  method?: string
  body?: string | Buffer | null
  signal?: AbortSignal | null
}
interface WebResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}
interface ReadablePage {
  title: string
  description: string
  text: string
}

function isPrivateIp(address: string): boolean {
  const ip = address.toLowerCase()
  if (!net.isIP(ip)) return true
  return blockedAddressReason(ip) !== null
}

async function resolvePublicAddress(hostname: string): Promise<PinnedAddress> {
  // WHATWG URL keeps brackets around IPv6 literals in `hostname`.
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('host local não permitido')
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('endereço IP privado não permitido')
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }
  }
  const answers = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!answers.length || answers.some((a) => isPrivateIp(a.address))) {
    throw new Error('host resolve para endereço privado ou inválido')
  }
  return answers[0] as PinnedAddress
}

/**
 * `lookup` for http(s).request that answers with the already-checked address
 * (no second DNS query, so no rebinding). The answer is deferred to the next
 * tick on purpose: net calls connect() inside this callback, and a connect()
 * that fails synchronously (EHOSTUNREACH/ENETUNREACH) destroys the socket and
 * queues its 'error'. Answering inside the call queues that 'error' ahead of
 * the tick where http attaches its socket listener, so it fires unhandled and
 * the process exits.
 */
type LookupCallback = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void
export function pinnedLookup(pinned: PinnedAddress) {
  return (_hostname: string, lookupOpts: { all?: boolean } | LookupCallback | undefined, cb?: LookupCallback): void => {
    if (typeof lookupOpts === 'function') {
      cb = lookupOpts
      lookupOpts = {}
    }
    const done = cb as LookupCallback
    process.nextTick(() => (lookupOpts?.all
      ? done(null, [{ address: pinned.address, family: pinned.family }])
      : done(null, pinned.address, pinned.family)))
  }
}

function requestOnce(
  url: URL,
  { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, method = 'GET', body = null, signal = null }: RequestOptions = {}
): Promise<WebResponse> {
  return new Promise(async (resolve, reject) => {
    let pinned: PinnedAddress
    try {
      pinned = await resolvePublicAddress(url.hostname)
    } catch (e) {
      reject(e)
      return
    }
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      servername: url.hostname,
      lookup: pinnedLookup(pinned),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          req.destroy(new Error(`resposta excede o limite de ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`página excedeu o timeout de ${timeoutMs}ms`), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) req.destroy(new DOMException('The operation was aborted.', 'AbortError'))
      else signal.addEventListener('abort', () => req.destroy(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
    }
    req.end(body ?? undefined)
  })
}

export async function safeGet(rawUrl: string | URL, options: RequestOptions = {}): Promise<WebResponse & { url: string }> {
  return safeRequest(rawUrl, { ...options, method: 'GET', body: null })
}

/**
 * POST sibling of safeGet (keyed search providers, server/webSearch): same
 * address pinning, private-range refusal and redirect rules. A redirect turns
 * the request into a body-less GET (303 semantics), and a credential header
 * never follows a redirect to another origin.
 */
export async function safePost(rawUrl: string | URL, body: unknown, options: RequestOptions = {}): Promise<WebResponse & { url: string }> {
  return safeRequest(rawUrl, { ...options, method: 'POST', body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}) })
}

async function safeRequest(rawUrl: string | URL, options: RequestOptions): Promise<WebResponse & { url: string }> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('URL inválida') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('apenas URLs HTTP/HTTPS são permitidas')
  url.username = ''
  url.password = ''
  let opts = options
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await requestOnce(url, opts)
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects === MAX_REDIRECTS) throw new Error('excesso de redirecionamentos')
      const nextUrl = new URL(response.headers.location, url)
      if (nextUrl.origin !== url.origin && Object.keys(opts.headers || {}).some((h) => /authorization|token|api-key/i.test(h))) {
        throw new Error('redirecionamento entre hosts com credencial não permitido')
      }
      url = nextUrl
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('redirecionamento para protocolo não permitido')
      if (opts.method !== 'GET') opts = { ...opts, method: 'GET', body: null }
      continue
    }
    return { ...response, url: url.toString() }
  }
  throw new Error('excesso de redirecionamentos')
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x'
      const n = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : all
    }
    return named[entity.toLowerCase()] ?? all
  })
}

export function htmlToReadableText(html: string): ReadablePage {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ')).trim()
  const description = decodeEntities(
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1] || ''
  ).trim()
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|canvas|noscript|template|nav|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, ' ')} (${href})`)
    .replace(/<\/(p|div|article|section|main|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  body = decodeEntities(body)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, description, text: body }
}

// Web search lives in server/webSearch/ (W2-11a); this module keeps the SSRF-
// hardened HTTP (safeGet/safePost) and the page reader behind web_fetch.

export async function fetchWebPage(
  url: string,
  { maxChars = 30_000 }: { maxChars?: number } = {}
): Promise<ReadablePage & { url: string; contentType: string; truncated: boolean }> {
  const res = await safeGet(url)
  if (res.status < 200 || res.status >= 300) throw new Error(`página respondeu HTTP ${res.status}`)
  const contentType = String(res.headers['content-type'] || '').toLowerCase()
  if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
    throw new Error(`tipo de conteúdo não suportado: ${contentType || 'desconhecido'}`)
  }
  const raw = res.body.toString('utf8')
  const parsed = contentType.includes('html') ? htmlToReadableText(raw) : { title: '', description: '', text: raw }
  const limit = Math.max(1_000, Math.min(Number(maxChars) || 30_000, 60_000))
  const truncated = parsed.text.length > limit
  return { ...parsed, text: parsed.text.slice(0, limit), url: res.url, contentType, truncated }
}
