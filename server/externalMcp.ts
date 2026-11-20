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
import { listMcpServer, primeMcpServerCache } from './mcpClient.ts'
import { listMcpCatalogRows, appServiceToken } from './db.js'
import { classifyMcpService, catalogAdmits, catalogClass, MANAGED_MCP_CLASSES } from './mcpCredentials.js'
import { logger } from './log.js'

// An admin-catalog row (db.js listMcpCatalogRows, camelCase).
interface CatalogRow {
  serviceName: string
  displayName?: string
  description?: string
  hidden?: boolean
  credentialClass?: string | null
}
// One catalog entry as buildMcpCatalog returns it.
interface CatalogEntry {
  connectionName: string
  displayName: string
  comment: string
  source?: 'curated' | 'custom'
  hidden?: boolean
  overridden?: boolean
  credentialClass?: string | null
}
// `catalog` given to the admission helpers: entries, or a thunk producing them.
type CatalogInput = CatalogEntry[] | (() => CatalogEntry[] | Promise<CatalogEntry[]>) | null | undefined
interface Classification {
  credentialClass?: string
  credentialType?: string | null
  admission?: { ok: boolean; code?: string }
}
type ClassifyFn = (name: string, opts: { adminToken?: string | null }) => Promise<Classification | null | undefined>
interface Admission {
  ok: boolean
  credentialClass?: string
  code?: string
  cold?: boolean
}
interface ProbeResult {
  status: 'connected' | 'needs_login' | 'forbidden' | 'unavailable'
  tools: { name: string; description?: string }[]
  loginUrl?: string
  error?: string
}

// mcpCredentials.js is untyped JS: its `adminToken = null` default makes tsc infer
// the option as `null`, but callers pass the user's token.
const classifyService = classifyMcpService as unknown as ClassifyFn

function host(): string {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// `serviceName` is the fully-qualified three-part name (catalog.schema.service).
// It is ONE path segment: encodeURIComponent keeps [A-Za-z0-9_.-] literal (so
// every real name is unchanged) and encodes `/ ? # %`, so a name can never add
// path segments or a query on the workspace host. A bare `.` / `..` survives
// encodeURIComponent and the URL parser would resolve it (also as %2E), so its
// dots are double-encoded: the gateway sees a literal, nonexistent name and
// refuses it. No throw: the turn's tool assembly calls this on stored refs.
export function externalMcpUrl(serviceName: unknown): string {
  let segment = encodeURIComponent(String(serviceName ?? ''))
  if (segment === '.' || segment === '..') segment = segment.replace(/\./g, '%252E')
  return `${host()}/ai-gateway/mcp-services/${segment}`
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
export async function probeMcpConnection(
  token: string,
  connectionName: string,
  { cacheKey }: { cacheKey?: string } = {}
): Promise<Omit<ProbeResult, 'tools'>> {
  const { tools, ...result } = await inspectMcpService(token, connectionName, { cacheKey, classify: false })
  return result
}

// Same probe, but keeps the tool list — the admin preview shows what a service
// exposes before publishing it. Returns { status, loginUrl?, error?, tools }.
// With `classify` (default, admin-only path) it also reads the service's
// credential class from config metadata: { credentialClass, credentialType,
// admission } where admission = catalogAdmits(...) — a shared credential is
// refused by policy. The admin route spreads this result into its response.
export async function inspectMcpService(
  token: string,
  connectionName: string,
  { cacheKey, classify = true }: { cacheKey?: string; classify?: boolean } = {}
): Promise<ProbeResult & { credentialClass?: string; credentialType?: string | null; admission?: unknown }> {
  const result = await probeMcpServiceTools(token, connectionName, { cacheKey })
  if (!classify) return result
  const cls = await classifyService(connectionName, { adminToken: token }).catch(() => null)
  return {
    ...result,
    credentialClass: cls?.credentialClass || 'unverified',
    credentialType: cls?.credentialType || null,
    admission: cls?.admission || catalogAdmits('unverified'),
  }
}

async function probeMcpServiceTools(token: string, connectionName: string, { cacheKey }: { cacheKey?: string } = {}): Promise<ProbeResult> {
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
    const msg = String((e as Error | undefined)?.message || '')
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

// What /api/mcp/connections/:name accepts. Looser than FQ_SERVICE_NAME on
// purpose (rows adopted before the MCP Services migration may hold a one-part
// UC connection name, and the user must still be able to forget them), but it
// refuses everything that changes the URL shape: path separators, query and
// fragment markers, `%` (a double-encoded name), whitespace/control characters
// and dot-only segments.
const MCP_CONNECTION_NAME_MAX = 255
export function isValidMcpConnectionName(name: unknown): boolean {
  if (typeof name !== 'string' || !name || name.length > MCP_CONNECTION_NAME_MAX) return false
  if (/^\.+$/.test(name)) return false
  return !/[/\\?#%\s\u0000-\u001f\u007f]/.test(name)
}

/**
 * Normalizes whatever an admin pastes into a three-part service name, or null:
 *   catalog.schema.service
 *   mcp-services/catalog.schema.service        (the UC securable name)
 *   https://<host>/ai-gateway/mcp-services/catalog.schema.service
 *   …/api/2.1/unity-catalog/mcp-services/catalog.schema.service
 */
export function normalizeServiceName(input: unknown): string | null {
  let s = String(input || '').trim()
  if (!s) return null
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const m = s.match(/mcp-services\/([^/\s]+)$/)
  if (m) s = m[1] as string
  try {
    s = decodeURIComponent(s)
  } catch {}
  return FQ_SERVICE_NAME.test(s) ? s : null
}

const CURATED_NAMES = new Set(SYSTEM_AI_MCP_SERVICES.map((s) => s.name))
export const isCuratedMcpService = (name: string): boolean => CURATED_NAMES.has(name)

/**
 * Merges the curated set with the admin rows: a row whose name is curated is an
 * override (hide / rename / re-describe); any other row is a custom publication.
 * Curated first (in code order), then custom (in publish order).
 * → [{ connectionName, displayName, comment, source, hidden }]
 */
export function buildMcpCatalog(rows: CatalogRow[] | null | undefined, { includeHidden = false }: { includeHidden?: boolean } = {}): CatalogEntry[] {
  const byName = new Map((rows || []).map((r) => [r.serviceName, r]))
  const curated: CatalogEntry[] = SYSTEM_AI_MCP_SERVICES.map((s) => {
    const r = byName.get(s.name)
    return {
      connectionName: s.name,
      displayName: r?.displayName || '',
      comment: r?.description || s.comment,
      source: 'curated',
      hidden: !!r?.hidden,
      overridden: !!r,
      credentialClass: MANAGED_MCP_CLASSES.get(s.name) || null,
    }
  })
  // credentialClass comes from the admin's verification when the catalog row
  // stores one; rows without it stay unchecked (not refused) — see catalogAdmits.
  const custom: CatalogEntry[] = (rows || [])
    .filter((r) => !CURATED_NAMES.has(r.serviceName))
    .map((r) => ({
      connectionName: r.serviceName,
      displayName: r.displayName || '',
      comment: r.description || '',
      source: 'custom',
      hidden: !!r.hidden,
      credentialClass: r.credentialClass || null,
    }))
  // Shared-credential services are refused by policy: never offered in the catalog.
  const all = [...curated, ...custom].filter((e) => catalogAdmits(e.credentialClass).code !== 'shared_credential')
  return includeHidden ? all : all.filter((e) => !e.hidden)
}

// The catalog is read on every MCP-tab load AND every tool-bearing turn (hidden
// enforcement), so it's cached per process; admin writes invalidate it. A DB
// failure degrades to the curated set (nothing hidden) — never blocks chat.
const CATALOG_TTL_MS = 30_000
let catalogCache: { rows: CatalogRow[] | null; ts: number } = { rows: null, ts: 0 }
export function invalidateMcpCatalog(): void {
  catalogCache = { rows: null, ts: 0 }
}
async function catalogRows(email: string, token: string): Promise<CatalogRow[]> {
  if (catalogCache.rows && Date.now() - catalogCache.ts < CATALOG_TTL_MS) return catalogCache.rows
  try {
    const rows = await listMcpCatalogRows(email, token)
    catalogCache = { rows, ts: Date.now() }
    return rows
  } catch {
    return catalogCache.rows || []
  }
}
export async function getMcpCatalog(email: string, token: string, opts?: { includeHidden?: boolean }): Promise<CatalogEntry[]> {
  return buildMcpCatalog(await catalogRows(email, token), opts)
}
export async function getHiddenMcpNames(email: string, token: string): Promise<Set<string>> {
  const rows = await catalogRows(email, token)
  return new Set(rows.filter((r) => r.hidden).map((r) => r.serviceName))
}

// ---- Credential admission of what a user connects -------------------------
// A user may connect a catalog entry or any service typed by name. Either way
// the service must call its backing server with a credential scoped to the
// caller (per-user OAuth, or the caller's own Databricks identity). A service
// with ONE shared credential would let every user act as that identity, so it
// is refused — the same policy the admin catalog applies (mcpCredentials.js).
// Fail closed: shared, unverified, unchecked, or a classifier error → refused.
// Runs on connect, on re-check of a saved connection, and on the by-name
// search candidate (so the reason shows before the user clicks).
//
// Only the class is cached (per service, per process), never a token or a
// response body; errors and 'unverified' are not cached so a transient failure
// doesn't stick.
const ADMISSION_TTL_MS = 60_000
const admissionCache = new Map<string, { credentialClass: string; ts: number }>() // name -> { credentialClass, ts }
export function resetMcpAdmissionCache(): void {
  admissionCache.clear()
  turnWarms.clear()
}

const ADMISSION_MESSAGES: Record<string, string> = {
  shared_credential:
    'Este MCP Service usa uma credencial compartilhada (a mesma para todos os usuários) e foi recusado. Peça a um admin um serviço com login por usuário.',
  credential_unverified:
    'Não foi possível confirmar que este MCP Service usa uma credencial por usuário; por segurança, a conexão foi recusada.',
  credential_unchecked:
    'A credencial deste MCP Service ainda não foi verificada; por segurança, a conexão foi recusada.',
  credential_check_failed:
    'A verificação da credencial deste MCP Service falhou; por segurança, a conexão foi recusada. Tente de novo em instantes.',
}

/** The user-facing refusal for an admission code: { error, code }. Never carries a credential. */
export function mcpAdmissionError(code: string | undefined): { error: string; code: string } {
  const key = code && ADMISSION_MESSAGES[code] ? code : 'credential_check_failed'
  return { error: ADMISSION_MESSAGES[key] as string, code: `mcp_${key}` }
}

async function resolveCatalog(catalog: CatalogInput, userEmail: string, token: string): Promise<CatalogEntry[]> {
  if (Array.isArray(catalog)) return catalog
  try {
    return await (typeof catalog === 'function' ? catalog() : getMcpCatalog(userEmail, token, { includeHidden: true }))
  } catch {
    return [] // no catalog → everything is classified as by name (never admitted for free)
  }
}

/**
 * Whether `userEmail` may connect `name`: { ok, credentialClass, code? }.
 * A catalog entry with a confirmed admitted class is taken as is; anything
 * else is classified from metadata (the user's token only for the per-user
 * login check). `catalog` (array or thunk) and `classify` are injectable.
 */
export async function admitMcpConnection(
  token: string,
  userEmail: string,
  name: string,
  { catalog, classify = classifyService }: { catalog?: CatalogInput; classify?: ClassifyFn } = {}
): Promise<Admission> {
  const entries = await resolveCatalog(catalog, userEmail, token)
  const known = catalogClass(entries.find((e) => e.connectionName === name))
  if (known && catalogAdmits(known).ok) return { ok: true, credentialClass: known }
  const hit = admissionCache.get(name)
  let credentialClass = hit && Date.now() - hit.ts < ADMISSION_TTL_MS ? hit.credentialClass : null
  if (!credentialClass) {
    let cls
    try {
      cls = await classify(name, { adminToken: token })
    } catch (e) {
      logger.warn('mcp credential classification failed', { service: name, err: e })
      return { ok: false, credentialClass: 'unverified', code: 'credential_check_failed' }
    }
    if (!cls?.credentialClass) return { ok: false, credentialClass: 'unverified', code: 'credential_check_failed' }
    credentialClass = cls.credentialClass
    if (credentialClass !== 'unverified') admissionCache.set(name, { credentialClass, ts: Date.now() })
  }
  const admission = catalogAdmits(credentialClass)
  return admission.ok ? { ok: true, credentialClass } : { ok: false, credentialClass, code: admission.code }
}

// ---- Turn-time admission (W2-11d) -------------------------------------------
// Every MCP ref a turn resolves (adopted connections, session refs) must pass
// the same admission, so a connection saved before the rule — or a ref written
// straight into a session — never reaches the model. The turn READS the cache
// above and never awaits a classification (TTFT): a cold or too-old entry fails
// closed for that turn and starts one deduped background admitMcpConnection,
// which fills the cache for the next turn. A cached class is trusted on the
// turn for 10 min (the W2-11a negative-state bound); past the connect path's
// 60 s it is still served but refreshed in the background.
const TURN_ADMISSION_MAX_AGE_MS = 10 * 60_000
const turnWarms = new Map<string, Promise<unknown>>() // name -> Promise
/** Injectable background classifier (tests); the turn never awaits it. */
export const mcpAdmissionDeps: { classify: ClassifyFn } = { classify: classifyService }

function warmAdmission(token: string, userEmail: string, name: string, catalog: CatalogInput): void {
  if (!token || turnWarms.has(name)) return
  const p = admitMcpConnection(token, userEmail, name, { catalog, classify: mcpAdmissionDeps.classify })
    .catch(() => {})
    .finally(() => turnWarms.delete(name))
  turnWarms.set(name, p)
}

/**
 * Synchronous, cache-only admission of `name` for one turn:
 * { ok, credentialClass?, code?, cold? }. `catalog` is the turn's catalog
 * entries (a confirmed admitted class needs no cache).
 */
export function mcpAdmissionForTurn(token: string, userEmail: string, name: string, { catalog = [] }: { catalog?: CatalogEntry[] } = {}): Admission {
  const entry = catalog.find((e) => e.connectionName === name) || { connectionName: name }
  const known = catalogClass(entry)
  if (known && catalogAdmits(known).ok) return { ok: true, credentialClass: known }
  const hit = admissionCache.get(name)
  const age = hit ? Date.now() - hit.ts : Infinity
  if (!(age < TURN_ADMISSION_MAX_AGE_MS)) {
    warmAdmission(token, userEmail, name, catalog)
    return { ok: false, cold: true, code: 'credential_unchecked' }
  }
  if (age >= ADMISSION_TTL_MS) warmAdmission(token, userEmail, name, catalog)
  const cached = hit as NonNullable<typeof hit> // a finite age means the entry exists
  const admission = catalogAdmits(cached.credentialClass)
  return admission.ok
    ? { ok: true, credentialClass: cached.credentialClass }
    : { ok: false, credentialClass: cached.credentialClass, code: admission.code }
}

interface SearchItem {
  kind: 'mcp-external'
  connectionName: string
  displayName?: string
  comment: string
  refused?: string
}

/**
 * Returns the connectable MCP Services for the user's tab: the visible catalog
 * (curated ∪ admin-published, minus hidden), plus a "connect by name" candidate
 * when `query` is itself a service name/URL not already in it (and not hidden
 * by an admin). No catalog listing/scan — the OBO token can't list. The
 * candidate is checked by admitMcpConnection: a refused one stays listed with
 * `refused` (the error code) and the reason as its comment; connect refuses it
 * again server-side. `deps` ({ catalog, classify }) is for tests.
 */
export async function searchExternalMcpConnections(
  token: string,
  userEmail: string,
  query: unknown,
  limit = 50,
  deps: { catalog?: CatalogInput; classify?: ClassifyFn } = {}
): Promise<SearchItem[]> {
  const all = await resolveCatalog(deps.catalog, userEmail, token)
  const items: SearchItem[] = all
    .filter((e) => !e.hidden)
    .map((e): SearchItem => ({ kind: 'mcp-external', connectionName: e.connectionName, displayName: e.displayName, comment: e.comment }))
  const byName = normalizeServiceName(query)
  if (byName && !all.some((e) => e.connectionName === byName)) {
    const admission = await admitMcpConnection(token, userEmail, byName, { catalog: all, classify: deps.classify })
    const candidate: SearchItem = { kind: 'mcp-external', connectionName: byName, comment: 'MCP Service do catálogo (conectar por nome).' }
    if (!admission.ok) {
      const refusal = mcpAdmissionError(admission.code)
      candidate.refused = refusal.code
      candidate.comment = refusal.error
    }
    items.unshift(candidate)
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
let spListCache: { items: { connectionName: string; comment: string }[] | null; ts: number } = { items: null, ts: 0 }
export async function listMcpServicesViaSp(): Promise<{ connectionName: string; comment: string }[]> {
  if (spListCache.items && Date.now() - spListCache.ts < SP_LIST_TTL_MS) return spListCache.items
  const token = await appServiceToken()
  if (!token) return []
  try {
    const items: { connectionName: string; comment: string }[] = []
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
    logger.warn('listMcpServicesViaSp failed', { err: e })
    return spListCache.items || []
  }
}
