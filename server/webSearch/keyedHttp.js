// Shared HTTP for the keyed adapters (Brave, Tavily, SearXNG): SSRF-hardened
// safeGet/safePost by default (address pinning, private ranges refused, no
// credential across a cross-origin redirect), status → WebSearchError code,
// JSON parsing. The key goes in a header and is never logged or echoed.
import { safeGet, safePost } from '../web.ts'
import { webSearchError, isAbort } from './errors.js'

export const DEFAULT_KEYED_TIMEOUT_MS = 12_000
const MAX_BYTES = 2 * 1024 * 1024

function defaultFetch(url, { method, headers, body, timeoutMs, signal }) {
  const opts = { headers, timeoutMs, signal, maxBytes: MAX_BYTES }
  return method === 'POST' ? safePost(url, body, opts) : safeGet(url, opts)
}

function retryAfterMs(headers) {
  const v = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (v == null) return null
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const at = Date.parse(String(v))
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/** One keyed request → parsed JSON; throws WebSearchError (or AbortError). */
export async function keyedJson(provider, url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_KEYED_TIMEOUT_MS, signal = null, fetchImpl = null } = {}) {
  let res
  try {
    res = await (fetchImpl || defaultFetch)(url, { method, headers, body, timeoutMs, signal })
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw e
    const timeout = e?.code === 'ETIMEDOUT' || /timeout|excedeu/i.test(String(e?.message || ''))
    throw webSearchError(timeout ? 'timeout' : 'unavailable', { provider, cause: e })
  }
  const status = Number(res?.status) || 0
  if (status === 401 || status === 403) throw webSearchError('forbidden', { provider })
  if (status === 429) throw webSearchError('quota', { provider, retryAfterMs: retryAfterMs(res.headers) })
  if (status === 408 || status === 504) throw webSearchError('timeout', { provider })
  if (status < 200 || status >= 300) throw webSearchError('unavailable', { provider })
  try {
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')
    return JSON.parse(text)
  } catch (e) {
    throw webSearchError('bad_response', { provider, cause: e })
  }
}

export const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').trim()

export function result(r) {
  const out = { title: stripTags(r.title), url: String(r.url || ''), snippet: stripTags(r.snippet) }
  if (typeof r.publishedAt === 'string' && r.publishedAt) out.publishedAt = r.publishedAt
  return out
}
