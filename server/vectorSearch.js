import { execStatement } from './warehouse.js'
import { identityKey } from './requestIdentity.ts'

// Vector Search Indexes as a tool: discovery + text-query execution, governed
// by the caller's own Unity Catalog grants (on-behalf-of, same as everything
// else — no separate connection/consent flow needed, unlike external MCP
// servers). Only DELTA_SYNC indexes with a Databricks-managed embedding model
// (`embedding_source_columns`) support plain-text `query_text` search — the
// alternative shape (`embedding_vector_columns`, "self-managed embeddings
// already computed") requires the caller to already have a query vector,
// which a natural-language tool can't produce, so those are excluded from
// discovery entirely.
function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// The vector-search endpoint/index listing APIs are org-rate-limited fairly
// aggressively (confirmed live: a couple dozen concurrent requests trips
// "organization has exceeded the rate limit"), so every call here retries a
// 429 with backoff — but bounded by an optional shared deadline, so a
// sustained rate-limit window degrades to partial results instead of making
// discovery hang for minutes.
async function apiFetch(path, opts, token, { attempt = 0, deadline } = {}) {
  const res = await fetch(`${host()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
  })
  if (res.status === 429 && attempt < 4 && (!deadline || Date.now() < deadline)) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    return apiFetch(path, opts, token, { attempt: attempt + 1, deadline })
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    throw new Error(`Vector Search API: ${msg}`)
  }
  return json
}

// Vector Search indexes aren't listable by name directly (they're not in
// system.information_schema — confirmed live) — indexes only enumerate per
// endpoint, so discovery means listing every endpoint the user can see, then
// listing indexes per endpoint. This specific dev workspace has an unusually
// large number of endpoints (shared multi-tenant sandbox, not representative
// of a real customer workspace), so the per-endpoint fan-out is capped and
// bounded-concurrency (kept low — see the rate-limit note above), then
// cached briefly per user, same spirit as the Genie Spaces cache in genie.js.
const INDEXES_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_ENDPOINTS = 150
const CONCURRENCY = 5
// Overall time budget for the whole discovery crawl — under sustained org
// rate-limiting (seen live) the naive per-request backoff can add up to
// minutes; past this deadline, stop issuing new requests and return
// whatever was found so far rather than hang the search.
const DISCOVERY_DEADLINE_MS = 20000
const indexesCache = new Map() // userEmail -> { ts, indexes }

async function mapWithConcurrency(items, limit, deadline, fn) {
  const results = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = Date.now() < deadline ? await fn(items[idx]) : null
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function listAllQueryableIndexes(token) {
  const deadline = Date.now() + DISCOVERY_DEADLINE_MS
  const { endpoints } = await apiFetch('/api/2.0/vector-search/endpoints', { method: 'GET' }, token, { deadline })
  const candidates = (endpoints || []).filter((e) => e.num_indexes > 0).slice(0, MAX_ENDPOINTS)

  const perEndpoint = await mapWithConcurrency(candidates, CONCURRENCY, deadline, async (ep) => {
    try {
      const qs = new URLSearchParams({ endpoint_name: ep.name })
      const { vector_indexes } = await apiFetch(
        `/api/2.0/vector-search/indexes?${qs}`,
        { method: 'GET' },
        token,
        { deadline }
      )
      // the list response doesn't include delta_sync_index_spec — just enough
      // to cheaply drop DIRECT_ACCESS indexes before the detail fetch below
      return (vector_indexes || []).filter((i) => i.index_type === 'DELTA_SYNC')
    } catch {
      return [] // endpoint listed but its indexes aren't readable right now — skip, don't fail the whole search
    }
  })
  const deltaSyncIndexes = perEndpoint.filter(Boolean).flat()

  // Only the single-index describe endpoint returns delta_sync_index_spec
  // (embedding_source_columns vs. embedding_vector_columns), so each
  // DELTA_SYNC candidate needs one more call to know if it's text-queryable.
  const detailed = await mapWithConcurrency(deltaSyncIndexes, CONCURRENCY, deadline, async (idx) => {
    try {
      return await apiFetch(
        `/api/2.0/vector-search/indexes/${encodeURIComponent(idx.name)}`,
        { method: 'GET' },
        token,
        { deadline }
      )
    } catch {
      return null
    }
  })

  const results = []
  for (const idx of detailed) {
    const spec = idx?.delta_sync_index_spec
    const embeddingSourceCols = spec?.embedding_source_columns
    if (!embeddingSourceCols?.length) continue
    results.push({
      kind: 'vector-search',
      indexName: idx.name,
      endpointName: idx.endpoint_name,
      sourceTable: spec.source_table || '',
      embeddingColumns: (spec.embedding_vector_columns || []).map((c) => c.name),
    })
  }
  return results
}

/** Search Vector Search indexes the user can query by text, by name substring. */
export async function searchVectorIndexes(token, userEmail, query, limit = 20) {
  let cached = indexesCache.get(userEmail)
  if (!cached || Date.now() - cached.ts > INDEXES_CACHE_TTL_MS) {
    cached = { ts: Date.now(), indexes: await listAllQueryableIndexes(token) }
    indexesCache.set(userEmail, cached)
  }
  const q = (query || '').trim().toLowerCase()
  const matches = q ? cached.indexes.filter((i) => i.indexName.toLowerCase().includes(q)) : cached.indexes
  return matches.slice(0, limit)
}

// Columns to return from a query: every column on the source table except
// the embedding vector column(s) — those are opaque float arrays, useless to
// a model. Cached per (user, index) (rarely changes) so repeated tool calls in
// the same chat don't re-describe the table every time. Per user because the
// ref (sourceTable included) comes from the client's enabledTools: a cache
// keyed by index alone let one user plant wrong columns for everyone.
const COLUMNS_CACHE_TTL_MS = 10 * 60 * 1000
const columnsCache = new Map() // `${identityKey}\u0000${indexName}` -> { ts, columns }

/** `a.b.c` → `` `a`.`b`.`c` `` with embedded backticks doubled (Databricks SQL quoting). */
export function quoteTableName(name) {
  return String(name)
    .split('.')
    .map((part) => `\`${part.replace(/`/g, '``')}\``)
    .join('.')
}

export async function describeVectorIndexColumns(token, ref, { userEmail, exec = execStatement } = {}) {
  const key = userEmail ? `${identityKey(userEmail)}\u0000${ref.indexName}` : null
  const cached = key && columnsCache.get(key)
  if (cached && Date.now() - cached.ts < COLUMNS_CACHE_TTL_MS) return cached.columns

  const { rows } = await exec(token, `DESCRIBE TABLE ${quoteTableName(ref.sourceTable)}`)
  const exclude = new Set(ref.embeddingColumns || [])
  const columns = rows.map((r) => r[0]).filter((name) => name && !exclude.has(name) && !name.startsWith('#'))

  if (key) columnsCache.set(key, { ts: Date.now(), columns })
  return columns
}

/** Runs a text query against a Vector Search index and formats matches as markdown. */
export async function queryVectorIndex(token, indexName, columns, queryText, numResults) {
  const body = { query_text: queryText, columns, num_results: numResults }
  const json = await apiFetch(
    `/api/2.0/vector-search/indexes/${encodeURIComponent(indexName)}/query`,
    { method: 'POST', body: JSON.stringify(body) },
    token
  )
  const cols = (json.manifest?.columns || []).map((c) => c.name)
  const rows = json.result?.data_array || []
  if (!rows.length) return '(nenhum resultado encontrado)'

  return rows
    .map((r, i) => {
      const fields = cols.map((c, ci) => `**${c}**: ${r[ci] ?? ''}`).join('\n')
      return `### Resultado ${i + 1}\n${fields}`
    })
    .join('\n\n')
}
