// Which credential an MCP service of the catalog calls its backing server
// with: read from the service's configuration METADATA — `GET
// /api/2.1/unity-catalog/mcp-services/<name>` (config.source_connection,
// options.oauth_provider) and the source connection's `credential_type` —
// never a secret value (the API returns none). The OBO token has no
// `unity-catalog` scope, so these reads use the app's service principal, for
// metadata only; it never calls a tool. The per-user credentials API, read with
// the admin's own token, only tells whether the service has a per-user login at
// all. Whatever cannot be read stays `unverified`.
//
// Ported from the fork's userAuth.js (classifier + managed-service table) and
// mcpCredentials.js; the pure helpers live here because this repo has no
// userAuth.js. Only the catalog path uses them (see externalMcp.js).
import { appServiceToken } from './db.js'

// ---- classification from metadata -------------------------------------------
//   per_user   — each user authorizes their own account (OAUTH_U2M_MAPPING, OAUTH_DCR, system.ai.* with an oauth_provider)
//   databricks — the caller's own Databricks identity (OBO; no third-party credential)
//   shared     — one credential for every caller (BEARER_TOKEN, OAUTH_M2M, shared OAUTH_U2M, static ones)
//   unverified — the metadata could not be read

type CredentialClass = 'per_user' | 'databricks' | 'shared' | 'unverified'
interface Classification {
  credentialClass: CredentialClass
  credentialType: string | null
}
interface Admission {
  ok: boolean
  badge?: 'shared' | null
  code?: string
}
interface ClassifiedService extends Classification {
  admission: Admission
}
/** The fields read from the UC `mcp-services/<name>` and `connections/<name>` responses. */
interface MetadataBody {
  config?: { source_connection?: { name?: string; options?: { oauth_provider?: string } } }
  credential_type?: string
}
/** The slice of `fetch` this module uses (tests inject a fake with just these members). */
type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; text(): Promise<string> }>

export const CREDENTIAL_CLASSES: CredentialClass[] = ['per_user', 'databricks', 'shared', 'unverified']
const PER_USER_TYPES = new Set(['OAUTH_U2M_MAPPING', 'OAUTH_DCR'])
const SHARED_TYPES = new Set([
  'BEARER_TOKEN',
  'OAUTH_M2M',
  'OAUTH_U2M',
  'USERNAME_PASSWORD',
  'SERVICE_CREDENTIAL',
  'PEM_PRIVATE_KEY',
  'ANY_STATIC_CREDENTIAL',
  'OAUTH_RESOURCE_OWNER_PASSWORD',
  'SSWS_TOKEN',
  'EDGEGRID_AKAMAI',
  'OAUTH_ACCESS_TOKEN',
])

/**
 * { credentialClass, credentialType } from metadata: `credentialType` (the
 * connection's credential_type), `oauthProvider` (options.oauth_provider),
 * `userLogin` ('per_user' when the per-user credentials API knows the
 * service, 'none' when it says the service has no user login, null unknown).
 * 'databricks' is never inferred here: it comes from the known managed
 * services (MANAGED_MCP_CLASSES) or the admin's explicit declaration.
 */
export function classifyCredential({
  credentialType = null,
  oauthProvider = null,
  userLogin = null,
}: {
  credentialType?: string | null
  oauthProvider?: string | null
  userLogin?: 'per_user' | 'none' | null
} = {}): Classification {
  const type = credentialType ? String(credentialType).toUpperCase() : null
  if (type && PER_USER_TYPES.has(type)) return { credentialClass: 'per_user', credentialType: type }
  if (type && SHARED_TYPES.has(type)) return { credentialClass: 'shared', credentialType: type }
  if (userLogin === 'per_user' || (oauthProvider && !/UNSPECIFIED/i.test(String(oauthProvider)))) {
    return { credentialClass: 'per_user', credentialType: type }
  }
  // no per-user login and an unreadable credential type: OBO or a shared credential, it can't tell
  return { credentialClass: 'unverified', credentialType: type }
}

// Policy for shared credentials in the catalog: 'refuse' (decided) or 'badge'
// (accept and show "compartilhada" to every user).
export const SHARED_CREDENTIAL_POLICY = 'refuse'

// Databricks-managed services of system.ai, by what they call the backing
// service with: the user's own account at the provider, or the caller's own
// Databricks identity.
export const MANAGED_MCP_CLASSES = new Map<string, CredentialClass>([
  ['system.ai.slack', 'per_user'],
  ['system.ai.gmail', 'per_user'],
  ['system.ai.github', 'per_user'],
  ['system.ai.google_drive', 'per_user'],
  ['system.ai.google_calendar', 'per_user'],
  ['system.ai.microsoft_365', 'per_user'],
  ['system.ai.atlassian', 'per_user'],
  ['system.ai.web_search', 'databricks'],
  ['system.ai.dbsql', 'databricks'],
  ['system.ai.sandbox', 'databricks'],
  ['system.ai.genie_one_mcp', 'databricks'],
])

/**
 * The class a catalog entry is offered under: the one its configuration check
 * stored or, for an entry added before the check existed, the known class of a
 * managed system.ai service; null when the entry was never checked.
 */
export function catalogClass(entry?: { credentialClass?: string | null; connectionName?: string } | null): string | null {
  return entry?.credentialClass || (entry?.connectionName ? MANAGED_MCP_CLASSES.get(entry.connectionName) : undefined) || null
}

// Classes the catalog offers: confirmed by metadata, by the managed service
// list, or declared by an admin for a service whose metadata is unreadable.
const ADMITTED_CLASSES = new Set(['per_user', 'databricks'])

/** Whether the catalog takes an item of this class under the policy: { ok, badge?, code? }. */
export function catalogAdmits(credentialClass: string | null | undefined, policy: string = SHARED_CREDENTIAL_POLICY): Admission {
  // never checked: offered only after an admin's verification classifies it
  if (!credentialClass) return { ok: false, code: 'credential_unchecked' }
  if (ADMITTED_CLASSES.has(credentialClass)) return { ok: true, badge: null }
  if (credentialClass !== 'shared') return { ok: false, code: 'credential_unverified' }
  if (policy === 'badge') return { ok: true, badge: 'shared' }
  return { ok: false, code: 'shared_credential' }
}

// ---- reading the metadata ----------------------------------------------------

function workspaceHost(env: Record<string, string | undefined>): string {
  let h = String(env.DATABRICKS_HOST || '').replace(/\/+$/, '')
  if (h && !/^https?:\/\//.test(h)) h = `https://${h}`
  return h
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  token: string | null | undefined
): Promise<{ status: number; body: MetadataBody | null; text: string }> {
  if (!token) return { status: 0, body: null, text: '' }
  try {
    const r = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    const text = await r.text().catch(() => '')
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: r.status, body, text }
  } catch {
    return { status: 0, body: null, text: '' }
  }
}

/**
 * { credentialClass, credentialType, admission } of `name` (catalog.schema.service),
 * where `admission` is catalogAdmits(credentialClass) under the policy.
 * `adminToken`: the admin's OBO token, only for the per-user-login check.
 * `metadataToken`: defaults to the app service principal's token (null when the
 * app runs without SP credentials, e.g. local dev — then everything not managed
 * comes back `unverified`).
 */
export async function classifyMcpService(
  name: string,
  {
    adminToken = null,
    metadataToken,
    fetchImpl = fetch,
    env = process.env,
    policy = SHARED_CREDENTIAL_POLICY,
  }: {
    adminToken?: string | null
    metadataToken?: string | null
    fetchImpl?: FetchLike
    env?: Record<string, string | undefined>
    policy?: string
  } = {}
): Promise<ClassifiedService> {
  const host = workspaceHost(env)
  const managed = MANAGED_MCP_CLASSES.get(name)
  const finish = (r: Classification): ClassifiedService => ({ ...r, admission: catalogAdmits(r.credentialClass, policy) })
  if (!host) {
    return finish(managed ? { credentialClass: managed, credentialType: null } : { credentialClass: 'unverified', credentialType: null })
  }
  const spToken = metadataToken === undefined ? await appServiceToken().catch(() => null) : metadataToken
  const service = await getJson(fetchImpl, `${host}/api/2.1/unity-catalog/mcp-services/${name}`, spToken)
  const source = service.body?.config?.source_connection || null
  let credentialType = null
  if (source?.name && !/^system\./.test(String(source.name))) {
    const conn = await getJson(fetchImpl, `${host}/api/2.1/unity-catalog/connections/${encodeURIComponent(source.name)}`, spToken)
    credentialType = conn.body?.credential_type || null
  }
  let userLogin: 'per_user' | 'none' | null = null
  if (adminToken) {
    const login = await getJson(fetchImpl, `${host}/api/2.1/unity-catalog/mcp-services/${name}/user-credentials`, adminToken)
    if (login.status === 200 || login.status === 404) userLogin = 'per_user'
    else if (login.status === 400 && /no connection configured for user login/i.test(login.text || '')) userLogin = 'none'
  }
  const read = classifyCredential({ credentialType, oauthProvider: source?.options?.oauth_provider || null, userLogin })
  // a managed system.ai service keeps its known class when its metadata is unreadable
  if (read.credentialClass === 'unverified' && managed) return finish({ credentialClass: managed, credentialType: read.credentialType })
  return finish(read)
}
