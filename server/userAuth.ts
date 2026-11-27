// Per-user authorization during the chat. A tool (A2A agent or MCP service)
// that has no credential of the requesting user — none yet, expired and not
// renewable, revoked, missing a scope, or an MCP service not connected for the
// user — answers with an `auth_required` descriptor instead of a result. The
// turn streams it as an SSE event (`auth_required`), persists it on the tool
// call (chat_tool_calls.auth) and ends the run; the chat shows an "Authorize"
// card; once the user authorized, the card re-runs the turn (regenerate), which
// calls the tool again with the credential now in place. A missing credential
// never falls back to another one (another user's, the admin's, the app's).
//
// The descriptor carries no token and no URL beyond the public sign-in page of
// an MCP service, so it can be stored and shown as is.

export const AUTH_REASONS = ['missing', 'expired', 'revoked', 'insufficient_scope'] as const
export type AuthReason = (typeof AUTH_REASONS)[number]

/** The identity key of a request for every credential and cache: the forwarded e-mail, lowercased. */
export const identityKey = (email: unknown): string => String(email || '').trim().toLowerCase()

export interface AuthDescriptor {
  kind: 'a2a' | 'mcp'
  id: string
  name: string
  reason: AuthReason
  provider?: string
  providerName?: string
  loginUrl?: string
}

/**
 * The descriptor the client renders (and the server persists on the tool call).
 * `loginUrl` is only ever the public MCP sign-in page.
 */
export function authDescriptor({
  kind,
  id,
  name,
  provider = null,
  providerName = null,
  reason = 'missing',
  loginUrl = null,
}: {
  kind: 'a2a' | 'mcp'
  id: string | number
  name?: string | null
  provider?: string | null
  providerName?: string | null
  reason?: string
  loginUrl?: string | null
}): AuthDescriptor {
  const out: AuthDescriptor = {
    kind,
    id: String(id),
    name: String(name || id).slice(0, 200),
    reason: (AUTH_REASONS as readonly string[]).includes(reason) ? (reason as AuthReason) : 'missing',
  }
  if (provider) out.provider = String(provider)
  if (providerName) out.providerName = String(providerName).slice(0, 120)
  if (loginUrl) out.loginUrl = loginUrl
  return out
}

type Lang = 'pt' | 'en' | 'es'

const MODEL_TEXT: Record<Lang, (n: string) => string> = {
  pt: (n) =>
    `AUTH_REQUIRED: o usuário ainda não autorizou "${n}" com a conta dele. O app já mostrou um cartão para ele autorizar; depois da autorização, ele pede para refazer a resposta. Não tente de novo, não use outra fonte no lugar e não peça credenciais.`,
  en: (n) =>
    `AUTH_REQUIRED: the user has not authorized "${n}" with their own account yet. The app already showed them a card to authorize; once they do, they ask for the answer to be redone. Do not retry, do not use another source instead and do not ask for credentials.`,
  es: (n) =>
    `AUTH_REQUIRED: el usuario aún no autorizó "${n}" con su propia cuenta. La app ya le mostró una tarjeta para autorizar; después de autorizar, pide rehacer la respuesta. No lo intentes de nuevo, no uses otra fuente en su lugar y no pidas credenciales.`,
}

const asLang = (lang: unknown): Lang => (lang === 'en' || lang === 'es' ? lang : 'pt')

/** Tool-result text for the model: fixed wording, never a URL or anything the remote sent. */
export function authRequiredText(name: unknown, lang: unknown = 'pt'): string {
  return MODEL_TEXT[asLang(lang)](String(name || '').replace(/["\n\r]/g, ' ').slice(0, 120))
}

const PAUSE_NOTICE: Record<Lang, (names: string) => string> = {
  pt: (names) => `_Aguardando sua autorização para: ${names}._`,
  en: (names) => `_Waiting for your authorization for: ${names}._`,
  es: (names) => `_Esperando tu autorización para: ${names}._`,
}

/** The note that closes a turn ended by auth_required (the card next to it holds the action). */
export function pauseNotice(descriptors: { name: string }[], lang: unknown = 'pt'): string {
  const names = [...new Set(descriptors.map((d) => d.name))].join(', ')
  return PAUSE_NOTICE[asLang(lang)](names)
}

// ---- MCP signals --------------------------------------------------------------------
// The Unity AI Gateway words a missing per-user credential in free text: a
// tools/call answered with isError ("… is not connected for this user, or its
// credential has expired or been revoked … /mcp-service-login?name=…"), a
// tools/list JSON-RPC -32006 "(HTTP 401)", or (classic connection proxy)
// -32600 with error_code UNAUTHENTICATED. A 403 that names a missing grant
// (USE CONNECTION, EXECUTE) is an access problem, not an authorization one.

const MCP_NOT_CONNECTED = /is not connected for this user|credential (?:for user identity\([^)]*\) )?is not found|please login first|mcp-service-login\?name=|\bUNAUTHENTICATED\b|request was rejected \(HTTP 401\)|\b-32006\b.*\b401\b/i
const MCP_INSUFFICIENT_SCOPE = /insufficient[_ ]scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i
const MCP_PERMISSION = /missing USE CONNECTION|PERMISSION_DENIED|does not have EXECUTE/i

/** 'missing' | 'insufficient_scope' when the text is the gateway's "authorize first" answer, else null. */
export function mcpAuthReason(text: unknown): 'missing' | 'insufficient_scope' | null {
  const t = String(text || '')
  if (!t) return null
  if (MCP_PERMISSION.test(t) && !MCP_NOT_CONNECTED.test(t)) return null
  if (MCP_INSUFFICIENT_SCOPE.test(t)) return 'insufficient_scope'
  if (MCP_NOT_CONNECTED.test(t)) return 'missing'
  return null
}

const FQ_SERVICE_NAME = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

/** The public Databricks sign-in page of an MCP service, built from the catalog name (never from a gateway message). */
export function mcpLoginUrl(serviceName: unknown, env: Record<string, string | undefined> = process.env): string | null {
  if (!FQ_SERVICE_NAME.test(String(serviceName || ''))) return null
  let host = String(env.DATABRICKS_HOST || '').replace(/\/+$/, '')
  if (!host) return null
  if (!/^https?:\/\//.test(host)) host = `https://${host}`
  const url = new URL('/mcp-service-login', host)
  url.searchParams.set('name', String(serviceName))
  if (/^\d{1,20}$/.test(String(env.DATABRICKS_WORKSPACE_ID || ''))) url.searchParams.set('o', env.DATABRICKS_WORKSPACE_ID as string)
  return url.href
}
