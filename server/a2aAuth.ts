// Who an A2A call authenticates as. Every strategy uses the END USER's own
// credential for the target's identity provider — never the app service
// principal — and each credential has an audience it may be sent to:
//
//   • databricks-obo — the signed-in user's Databricks token (req.token). Only
//     ever sent to this workspace: its host, its Databricks Apps (app-to-app,
//     *.databricksapps.com of THIS workspace) and A2A_ALLOWED_HOSTS entries
//     flagged `databricks:`.
//   • oauth2-user — a token the user obtained by signing in to an external IdP
//     (any OIDC / OAuth 2.0 provider) through Authorization Code + PKCE.
//     Providers are admin-configured (A2A_OAUTH_PROVIDERS) and the token is only
//     sent to hosts matching that provider's hostPatterns. Tokens are stored
//     encrypted (AES-256-GCM, A2A_TOKEN_ENC_KEY, the row identity as AAD);
//     without the key the strategy is disabled.
//   • none — no credential at all, for an agent that is public by design. Only
//     offered for a host the admin allowed in A2A_ALLOWED_HOSTS (plain entry),
//     and the call goes to that agent's own origin only.
//
// A provider may also name `idTokenHeader`: a destination of kind `id-token`
// then receives the stored ID token as the bearer AND in that extra header (for
// a gateway in front of the agent that checks the ID token before forwarding the
// access token). It is a plain header name; there is no vendor-specific mode.
//
// Strategy per agent (chosen at registration, persisted on the agent row and
// re-derived from the current card before every call): the card's effective
// security requirements must be satisfiable by the strategy's credential. A
// card that requires an IdP no provider covers is rejected — it never falls
// back to the Databricks token.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet } from 'jose'
import {
  A2aError,
  a2aConfig,
  createGuardedFetch,
  isDatabricksUrl,
  isStrictHostPattern,
  parsePattern,
  redactSecrets,
  urlMatchesPattern,
} from './a2aGuard.ts'
import type { HostPattern, A2aConfig, Resolver } from './a2aGuard.ts'
import { assertUserCredentialsAllowed } from './runIdentity.ts'
import { logger } from './log.ts'

type Env = Record<string, string | undefined>

export const STRATEGY_OBO = 'databricks-obo'
export const STRATEGY_OAUTH = 'oauth2-user'
export const STRATEGY_NONE = 'none'
export type Strategy = typeof STRATEGY_OBO | typeof STRATEGY_OAUTH | typeof STRATEGY_NONE
export const STRATEGIES: readonly Strategy[] = [STRATEGY_OBO, STRATEGY_OAUTH, STRATEGY_NONE]

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
// `databricks` marks the OBO strategy in tool results (ERROR [a2a:auth_required:databricks])
const RESERVED_PROVIDER_IDS = new Set(['databricks', 'none'])
const CLIENT_AUTH_METHODS = new Set(['client_secret_post', 'client_secret_basic', 'none'])
// an ID token is only issued for these scopes; a provider with an id-token destination always asks for them
const ID_TOKEN_SCOPES = ['openid', 'email', 'profile']
// set by beginAuthorization for every login; authParams may only add to them
const RESERVED_AUTH_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method']
// header names an `idTokenHeader` may never take
const FORBIDDEN_HEADERS = new Set(['authorization', 'host', 'content-length', 'content-type', 'cookie', 'set-cookie', 'transfer-encoding', 'connection', 'accept', 'a2a-version', 'a2a-extensions', 'x-a2a-extensions'])
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const trimSlash = (s: unknown): string => String(s || '').replace(/\/+$/, '')

// What a destination receives from the user's login (hostPatterns `send`): the
// ID token or the access token. Each token only ever goes to the destinations
// that ask for it.
export const SEND_ID_TOKEN = 'id-token'
export const SEND_ACCESS_TOKEN = 'access-token'
export type SendKind = typeof SEND_ID_TOKEN | typeof SEND_ACCESS_TOKEN
const SEND_KINDS = new Set<string>([SEND_ID_TOKEN, SEND_ACCESS_TOKEN])
const PATTERN_KEYS = new Set(['pattern', 'send'])

export interface ProviderPattern extends HostPattern {
  send: SendKind
}

export interface OAuthProvider {
  id: string
  type: 'oidc' | 'oauth2'
  name: string
  clientId: string
  clientSecret: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  revocationEndpoint: string
  jwksUri: string
  scopes: string[]
  hostPatterns: ProviderPattern[]
  requireEmailMatch: boolean
  idTokenHeader: string | null
  authParams: Record<string, string>
  tokenEndpointAuthMethod: string
  error?: string
}
/** A provider the config named but could not be loaded (carries `error`). */
export interface BrokenProvider {
  id: string
  error: string
}
export type LoadedProvider = OAuthProvider | BrokenProvider

// A provider refused at load is logged once per fixed code (no value from the config).
const loggedRejections = new Set<string>()
function logRejection(id: string, code: string): void {
  const key = `${id}\n${code}`
  if (loggedRejections.has(key)) return
  loggedRejections.add(key)
  logger.warn(`a2a_provider_rejected ${PROVIDER_ID.test(id) ? id : '?'} (${code})`)
}

const parseHostPattern = (text: unknown): HostPattern | null => (isStrictHostPattern(text) ? parsePattern(text) : null)

type Raw = Record<string, unknown>

// hostPatterns entries: a string (sent kind: the access token) or { pattern, send }.
function parseHostPatterns(list: unknown[]): { patterns: ProviderPattern[] } | { error: string; code: string } {
  const patterns: ProviderPattern[] = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const parsed = parseHostPattern(entry)
      if (!parsed) return { error: 'hostPatterns: padrão inválido', code: 'host_pattern_malformed' }
      patterns.push({ ...parsed, send: SEND_ACCESS_TOKEN })
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'hostPatterns: cada entrada é texto ou { pattern, send }', code: 'host_pattern_malformed' }
    const o = entry as Raw
    if (Object.keys(o).some((k) => !PATTERN_KEYS.has(k))) return { error: 'hostPatterns: só as chaves pattern e send são aceitas', code: 'host_pattern_extra_key' }
    if (typeof o.pattern !== 'string' || !o.pattern.trim()) return { error: 'hostPatterns: objeto sem pattern', code: 'host_pattern_malformed' }
    if (o.send !== undefined && !SEND_KINDS.has(String(o.send))) return { error: 'hostPatterns: send deve ser "id-token" ou "access-token"', code: 'host_pattern_send_invalid' }
    const parsed = parseHostPattern(o.pattern)
    if (!parsed) return { error: 'hostPatterns: pattern inválido', code: 'host_pattern_malformed' }
    patterns.push({ ...parsed, send: (o.send as SendKind | undefined) || SEND_ACCESS_TOKEN })
  }
  return { patterns }
}

function normalizeProvider(raw: Raw, env: Env): LoadedProvider {
  const id = String(raw?.id || '').toLowerCase()
  if (!PROVIDER_ID.test(id)) return { id: id || '?', error: 'id inválido (use [a-z0-9_-], até 32 caracteres)' }
  if (RESERVED_PROVIDER_IDS.has(id)) return { id, error: `o id "${id}" é reservado` }
  const type: 'oidc' | 'oauth2' = raw.type === 'oauth2' ? 'oauth2' : raw.type === 'oidc' || raw.issuer ? 'oidc' : 'oauth2'
  const str = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '')
  const scopesRaw = raw.scopes ?? (type === 'oidc' ? ['openid', 'email'] : [])
  const clientSecret = raw.clientSecretEnv ? String(env[String(raw.clientSecretEnv)] || '') : str('clientSecret')
  const authParams = raw.authParams && typeof raw.authParams === 'object' && !Array.isArray(raw.authParams) ? (raw.authParams as Record<string, string>) : {}
  const overridden = Object.keys(authParams).filter((k) => RESERVED_AUTH_PARAMS.includes(k))
  if (overridden.length) return { id, error: `authParams não pode redefinir parâmetros do protocolo (${overridden.join(', ')})` }
  let idTokenHeader: string | null = null
  if (raw.idTokenHeader != null && raw.idTokenHeader !== false) {
    if (typeof raw.idTokenHeader !== 'string' || !HEADER_NAME.test(raw.idTokenHeader) || FORBIDDEN_HEADERS.has(raw.idTokenHeader.toLowerCase())) {
      return { id, error: 'idTokenHeader inválido (um nome de cabeçalho HTTP simples, que não seja Authorization)' }
    }
    idTokenHeader = raw.idTokenHeader.toLowerCase()
  }
  const scopeList = Array.isArray(scopesRaw) ? scopesRaw.map(String) : String(scopesRaw).split(/\s+/).filter(Boolean)
  const rawPatterns = raw.hostPatterns ?? []
  if (!Array.isArray(rawPatterns)) {
    logRejection(id, 'host_pattern_malformed')
    return { id, error: 'hostPatterns deve ser uma lista' }
  }
  const hostPatterns = parseHostPatterns(rawPatterns)
  if ('error' in hostPatterns) {
    logRejection(id, hostPatterns.code)
    return { id, error: hostPatterns.error }
  }
  const wantsIdToken = hostPatterns.patterns.some((p) => p.send === SEND_ID_TOKEN)
  const p: OAuthProvider = {
    id,
    type,
    name: String(raw.name || id),
    clientId: str('clientId'),
    clientSecret,
    issuer: trimSlash(raw.issuer),
    authorizationEndpoint: str('authorizationEndpoint'),
    tokenEndpoint: str('tokenEndpoint'),
    userinfoEndpoint: str('userinfoEndpoint'),
    revocationEndpoint: str('revocationEndpoint'),
    jwksUri: str('jwksUri'),
    scopes: wantsIdToken ? [...new Set([...scopeList, ...ID_TOKEN_SCOPES])] : scopeList,
    hostPatterns: hostPatterns.patterns,
    requireEmailMatch: raw.requireEmailMatch !== false,
    idTokenHeader,
    authParams: { ...authParams },
    tokenEndpointAuthMethod: str('tokenEndpointAuthMethod') || (clientSecret ? 'client_secret_post' : 'none'),
  }
  if (!p.clientId) p.error = 'clientId ausente'
  else if (raw.clientSecretEnv && !clientSecret) p.error = `segredo ausente (${String(raw.clientSecretEnv)})`
  else if (!CLIENT_AUTH_METHODS.has(p.tokenEndpointAuthMethod)) p.error = `tokenEndpointAuthMethod inválido (${p.tokenEndpointAuthMethod})`
  else if (p.tokenEndpointAuthMethod !== 'none' && !clientSecret) p.error = `${p.tokenEndpointAuthMethod} exige um segredo (clientSecretEnv)`
  else if (!p.hostPatterns.length) p.error = 'hostPatterns vazio'
  else if (!p.issuer && !(p.authorizationEndpoint && p.tokenEndpoint)) p.error = 'informe issuer ou authorizationEndpoint + tokenEndpoint'
  return p
}

/** Admin-configured OAuth providers (A2A_OAUTH_PROVIDERS, JSON array). Misconfigured entries carry `error`. */
export function loadProviders(env: Env = process.env): LoadedProvider[] {
  if (!env.A2A_OAUTH_PROVIDERS) return []
  try {
    const parsed: unknown = JSON.parse(env.A2A_OAUTH_PROVIDERS)
    return (Array.isArray(parsed) ? parsed : [parsed]).map((raw) => normalizeProvider((raw && typeof raw === 'object' ? raw : {}) as Raw, env))
  } catch {
    return [{ id: '?', error: 'A2A_OAUTH_PROVIDERS não é um JSON válido' }]
  }
}

const isUsable = (p: LoadedProvider): p is OAuthProvider => !p.error

export function usableProviders(env: Env = process.env): OAuthProvider[] {
  return loadProviders(env).filter(isUsable)
}

export function providerById(id: string | null | undefined, env: Env = process.env): OAuthProvider | null {
  return usableProviders(env).find((p) => p.id === id) || null
}

export function providerMatchesUrl(provider: OAuthProvider, url: string | URL): boolean {
  return provider.hostPatterns.some((pat) => urlMatchesPattern(url, pat))
}

// exact host before a wildcard, then the longest path prefix, then an explicit port
const specificity = (pat: HostPattern): number[] => [pat.text.includes('*') ? 0 : 1, pat.path && pat.path !== '/' ? pat.path.length : 0, pat.port != null ? 1 : 0]
const moreSpecific = (a: HostPattern, b: HostPattern): boolean => {
  const x = specificity(a)
  const y = specificity(b)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number)
  return false
}

/** The `send` (id-token | access-token) of the most specific hostPattern covering `url`, or null when none does. */
export function destinationFor(provider: OAuthProvider | null | undefined, url: string | URL): SendKind | null {
  let best: ProviderPattern | null = null
  for (const pat of provider?.hostPatterns || []) {
    if (urlMatchesPattern(url, pat) && (!best || moreSpecific(pat, best))) best = pat
  }
  return best?.send || null
}

/** The scopes an access-token destination needs on the stored login: the provider's scopes beyond the identity ones. */
export function requiredApiScopes(provider: OAuthProvider | null | undefined): string[] {
  return (provider?.scopes || []).filter((s) => !ID_TOKEN_SCOPES.includes(s))
}

/**
 * The scopes of `required` missing from `granted` (the `scope` the IdP answered
 * on the exchange or the refresh). An empty `granted` means the IdP did not say
 * (RFC 6749 §5.1: the requested scope) and nothing is reported missing.
 */
export function missingScopes(granted: unknown, required: string[]): string[] {
  const have = new Set(String(granted || '').split(/\s+/).filter(Boolean))
  if (!have.size) return []
  return required.filter((s) => !have.has(s))
}

export interface ConnectionInfo {
  idpEmailVerified: boolean
  expiresAt: Date | string | null
  scope: string
  renewable: boolean
}
export type ConnectionStateName = 'not_connected' | 'expired' | 'insufficient_scope' | 'connected'

/**
 * The state of the user's own login for `provider` as a destination sees it:
 * 'not_connected' (no row), 'expired' (past its expiry and not renewable),
 * 'insufficient_scope' (an access-token destination at `url` needs a scope the
 * grant lacks) or 'connected'. `row`: the vault's connection entry of this
 * user (vault.connections), never another identity's.
 */
export function connectionState(provider: OAuthProvider, row: ConnectionInfo | undefined | null, url: string | URL | null = null, now = Date.now()): ConnectionStateName {
  if (!row) return 'not_connected'
  if (!row.renewable && row.expiresAt && new Date(row.expiresAt).getTime() <= now) return 'expired'
  if (url && destinationFor(provider, url) === SEND_ACCESS_TOKEN && missingScopes(row.scope, requiredApiScopes(provider)).length) return 'insufficient_scope'
  return 'connected'
}

// ---- token encryption ----------------------------------------------------------

/** A2A_TOKEN_ENC_KEY: 32 bytes as base64 or 64 hex chars. Returns null when absent/invalid. */
export function encryptionKey(env: Env = process.env): Buffer | null {
  const raw = String(env.A2A_TOKEN_ENC_KEY || '').trim()
  if (!raw) return null
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return buf.length === 32 ? buf : null
}

/**
 * The stored form of an external subject: HMAC-SHA256 under a key derived
 * (HKDF, info 'a2a-subject') from A2A_TOKEN_ENC_KEY, over provider_id + NUL +
 * sub, base64url. The subject itself is never persisted; equality checks
 * compare digests.
 */
export function subjectDigest(encKey: Buffer, providerId: string, subject: string): string {
  const k = Buffer.from(hkdfSync('sha256', encKey, Buffer.alloc(0), 'a2a-subject', 32))
  return createHmac('sha256', k).update(`${providerId}\0${subject}`).digest('base64url')
}

const sameDigest = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// a provider stays bound to the account (sub) it was first connected with
const subjectConflict = (provider: OAuthProvider): A2aError =>
  new A2aError('oauth_failed', `Esta conta do ${provider.name} não é a que estava conectada; desconecte o ${provider.name} antes de trocar de conta.`, {
    reason: 'identity_conflict',
  })

export function oauthDisabledReason(env: Env = process.env): string | null {
  if (!String(env.A2A_TOKEN_ENC_KEY || '').trim()) return 'A2A_TOKEN_ENC_KEY não configurada: login em provedores externos desabilitado.'
  if (!encryptionKey(env)) return 'A2A_TOKEN_ENC_KEY inválida (use 32 bytes em base64 ou 64 caracteres hex).'
  return null
}

const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url')

export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`
}

export function unseal(key: Buffer, sealed: string, aad: string): string {
  const [v, iv, tag, ct] = String(sealed || '').split('.')
  if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('token cifrado em formato desconhecido')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}

// the ciphertext is bound to its row: a value copied to another user/provider/field fails to open
// (fields: 'access', 'refresh', 'id')
const aadFor = (email: string, providerId: string, field: string): string => `a2a-oauth|${String(email).toLowerCase()}|${providerId}|${field}`

/** The `exp` of a JWT as epoch ms (the payload read, not verified), or null when absent/unparseable. */
export function jwtExpiryMs(token: unknown): number | null {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] as string, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

// an ID token a destination would refuse: expired, or about to (same margin as the access token)
const idTokenExpired = (idToken: string): boolean => {
  const exp = jwtExpiryMs(idToken)
  return exp !== null && exp - 60_000 <= Date.now()
}

// ---- IdP endpoints ---------------------------------------------------------------

const discoveryCache = new Map<string, { ts: number; doc: Record<string, unknown> }>() // issuer -> { ts, doc }
const DISCOVERY_TTL_MS = 60 * 60 * 1000

/** What the IdP fetches may resolve against (tests point a provider at a local mock IdP). */
export const idpDeps: { resolver?: Resolver; cfg?: A2aConfig } = {}

function idpFetch(endpoint: string, { token = null, authorization = null }: { token?: string | null; authorization?: string | null } = {}) {
  const target = new URL(endpoint)
  return createGuardedFetch({
    token,
    authorization,
    requireToken: false,
    allowUrl: (u) => u.origin === target.origin && u.pathname === target.pathname,
    ...(idpDeps.cfg ? { cfg: idpDeps.cfg } : {}),
    ...(idpDeps.resolver ? { resolver: idpDeps.resolver } : {}),
  })
}

export interface Endpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  revocationEndpoint: string
  jwksUri: string
}

export async function providerEndpoints(provider: OAuthProvider): Promise<Endpoints> {
  const explicit: Endpoints = {
    authorizationEndpoint: provider.authorizationEndpoint,
    tokenEndpoint: provider.tokenEndpoint,
    userinfoEndpoint: provider.userinfoEndpoint,
    revocationEndpoint: provider.revocationEndpoint,
    jwksUri: provider.jwksUri || '',
  }
  if (explicit.authorizationEndpoint && explicit.tokenEndpoint) return explicit
  const cached = discoveryCache.get(provider.issuer)
  let doc = cached && Date.now() - cached.ts < DISCOVERY_TTL_MS ? cached.doc : null
  if (!doc) {
    const url = `${provider.issuer}/.well-known/openid-configuration`
    const res = await idpFetch(url)(url, { headers: { accept: 'application/json' }, maxBytes: 128 * 1024 })
    if (!res.ok) throw new A2aError('oauth_failed', `Descoberta OIDC falhou em ${provider.issuer} (HTTP ${res.status}).`, { reason: 'idp_unavailable' })
    doc = (await res.json()) as Record<string, unknown>
    if (trimSlash(doc.issuer) !== provider.issuer) throw new A2aError('oauth_failed', 'O issuer da descoberta OIDC não confere com o configurado.', { reason: 'idp_misconfigured' })
    discoveryCache.set(provider.issuer, { ts: Date.now(), doc })
  }
  const d = doc
  const s = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '')
  return {
    authorizationEndpoint: explicit.authorizationEndpoint || s('authorization_endpoint'),
    tokenEndpoint: explicit.tokenEndpoint || s('token_endpoint'),
    userinfoEndpoint: explicit.userinfoEndpoint || s('userinfo_endpoint'),
    revocationEndpoint: explicit.revocationEndpoint || s('revocation_endpoint'),
    jwksUri: explicit.jwksUri || s('jwks_uri'),
  }
}

// Client authentication (RFC 6749 §2.3.1) as the provider is configured — the
// same for the token and the revocation endpoints. Returns the Authorization
// header for client_secret_basic; otherwise adds the credentials to `body`.
function clientAuthentication(provider: OAuthProvider, body: URLSearchParams): string | null {
  if (provider.tokenEndpointAuthMethod === 'client_secret_basic') {
    return `Basic ${Buffer.from(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`).toString('base64')}`
  }
  body.set('client_id', provider.clientId)
  if (provider.tokenEndpointAuthMethod === 'client_secret_post' && provider.clientSecret) body.set('client_secret', provider.clientSecret)
  return null
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number | string
  scope?: string
  token_type?: string
}

async function tokenRequest(provider: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const { tokenEndpoint } = await providerEndpoints(provider)
  const body = new URLSearchParams(params)
  const authorization = clientAuthentication(provider, body)
  const res = await idpFetch(tokenEndpoint, { authorization })(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    maxBytes: 256 * 1024,
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    /* non-JSON error bodies are reported by status */
  }
  if (!res.ok || typeof json.access_token !== 'string' || !json.access_token) {
    // only a registered OAuth error code is repeated, never free text from the IdP
    const reason = oauthErrorCode(json.error) || `HTTP ${res.status}`
    throw new A2aError('oauth_failed', `O provedor ${provider.name} recusou o token (${reason}).`, { httpStatus: res.status, reason: 'token_rejected' })
  }
  return json as unknown as TokenResponse
}

// RFC 6749 §4.1.2.1 / §5.2 and OIDC Core §3.1.2.6 error codes: the only IdP
// error text that is ever echoed back (anything else could be attacker text)
const OAUTH_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
  'interaction_required',
  'login_required',
  'account_selection_required',
  'consent_required',
])
export const oauthErrorCode = (value: unknown): string | null => (typeof value === 'string' && OAUTH_ERROR_CODES.has(value) ? value : null)

// ---- external identity ---------------------------------------------------------------

const jwksCache = new Map<string, { ts: number; keys: ReturnType<typeof createLocalJWKSet> }>() // jwks uri -> { ts, keys }
const JWKS_TTL_MS = 60 * 60 * 1000
// asymmetric only: an HMAC id_token would be "signed" with our own client secret
const ID_TOKEN_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']

async function providerKeys(jwksUri: string, { fresh = false }: { fresh?: boolean } = {}) {
  const cached = jwksCache.get(jwksUri)
  if (!fresh && cached && Date.now() - cached.ts < JWKS_TTL_MS) return cached.keys
  const res = await idpFetch(jwksUri)(jwksUri, { headers: { accept: 'application/json' }, maxBytes: 64 * 1024 })
  if (!res.ok) throw new A2aError('oauth_failed', `As chaves de assinatura do provedor não estão disponíveis (HTTP ${res.status}).`, { reason: 'idp_unavailable' })
  const doc = (await res.json().catch(() => null)) as JSONWebKeySet | null
  if (!Array.isArray(doc?.keys)) throw new A2aError('oauth_failed', 'O JWKS do provedor é inválido.', { reason: 'idp_misconfigured' })
  const keys = createLocalJWKSet(doc)
  jwksCache.set(jwksUri, { ts: Date.now(), keys })
  return keys
}

/** Forgets cached discovery documents and JWKS (tests). */
export function resetIdpCaches(): void {
  discoveryCache.clear()
  jwksCache.clear()
}

function idTokenProblem(e: unknown): string {
  const err = e as { code?: string; claim?: string } | null
  switch (err?.code) {
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'assinatura inválida'
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'assinado por uma chave que o provedor não publica'
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JOSE_NOT_SUPPORTED':
      return 'algoritmo de assinatura não aceito'
    case 'ERR_JWT_EXPIRED':
      return 'expirado'
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return `claim "${String(err.claim || '?').slice(0, 20)}" inválida`
    default:
      return 'formato ou assinatura inválidos'
  }
}

type Claims = Record<string, unknown>

// OIDC Core §3.1.3.7: signature against the provider's JWKS, then iss, aud, azp
// (must be this client when present, required with several audiences), exp,
// iat and the nonce sent with this login.
async function verifyIdToken(provider: OAuthProvider, idToken: string, nonce: string | null, jwksUri: string): Promise<Claims> {
  const issuers = provider.issuer ? [provider.issuer, `${provider.issuer}/`] : null
  const options = {
    algorithms: ID_TOKEN_ALGS,
    audience: provider.clientId,
    ...(issuers ? { issuer: issuers } : {}),
    requiredClaims: ['sub', 'exp', 'iat'],
    maxTokenAge: '10m',
    clockTolerance: 60,
  }
  const verify = async (fresh: boolean): Promise<Claims> => (await jwtVerify(idToken, await providerKeys(jwksUri, { fresh }), options)).payload as Claims
  let claims: Claims
  try {
    try {
      claims = await verify(false)
    } catch (e) {
      // the provider may have rotated its keys since the JWKS was cached
      if ((e as { code?: string })?.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw e
      claims = await verify(true)
    }
  } catch (e) {
    if (e instanceof A2aError) throw e
    throw new A2aError('oauth_failed', `O id_token do ${provider.name} foi recusado (${idTokenProblem(e)}).`, { reason: 'id_token_invalid' })
  }
  const invalid = (msg: string) => new A2aError('oauth_failed', msg, { reason: 'id_token_invalid' })
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.azp !== undefined && claims.azp !== provider.clientId) throw invalid('id_token emitido para outro cliente (azp).')
  if (aud.length > 1 && claims.azp === undefined) throw invalid('id_token com várias audiências e sem azp.')
  if (nonce && claims.nonce !== nonce) throw invalid('nonce do id_token não confere.')
  return claims
}

interface ExternalIdentity {
  claims: Claims | null
  info: Claims | null
}

/**
 * Who the user is at the IdP: a JWKS-verified id_token and/or the userinfo
 * answer for the new access token. An id_token is never read unverified — one
 * that fails verification rejects the login, one the provider publishes no keys
 * for is ignored. Without either, the login is rejected.
 */
async function externalIdentity(provider: OAuthProvider, tokens: TokenResponse, nonce: string): Promise<ExternalIdentity> {
  const { userinfoEndpoint, jwksUri } = await providerEndpoints(provider)
  const claims = tokens.id_token && jwksUri ? await verifyIdToken(provider, tokens.id_token, nonce, jwksUri) : null
  let info: Claims | null = null
  if (userinfoEndpoint) {
    const res = await idpFetch(userinfoEndpoint, { token: tokens.access_token })(userinfoEndpoint, {
      headers: { accept: 'application/json' },
      maxBytes: 64 * 1024,
    }).catch(() => null)
    if (res?.ok) info = (await res.json().catch(() => null)) as Claims | null
    if (!info || typeof info !== 'object' || Array.isArray(info)) info = null
  }
  if (!claims && !info) {
    throw new A2aError('oauth_failed', `Não foi possível confirmar a sua conta no ${provider.name}: não há id_token verificável nem resposta do userinfo.`, {
      reason: 'identity_unconfirmed',
    })
  }
  return { claims, info }
}

// The sub of an id_token returned by a refresh (verified against the JWKS;
// refresh id_tokens carry no nonce), or null when the provider has no JWKS.
async function refreshedSubject(provider: OAuthProvider, idToken: string): Promise<string | null> {
  const { jwksUri } = await providerEndpoints(provider)
  if (!jwksUri) return null
  const claims = await verifyIdToken(provider, idToken, null, jwksUri)
  if (typeof claims.sub !== 'string' || !SUBJECT_SHAPE.test(claims.sub)) {
    throw new A2aError('oauth_failed', `O id_token do ${provider.name} não traz um identificador de conta válido.`, { reason: 'identity_invalid' })
  }
  return claims.sub
}

// What a login accepts as the external account's claims: bounded and
// well-formed. The e-mail is only compared (requireEmailMatch) and never stored
// or shown; the sub only as a digest.
const EMAIL_SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const MAX_EMAIL_LENGTH = 254
// OIDC Core §2: sub is at most 255 ASCII characters; only the characters OIDC subjects, URNs and base64url use.
const SUBJECT_SHAPE = /^[A-Za-z0-9._:@|/+=-]{1,255}$/

/** True for a syntactically valid e-mail of bounded length. */
export function isValidExternalEmail(email: unknown): boolean {
  const e = String(email ?? '')
  return e.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(e)
}

// An identity claim (sub / e-mail) may carry no part of a credential: a
// hostile IdP could otherwise plant a token it just issued where the app would
// store or show it. Both claims are scanned (as sent and percent-decoded once)
// for any 8-character window of a credential in scope.
const WINDOW = 8
function carriesCredential(value: string, secrets: string[]): boolean {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return true
  }
  for (const form of new Set([value, decoded].map((v) => v.toLowerCase()))) {
    for (const secret of secrets) {
      const c = secret.toLowerCase()
      if (!c) continue
      if (form.includes(c)) return true
      for (let i = 0; i + WINDOW <= form.length; i++) if (c.includes(form.slice(i, i + WINDOW))) return true
    }
  }
  return false
}

// The strings of a claim from both sources, or null when a source sent a non-string.
function claimStrings(sources: Claims[], name: string): string[] | null {
  const values = sources.filter((src) => src[name] !== undefined).map((src) => src[name])
  if (values.some((v) => v !== null && typeof v !== 'string')) return null
  if (values.includes(null) && values.some((v) => typeof v === 'string')) return null
  return values.filter((v): v is string => typeof v === 'string')
}

interface BoundIdentity {
  email: string
  emailVerified: boolean
  subject: string
}

/**
 * The identity a login may bind: { email, emailVerified, subject } (the e-mail
 * only for requireEmailMatch, the subject only as subjectDigest — neither is
 * stored). Every sub and e-mail either source sent is validated and scanned
 * before one is chosen; then the userinfo must describe the id_token's subject
 * (identity_conflict) and the two e-mails, when both are present, must be the same.
 */
function checkIdentity({ claims, info }: ExternalIdentity, secrets: string[], provider: OAuthProvider): BoundIdentity {
  const invalid = (): A2aError => new A2aError('oauth_failed', `O ${provider.name} devolveu dados de conta inválidos; o login foi recusado.`, { reason: 'identity_invalid' })
  const sources = [claims, info].filter((s): s is Claims => !!s)
  const subjects = claimStrings(sources, 'sub')
  const emailClaims = claimStrings(sources, 'email')
  if (!subjects || !emailClaims || !subjects.every((v) => SUBJECT_SHAPE.test(v)) || !emailClaims.every(isValidExternalEmail)) throw invalid()
  for (const value of [...subjects, ...emailClaims]) if (carriesCredential(value, secrets)) throw invalid()
  const emails = emailClaims.map((v) => v.toLowerCase())
  // OIDC Core §5.3.2: the userinfo answer must be about the id_token's subject
  if (claims && info && String(info.sub ?? '') !== String(claims.sub)) {
    throw new A2aError('oauth_failed', `O userinfo do ${provider.name} descreve outra conta que não a do id_token.`, { reason: 'identity_conflict' })
  }
  if (new Set(emails).size > 1) throw invalid()
  if (!subjects.length) throw new A2aError('oauth_failed', `O ${provider.name} não informou o identificador da conta (sub).`, { reason: 'identity_invalid' })
  const verified = info ? info.email_verified : claims?.email_verified
  return { email: emails[0] || '', emailVerified: verified === true || verified === 'true', subject: subjects[0] as string }
}

// ---- authorization code + PKCE ------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 1000

/** What a login keeps server-side next to its state; it never travels to the IdP. */
export interface AuthContext {
  /** the auth_required card this login answers (the popup tells the opener, which re-runs the turn) */
  cardId?: string
  [key: string]: unknown
}
interface PendingLogin {
  email: string
  providerId: string
  verifier: string
  nonce: string
  redirectUri: string
  context: AuthContext | null
  createdAt: number
}
// Per process, like the pending logins of every OAuth client that keeps its state server-side: several
// app instances would each keep their own (a login finishes on the instance that started it).
const pending = new Map<string, PendingLogin>()

function sweepPending(now = Date.now()): void {
  for (const [k, v] of pending) if (now - v.createdAt > STATE_TTL_MS) pending.delete(k)
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string)
}

/**
 * Starts a login for `email` with `provider`: a single-use state bound to the
 * user, a PKCE verifier and a nonce, kept server-side. Returns the IdP URL.
 */
export async function beginAuthorization({
  provider,
  email,
  redirectUri,
  context = null,
  env = process.env,
}: {
  provider: OAuthProvider
  email: string
  redirectUri: string
  context?: AuthContext | null
  env?: Env
}): Promise<{ url: string; state: string }> {
  const disabled = oauthDisabledReason(env)
  if (disabled) throw new A2aError('oauth_disabled', disabled)
  const { authorizationEndpoint } = await providerEndpoints(provider)
  sweepPending()
  const state = b64u(randomBytes(24))
  const verifier = b64u(randomBytes(32))
  const nonce = b64u(randomBytes(16))
  pending.set(state, { email: String(email).toLowerCase(), providerId: provider.id, verifier, nonce, redirectUri, context, createdAt: Date.now() })
  const url = new URL(authorizationEndpoint)
  // provider extras first: the protocol parameters below always win
  const params: Record<string, string> = {
    ...provider.authParams,
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scopes.join(' '),
    state,
    nonce,
    code_challenge: b64u(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  return { url: url.href, state }
}

/**
 * Finishes a login: the state must exist, be fresh, belong to `email` and to
 * this provider (single use either way). Exchanges the code, binds the
 * external identity (requireEmailMatch) and stores the tokens encrypted.
 */
export async function completeAuthorization({
  provider,
  email,
  state,
  code,
  vault,
  dbToken,
}: {
  provider: OAuthProvider
  email: string
  state: string
  code: string
  vault: TokenVault
  dbToken: string
}): Promise<{ email: string; idpEmailVerified: boolean; context: AuthContext | null }> {
  const entry = pending.get(state)
  pending.delete(state)
  if (!entry || Date.now() - entry.createdAt > STATE_TTL_MS) {
    throw new A2aError('oauth_failed', 'Login expirado ou já usado. Tente conectar de novo.', { reason: 'state_expired' })
  }
  if (entry.email !== String(email).toLowerCase() || entry.providerId !== provider.id) {
    throw new A2aError('oauth_failed', 'Este login foi iniciado por outra sessão. Tente conectar de novo.', { reason: 'state_mismatch' })
  }
  if (!code) throw new A2aError('oauth_failed', 'O provedor não devolveu o código de autorização.', { reason: 'no_code' })
  return exchangeAndBind({ provider, email, entry, code, vault, dbToken })
}

async function exchangeAndBind({
  provider,
  email,
  entry,
  code,
  vault,
  dbToken,
}: {
  provider: OAuthProvider
  email: string
  entry: PendingLogin
  code: string
  vault: TokenVault
  dbToken: string
}): Promise<{ email: string; idpEmailVerified: boolean; context: AuthContext | null }> {
  const tokens = await tokenRequest(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: entry.redirectUri,
    code_verifier: entry.verifier,
  })
  // every credential in scope from here on: redacted from any error, and no identity field may carry one
  const secrets = [tokens.access_token, tokens.refresh_token, tokens.id_token, provider.clientSecret, dbToken].filter((v): v is string => typeof v === 'string' && !!v)
  try {
    const identity = checkIdentity(await externalIdentity(provider, tokens, entry.nonce), secrets, provider)
    if (provider.requireEmailMatch && (!identity.email || !identity.emailVerified || identity.email !== entry.email)) {
      // the IdP's e-mail is not repeated: only the user's own Databricks one
      throw identity.email
        ? new A2aError('oauth_failed', `A conta usada no ${provider.name} não é a mesma do seu usuário Databricks (${entry.email}). Entre com a conta correta.`, {
            reason: 'email_mismatch',
          })
        : new A2aError('oauth_failed', `O ${provider.name} não informou um e-mail verificado; não foi possível confirmar que a conta é sua.`, {
            reason: 'email_unverified',
          })
    }
    // re-login: the same account as the stored row (legacy rows without a digest get one)
    if (await vault.subjectChanged(email, dbToken, provider.id, identity.subject)) throw subjectConflict(provider)
    // the IdP's e-mail was only scanned and compared: only the Databricks identity is stored and shown
    await vault.save(email, dbToken, provider.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      idToken: tokens.id_token || '',
      expiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000),
      scope: tokens.scope || provider.scopes.join(' '),
      idpEmailVerified: provider.requireEmailMatch,
      externalSubject: identity.subject,
    })
    return { email: entry.email, idpEmailVerified: provider.requireEmailMatch, context: entry.context || null }
  } catch (e) {
    // the grant is revoked whenever it can't be bound to this user; nothing was stored
    const revocation = await revokeToken(provider, tokens.refresh_token || tokens.access_token, tokens.refresh_token ? 'refresh_token' : 'access_token')
    let err = e instanceof A2aError ? e : new A2aError('oauth_failed', 'Não foi possível concluir o login.', { reason: 'internal' })
    if (!revocation.revoked) {
      // still rejected and still not stored — but the grant lives on at the IdP: the user is told to revoke it there
      const cause = String(err.reason || 'internal')
      logger.warn(`oauth login rejected (${cause}); grant not revoked at ${provider.id} (${revocation.reason || 'idp_rejected'})`)
      err = new A2aError(
        'oauth_failed',
        `O login no ${provider.name} foi recusado e o ${provider.name} não confirmou a revogação da autorização concedida. Remova o acesso do AI Prism nas permissões da sua conta ${provider.name}.`,
        { reason: 'grant_not_revoked', cause }
      )
    }
    err.message = redactSecrets(err.message, secrets)
    // the callback redacts with these too (not enumerable: never serialized)
    Object.defineProperty(err, 'secrets', { value: secrets, enumerable: false })
    throw err
  }
}

/** The context of a pending login started by `email` (without using it up); null for an unknown, expired or other user's state. */
export function peekAuthorization(state: unknown, email: unknown): AuthContext | null {
  const entry = pending.get(String(state || ''))
  if (!entry || Date.now() - entry.createdAt > STATE_TTL_MS || entry.email !== String(email || '').toLowerCase()) return null
  return entry.context || null
}

/** Drops a pending login (the IdP returned an error or the provider is gone). */
export function cancelAuthorization(state: unknown): void {
  if (state) pending.delete(String(state))
}

/** Pending logins in memory (tests). */
export function pendingLoginCount(): number {
  return pending.size
}

export interface Revocation {
  revoked: boolean
  reason: string | null
  httpStatus?: number
}

/**
 * Revokes `token` at the IdP (RFC 7009) with the provider's client
 * authentication. Never throws: reason is null | 'no_stored_token' |
 * 'no_revocation_endpoint' | 'idp_rejected' | 'idp_unreachable'.
 */
export async function revokeToken(provider: OAuthProvider, token: string | null | undefined, tokenTypeHint?: string): Promise<Revocation> {
  if (!token) return { revoked: false, reason: 'no_stored_token' }
  let revocationEndpoint: string
  try {
    ;({ revocationEndpoint } = await providerEndpoints(provider))
  } catch {
    return { revoked: false, reason: 'idp_unreachable' }
  }
  if (!revocationEndpoint) return { revoked: false, reason: 'no_revocation_endpoint' }
  const body = new URLSearchParams({ token })
  if (tokenTypeHint) body.set('token_type_hint', tokenTypeHint)
  const authorization = clientAuthentication(provider, body)
  try {
    const res = await idpFetch(revocationEndpoint, { authorization })(revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      maxBytes: 16 * 1024,
    })
    // RFC 7009 §2.2: 200 also covers a token that was already invalid
    return res.ok ? { revoked: true, reason: null } : { revoked: false, reason: 'idp_rejected', httpStatus: res.status }
  } catch {
    return { revoked: false, reason: 'idp_unreachable' }
  }
}

// ---- token vault ------------------------------------------------------------------

/** One stored (sealed) connection of a user to a provider. Only ciphertext for the tokens. */
export interface TokenRow {
  accessTokenEnc: string
  refreshTokenEnc: string | null
  idTokenEnc: string | null
  expiresAt: Date | string | null
  scope: string
  idpEmailVerified: boolean
  externalSubjectHmac: string
}
export interface TokenRowSummary extends TokenRow {
  providerId: string
  renewable?: boolean
}
/** Row store under the vault (server/db/a2a.ts in production, a Map in tests). */
export interface TokenStore {
  get(email: string, dbToken: string | null, providerId: string): Promise<TokenRow | null>
  put(email: string, dbToken: string | null, providerId: string, row: TokenRow): Promise<void>
  /** Updates only the row whose access_token_enc is `expectedAccessTokenEnc`; returns the rows updated (refresh). */
  updateIfMatches(email: string, dbToken: string | null, providerId: string, expectedAccessTokenEnc: string, row: TokenRow): Promise<number>
  remove(email: string, dbToken: string | null, providerId: string): Promise<void>
  list(email: string, dbToken: string | null): Promise<TokenRowSummary[]>
}
interface SaveTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  idTokenEnc?: string | null
  expiresAt: Date
  scope?: string
  idpEmailVerified?: boolean
  externalSubject?: string
  externalSubjectHmac?: string
}
export interface UserCredentials {
  accessToken: string
  idToken: string | null
  scope: string
}
export interface DisconnectResult {
  revoked: boolean
  removedLocally: boolean
  reason: string | null
}

export interface TokenVault {
  readonly enabled: boolean
  readonly disabledReason: string | null
  save(email: string, dbToken: string | null, providerId: string, t: SaveTokens): Promise<void>
  subjectChanged(email: string, dbToken: string | null, providerId: string, subject: string): Promise<boolean>
  credentials(email: string, dbToken: string | null, provider: OAuthProvider): Promise<UserCredentials>
  accessToken(email: string, dbToken: string | null, provider: OAuthProvider): Promise<string>
  secrets(email: string, dbToken: string | null, provider: OAuthProvider): Promise<string[]>
  disconnect(email: string, dbToken: string | null, provider: OAuthProvider, opts?: { force?: boolean }): Promise<DisconnectResult>
  connections(email: string, dbToken: string | null): Promise<Map<string, ConnectionInfo>>
}

/**
 * Encrypted per-(user, provider) token storage over a row store. Rows only
 * ever hold ciphertext for the access/refresh/ID tokens.
 * readbackDelaysMs: the waits before each read of the row after a refresh's
 * write failed (see refresh). disconnectWaitMs: how long a disconnect waits
 * for an in-flight refresh of the same (user, provider).
 */
export function createTokenVault({
  store,
  env = process.env,
  readbackDelaysMs = [250, 500, 1000],
  disconnectWaitMs = 3000,
}: {
  store: TokenStore
  env?: Env
  readbackDelaysMs?: number[]
  disconnectWaitMs?: number
}): TokenVault {
  const refreshing = new Map<string, Promise<UserCredentials>>() // flightKey → the in-flight refresh
  const flightKey = (email: string, providerId: string): string => `${String(email).toLowerCase()}\n${providerId}`
  const key = (): Buffer => {
    const k = encryptionKey(env)
    if (!k) throw new A2aError('oauth_disabled', oauthDisabledReason(env) || 'Login externo desabilitado.')
    return k
  }

  // The row a save writes. Each seal draws a fresh random IV, so its
  // access_token_enc is unique to this write: read back, it tells whether a
  // write whose answer was lost committed (see refresh).
  function sealedRow(email: string, providerId: string, t: SaveTokens): TokenRow {
    const k = key()
    return {
      accessTokenEnc: seal(k, t.accessToken, aadFor(email, providerId, 'access')),
      refreshTokenEnc: t.refreshToken ? seal(k, t.refreshToken, aadFor(email, providerId, 'refresh')) : null,
      // a refresh that brings no id_token keeps the stored ciphertext (t.idTokenEnc)
      idTokenEnc: t.idToken ? seal(k, t.idToken, aadFor(email, providerId, 'id')) : t.idTokenEnc || null,
      expiresAt: t.expiresAt,
      scope: t.scope || '',
      idpEmailVerified: !!t.idpEmailVerified,
      // never the subject itself (see subjectDigest)
      externalSubjectHmac: t.externalSubject ? subjectDigest(k, providerId, t.externalSubject) : t.externalSubjectHmac || '',
    }
  }

  async function save(email: string, dbToken: string | null, providerId: string, t: SaveTokens): Promise<void> {
    await store.put(email, dbToken, providerId, sealedRow(email, providerId, t))
  }

  // authState: why the user has no usable credential (see AUTH_REASONS in userAuth.ts)
  const expired = (provider: OAuthProvider, authState = 'expired'): A2aError =>
    new A2aError('auth_required', `Sua sessão no ${provider.name} expirou. Reautentique para continuar.`, { providerId: provider.id, authState })

  // the stored ID token in clear, or null when the row has none (or it fails to open)
  function openIdToken(k: Buffer, email: string, providerId: string, row: TokenRow): string | null {
    try {
      return row.idTokenEnc ? unseal(k, row.idTokenEnc, aadFor(email, providerId, 'id')) : null
    } catch {
      return null
    }
  }

  // The one path for a refresh answer that is rejected, before anything is
  // written (its id_token does not verify, carries no valid sub, or names
  // another account): the tokens that answer just issued are revoked (best
  // effort), the stored row is not touched, and the caller gets auth_required
  // with a fixed reason — grant_not_revoked when the IdP did not confirm
  // every revocation.
  async function rejectRefresh(provider: OAuthProvider, tokens: TokenResponse, e: unknown): Promise<A2aError> {
    const reason = (e as { reason?: string } | null)?.reason
    const cause = reason && ['identity_conflict', 'id_token_invalid', 'identity_invalid'].includes(reason) ? reason : 'internal'
    const issued = ([
      [tokens.refresh_token, 'refresh_token'],
      [tokens.access_token, 'access_token'],
    ] as [string | undefined, string][]).filter(([v]) => typeof v === 'string' && v)
    const results: Revocation[] = []
    for (const [token, hint] of issued) results.push(await revokeToken(provider, token, hint))
    const failed = results.find((r) => !r.revoked)
    if (failed || !results.length) {
      logger.warn(`oauth refresh rejected (${cause}); grant not revoked at ${provider.id} (${failed?.reason || 'no_stored_token'})`)
      return new A2aError(
        'auth_required',
        `A renovação do login no ${provider.name} não foi concluída e o ${provider.name} não confirmou a revogação da autorização. Remova o acesso do AI Prism nas permissões da sua conta ${provider.name}.`,
        { providerId: provider.id, reason: 'grant_not_revoked', cause }
      )
    }
    logger.warn(`oauth refresh rejected at ${provider.id} (${cause}); the tokens it issued were revoked`)
    const message =
      cause === 'identity_conflict'
        ? `A conta do ${provider.name} mudou desde a conexão; desconecte e conecte de novo.`
        : cause === 'internal'
          ? `Não foi possível confirmar a renovação do login no ${provider.name}; reautentique para continuar.`
          : `O ${provider.name} devolveu dados de conta inválidos na renovação do login; reautentique para continuar.`
    return new A2aError('auth_required', message, { providerId: provider.id, reason: cause })
  }

  // The row as stored now, read up to readbackDelaysMs.length times (after each
  // wait); null when no read answered.
  async function readBack(email: string, dbToken: string | null, providerId: string): Promise<{ row: TokenRow | null } | null> {
    for (const ms of readbackDelaysMs) {
      await new Promise((resolve) => setTimeout(resolve, ms))
      try {
        return { row: await store.get(email, dbToken, providerId) }
      } catch {
        /* the next attempt, if any */
      }
    }
    return null
  }

  // a stored token that does not open for this identity (another user's row, a
  // rotated key): no credential, the user authorizes again
  function openToken(k: Buffer, email: string, provider: OAuthProvider, sealed: string, field: string): string {
    try {
      return unseal(k, sealed, aadFor(email, provider.id, field))
    } catch {
      throw new A2aError('auth_required', `Conecte sua conta ${provider.name} de novo para usar este agente.`, { providerId: provider.id, authState: 'missing' })
    }
  }

  async function refresh(email: string, dbToken: string | null, provider: OAuthProvider, row: TokenRow, k: Buffer): Promise<UserCredentials> {
    const refreshToken = openToken(k, email, provider, row.refreshTokenEnc as string, 'refresh')
    let t: TokenResponse
    try {
      t = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken })
    } catch (e) {
      // a refresh token the IdP no longer honors is useless: forget it
      const status = (e as { httpStatus?: number } | null)?.httpStatus
      if (status === 400 || status === 401) {
        await store.remove(email, dbToken, provider.id).catch(() => {})
        throw expired(provider, 'revoked')
      }
      throw expired(provider)
    }
    // from here the IdP has issued new tokens: any rejection goes through rejectRefresh.
    // A refreshed id_token names the subject again: it must be the one the row is
    // bound to (an empty digest, from a row stored before digests, is filled)
    let subjectHmac = row.externalSubjectHmac || ''
    try {
      const sub = t.id_token ? await refreshedSubject(provider, t.id_token) : null
      if (sub !== null) {
        const digest = subjectDigest(k, provider.id, sub)
        if (subjectHmac && !sameDigest(subjectHmac, digest)) throw subjectConflict(provider)
        subjectHmac = digest
      }
    } catch (e) {
      throw await rejectRefresh(provider, t, e)
    }
    const next: SaveTokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || refreshToken,
      idToken: t.id_token || '',
      idTokenEnc: row.idTokenEnc || null,
      expiresAt: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000),
      scope: t.scope || row.scope,
      idpEmailVerified: row.idpEmailVerified,
      externalSubjectHmac: subjectHmac,
    }
    // The write is fenced: it only updates the row read above (its
    // access_token_enc), never inserts, so a late write after a disconnect, or
    // after another writer, matches nothing and can't bring a row back
    let written: TokenRow | null = null
    let updated: number
    try {
      written = sealedRow(email, provider.id, next)
      updated = await store.updateIfMatches(email, dbToken, provider.id, row.accessTokenEnc, written)
    } catch {
      // A failed write never revokes: it may still commit after any read. The row
      // is read back only to tell "committed" (its access_token_enc is unique to
      // this write) from "unknown". Unknown → the plaintext tokens are dropped.
      const stored = written ? await readBack(email, dbToken, provider.id) : null
      if (!written || stored?.row?.accessTokenEnc !== written.accessTokenEnc) {
        logger.warn(`a2a_refresh_outcome_unknown at ${provider.id}`)
        throw new A2aError('auth_required', `Não foi possível confirmar se a renovação do login no ${provider.name} foi salva; tente de novo e, se necessário, conecte de novo.`, {
          providerId: provider.id,
          reason: 'save_failed',
          cause: 'outcome_unknown',
        })
      }
      logger.warn(`a2a_refresh_save_ack_lost at ${provider.id}: the write committed; the refreshed tokens are kept`)
      updated = 1
    }
    if (updated !== 1) {
      // the row was removed (disconnect) or replaced (another writer): known not written
      logger.warn(`a2a_refresh_row_changed at ${provider.id}`)
      throw new A2aError('auth_required', `A conexão com o ${provider.name} mudou durante a renovação do login; conecte de novo.`, {
        providerId: provider.id,
        reason: 'save_failed',
        cause: 'row_changed',
      })
    }
    return { accessToken: next.accessToken, idToken: next.idToken || openIdToken(k, email, provider.id, row), scope: next.scope || '' }
  }

  // auth_required for an id-token destination whose row has no usable ID token
  const idTokenIssue = (provider: OAuthProvider, idToken: string | null): A2aError | null => {
    if (!idToken) {
      return new A2aError('auth_required', `Reconecte com o ${provider.name}: a conexão atual não tem o ID token que o destino exige.`, {
        providerId: provider.id,
        reason: 'id_token_missing',
      })
    }
    if (idTokenExpired(idToken)) {
      return new A2aError('auth_required', `O ID token do ${provider.name} expirou e o ${provider.name} não o renovou. Reconecte com o ${provider.name}.`, {
        providerId: provider.id,
        reason: 'id_token_expired',
      })
    }
    return null
  }
  const wantsIdToken = (provider: OAuthProvider): boolean => provider.hostPatterns.some((p) => p.send === SEND_ID_TOKEN)

  /**
   * The user's credentials for `provider`: { accessToken, idToken } (idToken
   * null when the row has none), refreshed when the access token is near
   * expiry — or, for a provider with an id-token destination, when the ID token is.
   */
  async function credentials(email: string, dbToken: string | null, provider: OAuthProvider): Promise<UserCredentials> {
    assertUserCredentialsAllowed(`O agente A2A (${provider.name})`, (code, message) => new A2aError(code, message))
    const k = key()
    const row = await store.get(email, dbToken, provider.id)
    if (!row) throw new A2aError('auth_required', `Conecte sua conta ${provider.name} para usar este agente.`, { providerId: provider.id, authState: 'missing' })
    const exp = row.expiresAt ? new Date(row.expiresAt).getTime() : 0
    const storedIdToken = openIdToken(k, email, provider.id, row)
    const stale = exp - 60_000 <= Date.now() || (wantsIdToken(provider) && !!storedIdToken && idTokenExpired(storedIdToken))
    let current: UserCredentials
    if (!stale) current = { accessToken: openToken(k, email, provider, row.accessTokenEnc, 'access'), idToken: storedIdToken, scope: row.scope || '' }
    else {
      // no refresh token: an id-token provider reports the ID token's own problem over the generic expiry
      if (!row.refreshTokenEnc) throw (wantsIdToken(provider) && idTokenIssue(provider, storedIdToken)) || expired(provider)
      const flight = flightKey(email, provider.id)
      if (!refreshing.has(flight)) {
        refreshing.set(flight, refresh(email, dbToken, provider, row, k).finally(() => refreshing.delete(flight)))
      }
      current = await (refreshing.get(flight) as Promise<UserCredentials>)
    }
    return current
  }

  return {
    get enabled() {
      return !oauthDisabledReason(env)
    },
    get disabledReason() {
      return oauthDisabledReason(env)
    },
    save,
    /** True when (email, provider) is stored bound to another subject (an empty, legacy digest is not a conflict). */
    async subjectChanged(email, dbToken, providerId, subject) {
      const row = await store.get(email, dbToken, providerId)
      return !!row?.externalSubjectHmac && !sameDigest(row.externalSubjectHmac, subjectDigest(key(), providerId, subject))
    },
    credentials,
    /** A valid access token for the user (see credentials); A2aError('auth_required') otherwise. */
    async accessToken(email, dbToken, provider) {
      return (await credentials(email, dbToken, provider)).accessToken
    },
    /** The user's stored access, refresh and ID tokens (decrypted), for exact redaction only. */
    async secrets(email, dbToken, provider) {
      assertUserCredentialsAllowed(`O agente A2A (${provider.name})`, (code, message) => new A2aError(code, message))
      const row = await store.get(email, dbToken, provider.id)
      if (!row) return []
      const k = key()
      const open = (sealed: string | null, kind: string): string | null => {
        try {
          return sealed ? unseal(k, sealed, aadFor(email, provider.id, kind)) : null
        } catch {
          return null
        }
      }
      return [open(row.accessTokenEnc, 'access'), open(row.refreshTokenEnc, 'refresh'), open(row.idTokenEnc, 'id')].filter((v): v is string => !!v)
    },
    /**
     * Revokes the grant at the IdP (the refresh token when there is one).
     * The stored tokens are deleted when the revocation succeeds or the
     * provider has no revocation endpoint; when the IdP refuses or can't be
     * reached (or the row can't be decrypted) they are KEPT so the revocation
     * can be retried. `force` deletes them locally without revoking.
     */
    async disconnect(email, dbToken, provider, { force = false } = {}) {
      // an in-flight refresh is waited for (up to disconnectWaitMs), so the row
      // read here, and revoked below, is the one it left; past the wait the
      // disconnect goes on (the refresh's write is fenced and can't recreate the row)
      const inFlight = refreshing.get(flightKey(email, provider.id))
      if (inFlight) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([inFlight.catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, disconnectWaitMs)))])
        clearTimeout(timer)
      }
      const row = await store.get(email, dbToken, provider.id)
      if (!row) return { revoked: false, removedLocally: true, reason: 'no_stored_token' }
      const removeLocally = async (revoked: boolean, reason: string | null): Promise<DisconnectResult> => {
        await store.remove(email, dbToken, provider.id)
        return { revoked, removedLocally: true, reason }
      }
      if (force) return removeLocally(false, 'local_only')
      let token: string
      let hint = 'access_token'
      try {
        const k = key()
        if (row.refreshTokenEnc) {
          token = unseal(k, row.refreshTokenEnc, aadFor(email, provider.id, 'refresh'))
          hint = 'refresh_token'
        } else token = unseal(k, row.accessTokenEnc, aadFor(email, provider.id, 'access'))
      } catch {
        return { revoked: false, removedLocally: false, reason: 'unreadable_token' }
      }
      const result = await revokeToken(provider, token, hint)
      if (result.revoked) return removeLocally(true, null)
      if (result.reason === 'no_revocation_endpoint') return removeLocally(false, 'no_revocation_endpoint')
      return { revoked: false, removedLocally: false, reason: result.reason || 'idp_rejected' }
    },
    /** Connection state per provider for the UI — never token material, nor anything the IdP sent. */
    async connections(email, dbToken) {
      const rows = await store.list(email, dbToken)
      return new Map(
        rows.map((r) => [
          r.providerId,
          { idpEmailVerified: r.idpEmailVerified === true, expiresAt: r.expiresAt || null, scope: r.scope || '', renewable: r.renewable !== false && !!r.refreshTokenEnc },
        ])
      )
    },
  }
}

// ---- strategy selection ----------------------------------------------------------------

const DATABRICKS_OIDC_PATH = /\/oidc(\/|$)/

export interface CardScheme {
  name: string
  kind: 'bearer' | 'http-other' | 'oauth2' | 'oidc' | 'apiKey' | 'mtls' | null
  urls: string[]
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

export function cardSchemes(card: unknown): CardScheme[] {
  const out: CardScheme[] = []
  const schemes = obj(obj(card)?.securitySchemes) || {}
  for (const [name, rawScheme] of Object.entries(schemes)) {
    let raw = obj(rawScheme)
    if (!raw) continue
    // the SDK's in-memory form of the oneof (`scheme: { $case, value }`) is served as is by some agents built on it
    const wrapped = obj(raw.scheme)
    if (wrapped && typeof wrapped.$case === 'string' && obj(wrapped.value)) raw = { [wrapped.$case]: wrapped.value }
    let kind: CardScheme['kind'] = null
    const urls: string[] = []
    // A2A 1.0 (ProtoJSON oneof field) or 0.3 (`type` discriminator)
    const http = obj(raw.httpAuthSecurityScheme) || (raw.type === 'http' ? raw : null)
    const oauth = obj(raw.oauth2SecurityScheme) || (raw.type === 'oauth2' ? raw : null)
    const oidc = obj(raw.openIdConnectSecurityScheme) || (raw.type === 'openIdConnect' ? raw : null)
    if (http) kind = /^bearer$/i.test(String(http.scheme || '')) ? 'bearer' : 'http-other'
    else if (oauth) {
      kind = 'oauth2'
      const flows = obj(oauth.flows) || {}
      for (const f of Object.values(flows)) {
        const flow = obj(f)
        if (!flow) continue
        for (const k of ['authorizationUrl', 'tokenUrl', 'deviceAuthorizationUrl']) if (typeof flow[k] === 'string' && flow[k]) urls.push(flow[k] as string)
        // ProtoJSON nests the flow one level deeper
        for (const inner of Object.values(flow)) {
          const o = obj(inner)
          if (o) for (const k of ['authorizationUrl', 'tokenUrl']) if (typeof o[k] === 'string' && o[k]) urls.push(o[k] as string)
        }
      }
      if (typeof oauth.oauth2MetadataUrl === 'string' && oauth.oauth2MetadataUrl) urls.push(oauth.oauth2MetadataUrl)
    } else if (oidc) {
      kind = 'oidc'
      if (typeof oidc.openIdConnectUrl === 'string' && oidc.openIdConnectUrl) urls.push(oidc.openIdConnectUrl)
    } else if (raw.apiKeySecurityScheme || raw.type === 'apiKey') kind = 'apiKey'
    else if (raw.mtlsSecurityScheme || raw.type === 'mutualTLS') kind = 'mtls'
    out.push({ name, kind, urls })
  }
  return out
}

function sameEndpoint(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && trimSlash(x.pathname) === trimSlash(y.pathname)
  } catch {
    return false
  }
}

function issuerOf(url: string): string {
  return trimSlash(String(url).replace(/\/\.well-known\/(openid-configuration|oauth-authorization-server)\/?$/, ''))
}

function schemeMatchesProvider(scheme: CardScheme, provider: OAuthProvider): boolean {
  if (scheme.kind !== 'oauth2' && scheme.kind !== 'oidc') return false
  const endpoints = [provider.authorizationEndpoint, provider.tokenEndpoint].filter(Boolean)
  return scheme.urls.some((u) => (provider.issuer && issuerOf(u) === provider.issuer) || endpoints.some((e) => sameEndpoint(u, e)))
}

function isDatabricksIdpUrl(u: string, cfg: A2aConfig): boolean {
  try {
    const url = new URL(u)
    return isDatabricksUrl(url, cfg) && (DATABRICKS_OIDC_PATH.test(url.pathname) || url.hostname === cfg.workspaceHost)
  } catch {
    return false
  }
}

/** Whether a host is one the admin allowed for an agent that takes NO credential (plain entry of A2A_ALLOWED_HOSTS). */
export function isPublicAgentUrl(url: string | URL, cfg: A2aConfig = a2aConfig()): boolean {
  return cfg.publicPatterns.some((p) => urlMatchesPattern(url, p))
}

/**
 * Which strategy may call an agent at `url`, from the URL alone — decides the
 * credential (if any) used to fetch its card. A host that is neither this
 * workspace, covered by a provider nor allowed for public agents throws
 * unsupported_auth: nothing is fetched.
 */
export function strategyForUrl(
  url: string | URL,
  { cfg = a2aConfig(), providers = usableProviders() }: { cfg?: A2aConfig; providers?: OAuthProvider[] } = {}
): { strategy: Strategy; providers?: OAuthProvider[] } {
  const matching = providers.filter((p) => providerMatchesUrl(p, url))
  if (matching.length) return { strategy: STRATEGY_OAUTH, providers: matching }
  if (isDatabricksUrl(url, cfg)) return { strategy: STRATEGY_OBO }
  if (isPublicAgentUrl(url, cfg)) return { strategy: STRATEGY_NONE }
  throw new A2aError(
    'unsupported_auth',
    `O host ${new URL(url).host} não pertence a este workspace Databricks, nenhum provedor OAuth configurado o cobre (A2A_OAUTH_PROVIDERS) e ele não está em A2A_ALLOWED_HOSTS.`
  )
}

// The card's security requirements as a list of sets; each set is a list of
// alternatives and an alternative is a list of scheme names that must ALL be
// presented. Card-level requirements (1.0 `securityRequirements`, 0.3
// `security`) form one set and every skill's own requirements another: all
// sets must be met. A card without card-level requirements accepts any one of
// its declared schemes. An empty alternative ("anonymous") does not count.
function requirementNames(r: unknown): string[] {
  const o = obj(r)
  if (!o) return []
  return Object.keys(obj(o.schemes) || o)
}

function requirementList(holder: unknown): string[][] {
  const h = obj(holder)
  const raw = [h?.securityRequirements, h?.security].find((v): v is unknown[] => Array.isArray(v) && v.length > 0) || []
  return raw.map(requirementNames).filter((names) => names.length)
}

export function cardRequirementSets(card: unknown, schemes: CardScheme[] = cardSchemes(card)): string[][][] {
  const top = requirementList(card)
  const sets: string[][][] = [top.length ? top : schemes.map((s) => [s.name])]
  const skills = obj(card)?.skills
  for (const skill of Array.isArray(skills) ? skills : []) {
    const own = requirementList(skill)
    if (own.length) sets.push(own)
  }
  return sets
}

function requirementsMet(sets: string[][][], schemes: CardScheme[], accepts: (s: CardScheme) => boolean): boolean {
  const byName = new Map(schemes.map((s) => [s.name, s]))
  return sets.every((alternatives) => alternatives.some((names) => names.every((n) => byName.has(n) && accepts(byName.get(n) as CardScheme))))
}

// what the user's Databricks token can present: a bearer, or the workspace's own OIDC
const oboAccepts = (cfg: A2aConfig) => (s: CardScheme) => s.kind === 'bearer' || ((s.kind === 'oauth2' || s.kind === 'oidc') && s.urls.some((u) => isDatabricksIdpUrl(u, cfg)))
// what a token from `provider` can present: a bearer, or that provider's own scheme
const providerAccepts = (provider: OAuthProvider) => (s: CardScheme) => s.kind === 'bearer' || schemeMatchesProvider(s, provider)

export interface Selection {
  strategy: Strategy
  providerId?: string
}

/**
 * Final strategy for an agent once its card is known: the strategy whose
 * credential meets the card's effective requirements (cardRequirementSets) —
 * a provider whose hostPatterns cover the host, else databricks-obo on this
 * workspace's hosts, else `none` for an allowed public host whose card asks for
 * no authentication. Throws unsupported_auth.
 */
export function selectStrategy({
  url,
  card,
  cfg = a2aConfig(),
  providers = usableProviders(),
}: {
  url: string | URL
  card: unknown
  cfg?: A2aConfig
  providers?: OAuthProvider[]
}): Selection {
  const schemes = cardSchemes(card)
  const sets = cardRequirementSets(card, schemes)
  const host = new URL(url).host
  const byHost = providers.filter((p) => providerMatchesUrl(p, url))
  if (byHost.length) {
    const fits = byHost.filter((p) => requirementsMet(sets, schemes, providerAccepts(p)))
    // several providers cover the host: the one the card names wins
    const preferred = fits.find((p) => schemes.some((s) => schemeMatchesProvider(s, p))) || fits[0]
    if (preferred) return { strategy: STRATEGY_OAUTH, providerId: preferred.id }
    throw new A2aError('unsupported_auth', `O card exige uma autenticação que o login no ${(byHost[0] as OAuthProvider).name} não atende (outro provedor de identidade ou esquema não suportado).`)
  }
  const databricks = isDatabricksUrl(url, cfg)
  if (databricks && requirementsMet(sets, schemes, oboAccepts(cfg))) return { strategy: STRATEGY_OBO }
  const named = providers.find((p) => schemes.some((s) => schemeMatchesProvider(s, p)))
  if (named) throw new A2aError('unsupported_auth', `O agente exige login no ${named.name}, mas o host ${host} não está nos hostPatterns desse provedor.`)
  if (databricks) {
    const external = schemes.some((s) => (s.kind === 'oauth2' || s.kind === 'oidc') && !oboAccepts(cfg)(s))
    throw new A2aError(
      'unsupported_auth',
      external
        ? 'O agente exige login em um provedor de identidade externo que não está configurado; o token Databricks não é enviado a ele.'
        : 'O card não declara um esquema de autenticação bearer/OAuth2/OpenID Connect compatível.'
    )
  }
  if (isPublicAgentUrl(url, cfg)) {
    // a public agent: the card must ask for no credential at all (an agent that wants one cannot be called with none)
    const requiresAuth = schemes.length > 0 && (sets[0] as string[][]).every((alt) => alt.length > 0)
    if (!requiresAuth) return { strategy: STRATEGY_NONE }
    throw new A2aError('unsupported_auth', `O card de ${host} exige autenticação; um agente público (sem credencial) não pode ser chamado.`)
  }
  throw new A2aError('unsupported_auth', `Nenhuma estratégia de autenticação cobre o host ${host}.`)
}

/** The credential of one call: what to attach, where it may go, and every secret in scope (for redaction). */
export interface Credential {
  token: string | null
  allowUrl: (u: URL) => boolean
  strategy: Strategy
  provider: OAuthProvider | null
  secrets: string[]
  frontDoor: { idToken?: string | null; header?: string } | null
  route?: ((url: URL) => { token: string | null; frontDoorIdToken: string | null }) | null
}

/** The slice of an agent row the credential needs. */
export interface AgentAuthFields {
  authStrategy: string
  authProvider?: string | null
  cardUrl: string
}

/**
 * The credential for one call to `agent`. `databricksToken` is the request's OBO
 * token; oauth2-user reads the vault; `none` carries nothing and may only reach
 * the agent's own origin. `secrets` lists every credential in scope for the
 * request, redacted exactly from anything the agent sends back. Fails closed:
 * no token → A2aError, never a fallback credential.
 */
export async function resolveCredential({
  agent,
  databricksToken,
  email,
  dbToken,
  vault,
  cfg = a2aConfig(),
  env = process.env,
}: {
  agent: AgentAuthFields
  databricksToken: string | null | undefined
  email: string
  dbToken: string | null
  vault?: TokenVault
  cfg?: A2aConfig
  env?: Env
}): Promise<Credential> {
  if (agent.authStrategy === STRATEGY_OBO) {
    if (!databricksToken) throw new A2aError('no_token', 'Sem token Databricks do usuário; a chamada não foi feita.')
    return { token: databricksToken, allowUrl: (u) => isDatabricksUrl(u, cfg), strategy: STRATEGY_OBO, provider: null, secrets: [databricksToken], frontDoor: null }
  }
  if (agent.authStrategy === STRATEGY_NONE) {
    const origin = new URL(agent.cardUrl).origin
    return { token: null, allowUrl: (u) => u.origin === origin, strategy: STRATEGY_NONE, provider: null, secrets: databricksToken ? [databricksToken] : [], frontDoor: null }
  }
  if (agent.authStrategy === STRATEGY_OAUTH) {
    const provider = providerById(agent.authProvider, env)
    if (!provider) throw new A2aError('unsupported_auth', `O provedor "${agent.authProvider}" não está mais configurado.`)
    if (!vault?.enabled) throw new A2aError('oauth_disabled', oauthDisabledReason(env) || 'Login externo desabilitado.')
    const { accessToken: token, idToken, scope } = await vault.credentials(email, dbToken, provider)
    const stored = await vault.secrets(email, dbToken, provider).catch(() => [] as string[])
    const secrets = [...new Set([token, idToken, ...stored, provider.clientSecret, databricksToken].filter((v): v is string => !!v))]
    return {
      token,
      allowUrl: (u) => providerMatchesUrl(provider, u),
      strategy: STRATEGY_OAUTH,
      provider,
      secrets,
      frontDoor: provider.idTokenHeader ? { idToken, header: provider.idTokenHeader } : null,
      route: destinationRoute(provider, { accessToken: token, idToken, scope }),
    }
  }
  throw new A2aError('unsupported_auth', 'Agente sem estratégia de autenticação.')
}

/**
 * Per-request credential of an oauth2-user login, chosen by the destination
 * (destinationFor): `id-token` → the ID token as the bearer, and also in the
 * provider's `idTokenHeader` when it names one; `access-token` → the access
 * token, refused before any request (auth_required, reason insufficient_scope)
 * when the stored login lacks a scope the provider asks for. A URL no
 * hostPattern covers gets nothing.
 */
export function destinationRoute(provider: OAuthProvider, { accessToken, idToken, scope }: { accessToken: string; idToken: string | null; scope: string }) {
  return (url: URL): { token: string | null; frontDoorIdToken: string | null } => {
    const send = destinationFor(provider, url)
    if (send === SEND_ID_TOKEN) {
      if (!idToken) {
        throw new A2aError('auth_required', `Reconecte com o ${provider.name}: a conexão atual não tem o ID token que este destino exige.`, {
          providerId: provider.id,
          reason: 'id_token_missing',
        })
      }
      if (idTokenExpired(idToken)) {
        throw new A2aError('auth_required', `O ID token do ${provider.name} expirou. Reconecte com o ${provider.name}.`, { providerId: provider.id, reason: 'id_token_expired' })
      }
      return { token: idToken, frontDoorIdToken: provider.idTokenHeader ? idToken : null }
    }
    if (send === SEND_ACCESS_TOKEN) {
      if (missingScopes(scope, requiredApiScopes(provider)).length) {
        throw new A2aError('auth_required', `A sua conexão com o ${provider.name} não inclui a permissão que este agente exige; autorize de novo.`, {
          providerId: provider.id,
          reason: 'insufficient_scope',
        })
      }
      return { token: accessToken, frontDoorIdToken: null }
    }
    throw new A2aError('blocked_url', `Nenhum destino de ${provider.name} cobre ${new URL(url).host}; nada foi enviado.`)
  }
}

export function safeMessage(e: unknown, secrets: unknown[] = []): string {
  const msg = (e as { message?: unknown } | null)?.message
  return redactSecrets(msg ?? String(e), secrets).slice(0, 400)
}
