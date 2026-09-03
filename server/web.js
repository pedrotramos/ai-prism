import dns from 'node:dns/promises'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const USER_AGENT = 'AI-Prism-Web/1.0 (+https://github.com/pedrotramos/ai-prism)'

function isPrivateIp(address) {
  const ip = address.toLowerCase()
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (!net.isIPv6(ip)) return true
  if (ip === '::' || ip === '::1') return true
  if (ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip)) return true
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? isPrivateIp(mapped[1]) : false
}

async function resolvePublicAddress(hostname) {
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
  return answers[0]
}

function requestOnce(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise(async (resolve, reject) => {
    let pinned
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
      method: 'GET',
      servername: url.hostname,
      lookup: (_hostname, lookupOpts, cb) => lookupOpts?.all
        ? cb(null, [{ address: pinned.address, family: pinned.family }])
        : cb(null, pinned.address, pinned.family),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      const chunks = []
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`página excedeu o timeout de ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })
}

export async function safeGet(rawUrl, options = {}) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error('URL inválida') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('apenas URLs HTTP/HTTPS são permitidas')
  url.username = ''
  url.password = ''
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await requestOnce(url, options)
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects === MAX_REDIRECTS) throw new Error('excesso de redirecionamentos')
      const nextUrl = new URL(response.headers.location, url)
      if (nextUrl.origin !== url.origin && Object.keys(options.headers || {}).some((h) => /authorization|token|api-key/i.test(h))) {
        throw new Error('redirecionamento entre hosts com credencial não permitido')
      }
      url = nextUrl
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('redirecionamento para protocolo não permitido')
      continue
    }
    return { ...response, url: url.toString() }
  }
  throw new Error('excesso de redirecionamentos')
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x'
      const n = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : all
    }
    return named[entity.toLowerCase()] ?? all
  })
}

export function htmlToReadableText(html) {
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

export function webSearchConfigured() {
  if (process.env.WEB_SEARCH_DISABLED === '1') return false
  return !!(process.env.BRAVE_SEARCH_API_KEY || process.env.SEARXNG_URL || process.env.WEB_SEARCH_CONNECTION)
}

export async function searchWeb(query, { limit = 5 } = {}) {
  const count = Math.max(1, Math.min(Number(limit) || 5, 10))
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(count))
    const res = await safeGet(url.toString(), { headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY } })
    if (res.status !== 200) throw new Error(`Brave Search respondeu HTTP ${res.status}`)
    const json = JSON.parse(res.body.toString('utf8'))
    return (json.web?.results || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.description || '' }))
  }
  if (process.env.SEARXNG_URL) {
    const url = new URL('/search', process.env.SEARXNG_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    const res = await safeGet(url.toString())
    if (res.status !== 200) throw new Error(`SearXNG respondeu HTTP ${res.status}`)
    const json = JSON.parse(res.body.toString('utf8'))
    return (json.results || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }))
  }
  throw new Error('nenhum provedor nativo de busca foi configurado')
}

export async function fetchWebPage(url, { maxChars = 30_000 } = {}) {
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
