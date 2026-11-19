// Brave Search API (keyed fallback): GET /res/v1/web/search with
// X-Subscription-Token. Key from an Apps `secret` resource (BRAVE_SEARCH_API_KEY).
import { keyedJson, result } from './keyedHttp.js'
import { webSearchError } from './errors.js'
import { clampLimit } from './mcpProviders.js'

export const id = 'brave'
export const egressHost = 'api.search.brave.com'
const FRESHNESS = new Set(['pd', 'pw', 'pm', 'py'])

export async function search(query, { limit = 5, env = process.env, fetchImpl = null, timeoutMs, signal = null, freshness } = {}) {
  const key = String(env.BRAVE_SEARCH_API_KEY || '').trim()
  if (!key) throw webSearchError('unconfigured', { provider: id })
  const count = clampLimit(limit)
  const url = new URL(`https://${egressHost}/res/v1/web/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))
  if (env.WEB_SEARCH_COUNTRY) url.searchParams.set('country', String(env.WEB_SEARCH_COUNTRY))
  if (env.WEB_SEARCH_LANG) url.searchParams.set('search_lang', String(env.WEB_SEARCH_LANG))
  if (FRESHNESS.has(freshness)) url.searchParams.set('freshness', freshness)
  const json = await keyedJson(id, url.toString(), {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    timeoutMs,
    signal,
    fetchImpl,
  })
  const rows = Array.isArray(json?.web?.results) ? json.web.results : []
  return {
    kind: 'results',
    provider: id,
    query,
    results: rows.slice(0, count).map((r) => result({ title: r.title, url: r.url, snippet: r.description, publishedAt: r.page_age })),
  }
}
