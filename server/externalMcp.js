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
import { listMcpTools } from './mcpClient.js'

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
// a login link), or 'unavailable' (any other failure). The error message
// carries the login URL when present so the UI can offer a "Conectar" button.
export async function probeMcpConnection(token, connectionName) {
  try {
    await listMcpTools(externalMcpUrl(connectionName), token)
    return { status: 'connected' }
  } catch (e) {
    const msg = String(e?.message || '')
    // the Databricks proxy surfaces missing consent as an auth error, usually
    // carrying an authorize/login URL the user must visit once
    const loginUrl = (msg.match(/https?:\/\/\S+/) || [])[0] || ''
    if (/unauth|unauthenticated|401|403|consent|login|authorize/i.test(msg)) {
      return { status: 'needs_login', loginUrl, error: msg }
    }
    return { status: 'unavailable', error: msg }
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

// A Unity Catalog three-part name: catalog.schema.service.
const FQ_SERVICE_NAME = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

/**
 * Returns the connectable MCP Services for the tab: the curated system.ai.* set,
 * plus a "connect by name" candidate when `query` is itself a fully-qualified
 * service name not already in the set. No catalog listing/scan — the OBO token
 * can't list, and it isn't needed here; per-user validation happens at connect
 * time via probeMcpConnection. The set is tiny, so ranking/filtering is left to
 * the caller. `token`/`userEmail` are unused (the curated set is static).
 */
export async function searchExternalMcpConnections(token, userEmail, query, limit = 50) {
  const q = (query || '').trim()
  const items = SYSTEM_AI_MCP_SERVICES.map((s) => ({ kind: 'mcp-external', connectionName: s.name, comment: s.comment }))
  if (FQ_SERVICE_NAME.test(q) && !items.some((i) => i.connectionName === q)) {
    items.unshift({ kind: 'mcp-external', connectionName: q, comment: 'MCP Service do catálogo (conectar por nome).' })
  }
  return items.slice(0, limit)
}
