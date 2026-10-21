// MCP servers, the governed way: they come from Unity Catalog **MCP Services**
// (securable_type MCP_SERVICE), which an admin registers in the catalog. Each
// service is named `mcp-services/<catalog>.<schema>.<service>` and is invoked
// through the **Unity AI Gateway** at /ai-gateway/mcp-services/<catalog>.<schema>.<service>
// (fully-qualified three-part name, dots NOT URL-encoded — they are part of the
// path). The gateway handles auth to the backing server on-behalf-of the user
// (including, for services that wrap an OAuth connection, per-user consent —
// surfaced as a normal MCP error with a login link if the user hasn't consented
// yet). Requires the app to declare the `ai-gateway` OBO scope (invoke) plus
// `catalog.catalogs` + `catalog.schemas` (discovery), and the user to have
// EXECUTE on the service (+ USE CATALOG/SCHEMA).
//
// DISCOVERY is strictly on-behalf-of the signed-in user (never the app service
// principal) and runs in three steps — catalogs → schemas → per-schema MCP
// services — so results reflect exactly the user's own Unity Catalog visibility.
// See listAllMcpConnections below.
//
// (Antes: a descoberta listava UC HTTP connections `is_mcp_connection=true` e
// invocava via /api/2.0/mcp/external/<name>. Trocado por MCP Services do catálogo
// via Unity AI Gateway; o caminho antigo fica comentado abaixo, revivível.)
//
// CATALOG = curated system.ai.* (code) ∪ admin overrides/publications
// (app_mcp_catalog). Admins publish any MCP Service they created in the AI
// Gateway (e.g. a firecrawl_mcp in their own catalog.schema) and can hide
// curated ones; users see only the visible set and still connect OBO.
import { listMcpServer, primeMcpServerCache } from './mcpClient.js'
import { listMcpCatalogRows, appServiceToken } from './db.js'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// `serviceName` is the fully-qualified three-part name (catalog.schema.service).
export function externalMcpUrl(serviceName) {
  return `${host()}/ai-gateway/mcp-services/${serviceName}`
  // Antiga invocação via connection proxy (revivível):
  // return `${host()}/api/2.0/mcp/external/${encodeURIComponent(serviceName)}`
}

// Probes a connection's auth state on-behalf-of the user by trying to list its
// tools. Returns 'connected' (tools listed → the user's token is authorized),
// 'needs_login' (the managed proxy reports missing per-user OAuth consent, with
// a login link), 'forbidden' (no EXECUTE on the service, or it doesn't exist),
// or 'unavailable' (any other failure). The error message carries the login
// URL when present so the UI can offer a "Conectar" button.
//
// On-demand only (connect / verify / admin inspect) — never on a turn's hot
// path — so it can wait longer than the 4s tools/list bound used per turn: a
// third-party server behind the gateway (e.g. Firecrawl) may be slow to start.
const PROBE_TIMEOUT_MS = 10_000

// `cacheKey` (the user's email): a successful probe already paid for the full
// listing, so it primes the per-turn cache — the user's next chat turn gets the
// tools instantly instead of re-listing on its TTFT.
export async function probeMcpConnection(token, connectionName, { cacheKey } = {}) {
  const { tools, ...result } = await inspectMcpService(token, connectionName, { cacheKey })
  return result
}

// Same probe, but keeps the tool list — the admin preview shows what a service
// exposes before publishing it. Returns { status, loginUrl?, error?, tools }.
export async function inspectMcpService(token, connectionName, { cacheKey } = {}) {
  try {
    const url = externalMcpUrl(connectionName)
    const server = await listMcpServer(url, token, { timeoutMs: PROBE_TIMEOUT_MS })
    if (cacheKey) primeMcpServerCache(url, cacheKey, server)
    const { tools } = server
    return {
      status: 'connected',
      tools: tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 300) })),
    }
  } catch (e) {
    const msg = String(e?.message || '')
    // the Databricks proxy surfaces missing consent as an auth error, usually
    // carrying an authorize/login URL the user must visit once
    const loginUrl = (msg.match(/https?:\/\/\S+/) || [])[0] || ''
    // The gateway answers JSON-RPC -32007 "Not authorized to invoke MCP service"
    // both when the caller lacks EXECUTE and when the service doesn't exist
    // (confirmed live) — a permission problem, not a login the user can fix.
    if (!loginUrl && /-32007|not authorized to invoke|permission[_ ]denied/i.test(msg)) {
      return { status: 'forbidden', error: msg, tools: [] }
    }
    if (/unauth|unauthenticated|401|403|consent|login|authorize/i.test(msg)) {
      return { status: 'needs_login', loginUrl, error: msg, tools: [] }
    }
    return { status: 'unavailable', error: msg, tools: [] }
  }
}

// ---- Discovery: curated Databricks-managed AI Gateway MCP Services -----------
// Listing MCP Services via GET /api/2.1/unity-catalog/mcp-services requires the
// `unity-catalog` OAuth scope, which Databricks Apps CANNOT grant to an OBO user
// token (confirmed live: the forwarded token carries the literal declarable
// scopes — catalog.catalogs/schemas/tables, ai-gateway — never `unity-catalog`,
// and the endpoint 403s). An exhaustive catalogs→schemas scan sidesteps that
// scope but is infeasible (this workspace alone has 996+ catalogs). So discovery
// does NOT enumerate the catalog. Instead:
//
//   • CURATED — the standard Databricks-managed AI Gateway MCP servers live under
//     the stable `system.ai.*` namespace. We surface that known set directly:
//     no list API, no scan. Per-user availability is validated at connect time
//     (probeMcpConnection → tools/list through the gateway, OBO), so a user who
//     lacks EXECUTE simply sees "needs login / unavailable".
//   • BY NAME — any other MCP Service (e.g. a user's own catalog.schema.service)
//     is reachable by typing its fully-qualified three-part name; validated OBO
//     the same way. Covers services outside system.ai without any listing.
//
// Everything here uses only the `ai-gateway` OBO scope (invoke/probe). The
// unity-catalog LIST path stays out because it can't be granted OBO.
const SYSTEM_AI_MCP_SERVICES = [
  { name: 'system.ai.web_search', comment: 'Busca na web ao vivo (managed Databricks).' },
  { name: 'system.ai.slack', comment: 'Slack — canais e mensagens.' },
  { name: 'system.ai.gmail', comment: 'Gmail — e-mail.' },
  { name: 'system.ai.github', comment: 'GitHub — repositórios, issues e pull requests.' },
  { name: 'system.ai.google_drive', comment: 'Google Drive — arquivos e documentos.' },
  { name: 'system.ai.google_calendar', comment: 'Google Calendar — eventos e agenda.' },
  { name: 'system.ai.microsoft_365', comment: 'Microsoft 365 — e-mail, arquivos e calendário.' },
  { name: 'system.ai.atlassian', comment: 'Atlassian — Jira e Confluence.' },
  { name: 'system.ai.dbsql', comment: 'Databricks SQL — consultas em warehouses.' },
  { name: 'system.ai.sandbox', comment: 'Sandbox de execução de código.' },
]

// A Unity Catalog three-part name: catalog.schema.service. Service names can
// carry hyphens (seen live: `…agents.mcp-google-stitch`).
const FQ_SERVICE_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/**
 * Normalizes whatever an admin pastes into a three-part service name, or null:
 *   catalog.schema.service
 *   mcp-services/catalog.schema.service        (the UC securable name)
 *   https://<host>/ai-gateway/mcp-services/catalog.schema.service
 *   …/api/2.1/unity-catalog/mcp-services/catalog.schema.service
 */
export function normalizeServiceName(input) {
  let s = String(input || '').trim()
  if (!s) return null
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const m = s.match(/mcp-services\/([^/\s]+)$/)
  if (m) s = m[1]
  try {
    s = decodeURIComponent(s)
  } catch {}
  return FQ_SERVICE_NAME.test(s) ? s : null
}

const CURATED_NAMES = new Set(SYSTEM_AI_MCP_SERVICES.map((s) => s.name))
export const isCuratedMcpService = (name) => CURATED_NAMES.has(name)

/**
 * Merges the curated set with the admin rows: a row whose name is curated is an
 * override (hide / rename / re-describe); any other row is a custom publication.
 * Curated first (in code order), then custom (in publish order).
 * → [{ connectionName, displayName, comment, source, hidden }]
 */
export function buildMcpCatalog(rows, { includeHidden = false } = {}) {
  const byName = new Map((rows || []).map((r) => [r.serviceName, r]))
  const curated = SYSTEM_AI_MCP_SERVICES.map((s) => {
    const r = byName.get(s.name)
    return {
      connectionName: s.name,
      displayName: r?.displayName || '',
      comment: r?.description || s.comment,
      source: 'curated',
      hidden: !!r?.hidden,
      overridden: !!r,
    }
  })
  const custom = (rows || [])
    .filter((r) => !CURATED_NAMES.has(r.serviceName))
    .map((r) => ({
      connectionName: r.serviceName,
      displayName: r.displayName || '',
      comment: r.description || '',
      source: 'custom',
      hidden: !!r.hidden,
    }))
  const all = [...curated, ...custom]
  return includeHidden ? all : all.filter((e) => !e.hidden)
}

// The catalog is read on every MCP-tab load AND every tool-bearing turn (hidden
// enforcement), so it's cached per process; admin writes invalidate it. A DB
// failure degrades to the curated set (nothing hidden) — never blocks chat.
const CATALOG_TTL_MS = 30_000
let catalogCache = { rows: null, ts: 0 }
export function invalidateMcpCatalog() {
  catalogCache = { rows: null, ts: 0 }
}
async function catalogRows(email, token) {
  if (catalogCache.rows && Date.now() - catalogCache.ts < CATALOG_TTL_MS) return catalogCache.rows
  try {
    const rows = await listMcpCatalogRows(email, token)
    catalogCache = { rows, ts: Date.now() }
    return rows
  } catch {
    return catalogCache.rows || []
  }
}
export async function getMcpCatalog(email, token, opts) {
  return buildMcpCatalog(await catalogRows(email, token), opts)
}
export async function getHiddenMcpNames(email, token) {
  const rows = await catalogRows(email, token)
  return new Set(rows.filter((r) => r.hidden).map((r) => r.serviceName))
}

/**
 * Returns the connectable MCP Services for the user's tab: the visible catalog
 * (curated ∪ admin-published, minus hidden), plus a "connect by name" candidate
 * when `query` is itself a service name/URL not already in it (and not hidden
 * by an admin). No catalog listing/scan — the OBO token can't list; per-user
 * validation happens at connect time via probeMcpConnection.
 */
export async function searchExternalMcpConnections(token, userEmail, query, limit = 50) {
  const all = await getMcpCatalog(userEmail, token, { includeHidden: true })
  const items = all
    .filter((e) => !e.hidden)
    .map((e) => ({ kind: 'mcp-external', connectionName: e.connectionName, displayName: e.displayName, comment: e.comment }))
  const byName = normalizeServiceName(query)
  if (byName && !all.some((e) => e.connectionName === byName)) {
    items.unshift({ kind: 'mcp-external', connectionName: byName, comment: 'MCP Service do catálogo (conectar por nome).' })
  }
  return items.slice(0, limit)
}

// ---- Admin suggestions: MCP Services visible to the app's service principal --
// The list API needs the `unity-catalog` scope the OBO token can't carry, but
// the app SP's client-credentials token is `all-apis`. It only returns what the
// SP has privileges on (so in a shared metastore it's typically a subset), which
// is why this is "suggestions", never the source of truth. [] on any failure or
// when running without SP credentials (local dev).
const SP_LIST_TTL_MS = 5 * 60 * 1000
let spListCache = { items: null, ts: 0 }
export async function listMcpServicesViaSp() {
  if (spListCache.items && Date.now() - spListCache.ts < SP_LIST_TTL_MS) return spListCache.items
  const token = await appServiceToken()
  if (!token) return []
  try {
    const items = []
    let pageToken = ''
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ max_results: '100', ...(pageToken ? { page_token: pageToken } : {}) })
      const res = await fetch(`${host()}/api/2.1/unity-catalog/mcp-services?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      for (const s of d.mcp_services || []) {
        const name = normalizeServiceName(s.name)
        if (name) items.push({ connectionName: name, comment: s.comment || '' })
      }
      pageToken = d.next_page_token || ''
      if (!pageToken) break
    }
    spListCache = { items, ts: Date.now() }
    return items
  } catch (e) {
    console.warn('listMcpServicesViaSp:', e.message)
    return spListCache.items || []
  }
}
