// SearXNG (keyed-tier fallback): a CUSTOMER-HOSTED instance with the JSON
// format enabled, at SEARXNG_URL. Never embedded or replicated (design
// §SearXNG). Reached through safeGet like any public URL, so an instance on a
// private address is refused.
import { keyedJson, result } from './keyedHttp.ts'
import { webSearchError } from './errors.ts'
import { clampLimit } from './mcpProviders.ts'
import type { WebSearchResult } from './mcpProviders.ts'
import type { WebSearchDeps } from './deps.ts'

export const id = 'searxng'

export function searxngBase(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = String(env.SEARXNG_URL || '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    if (!u.pathname.endsWith('/')) u.pathname += '/'
    return u
  } catch {
    return null
  }
}

export async function search(
  query: string,
  { limit = 5, env = process.env, fetchImpl = null, timeoutMs, signal = null }: { limit?: number; env?: NodeJS.ProcessEnv; fetchImpl?: WebSearchDeps['fetchImpl']; timeoutMs?: number; signal?: AbortSignal | null } = {}
): Promise<WebSearchResult> {
  const base = searxngBase(env)
  if (!base) throw webSearchError('unconfigured', { provider: id })
  const count = clampLimit(limit)
  const url = new URL('search', base)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  const json = await keyedJson(id, url.toString(), { headers: { Accept: 'application/json' }, timeoutMs, signal, fetchImpl })
  const rows: Record<string, unknown>[] = Array.isArray(json?.results) ? json.results : []
  return {
    kind: 'results',
    provider: id,
    query,
    results: rows.slice(0, count).map((r) => result({ title: r.title, url: r.url, snippet: r.content, publishedAt: r.publishedDate })),
  }
}
