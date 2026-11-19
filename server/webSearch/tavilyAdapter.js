// Tavily Search API (keyed fallback): POST /search with a bearer key
// (TAVILY_API_KEY from an Apps `secret` resource).
import { keyedJson, result } from './keyedHttp.js'
import { webSearchError } from './errors.js'
import { clampLimit } from './mcpProviders.js'

export const id = 'tavily'
export const egressHost = 'api.tavily.com'

export async function search(query, { limit = 5, env = process.env, fetchImpl = null, timeoutMs, signal = null } = {}) {
  const key = String(env.TAVILY_API_KEY || '').trim()
  if (!key) throw webSearchError('unconfigured', { provider: id })
  const max = clampLimit(limit)
  const body = JSON.stringify({ query, max_results: max })
  const json = await keyedJson(id, `https://${egressHost}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), Accept: 'application/json' },
    body,
    timeoutMs,
    signal,
    fetchImpl,
  })
  const rows = Array.isArray(json?.results) ? json.results : []
  return {
    kind: 'results',
    provider: id,
    query,
    results: rows.slice(0, max).map((r) => result({ title: r.title, url: r.url, snippet: r.content, publishedAt: r.published_date })),
  }
}
