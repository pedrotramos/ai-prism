// A2A agents (Settings → Agentes A2A, "Minhas conexões") and the delegated OAuth login for external identity
// providers. Every route runs behind the app's auth middleware; the catalog routes (register, verify, enable, remove,
// provider setup) also run behind `requireAdmin`. The catalog holds only what the agent's host serves WITHOUT a
// credential (the public card, or nothing when the host requires one) plus the configuration check's outcome:
// registering and checking never send the admin's credential. Each user's calls (and the card read for their tool) use
// that user's own credential.
//
//   GET    /api/a2a/agents                        the enabled catalog with this user's own state (admins: also the disabled ones)
//   POST   /api/a2a/agents                  admin register by card URL or Databricks App name
//   POST   /api/a2a/agents/:id/verify       admin the configuration check again (anonymous)
//   PUT    /api/a2a/agents/:id/enabled      admin offered to users or not
//   DELETE /api/a2a/agents/:id              admin
//   POST   /api/a2a/agents/:id/check              THIS user's check: their own credential against the agent's card
//   GET    /api/a2a/providers                     this user's connection per OAuth provider
//   GET    /api/admin/a2a/providers         admin the providers' configuration (errors, the redirect URI to register at the IdP)
//   GET    /api/a2a/oauth/:provider/start         the authorization-code + PKCE login (a popup)
//   GET    /api/a2a/oauth/:provider/callback      the IdP's redirect back
//   DELETE /api/a2a/oauth/:provider               disconnect (revokes at the IdP, then deletes the sealed tokens)
import { authed } from './authed.ts'
import type { Express, Request, RequestHandler, Response } from 'express'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.ts'
import { ensureReady as realEnsureReady } from '../middleware/ensureReady.ts'
import { A2aError, a2aConfig, checkUrl, createGuardedFetch, createGuardedFetch as makeFetch, isDatabricksUrl } from '../a2aGuard.ts'
import type { A2aConfig } from '../a2aGuard.ts'
import {
  STRATEGY_NONE,
  STRATEGY_OAUTH,
  STRATEGY_OBO,
  beginAuthorization,
  cancelAuthorization,
  completeAuthorization,
  connectionState,
  isPublicAgentUrl,
  loadProviders,
  oauthDisabledReason,
  oauthErrorCode,
  peekAuthorization,
  providerById,
  providerMatchesUrl,
  resolveCredential,
  safeMessage,
  selectStrategy,
  strategyForUrl,
  usableProviders,
} from '../a2aAuth.ts'
import type { ConnectionInfo, OAuthProvider, Strategy } from '../a2aAuth.ts'
import {
  AUTH_CHANGED,
  a2aToolName,
  checkUserAccess,
  defaultA2aDeps,
  fetchAgentCard,
  forgetObservedStatuses,
  forgetUserCards,
  observedStatus,
  recordCallStatus,
  uniqueSlug,
  validateAgentCard,
} from '../a2aClient.ts'
import type { A2aDeps } from '../a2aClient.ts'
import { createA2aAgent, deleteA2aAgent, updateA2aCatalogEntry } from '../db/a2a.ts'
import type { A2aAgentRow, CardSummary, CatalogPatch, ConfigStatus, NewA2aAgent } from '../db/a2a.ts'
import { logger } from '../log.ts'
import { isAdmin as realIsAdmin } from '../authz.ts'

const HTTP_BY_CODE: Record<string, number> = {
  no_token: 401,
  auth_required: 401,
  no_access: 403,
  invalid_card: 422,
  unsupported_auth: 422,
  blocked_url: 422,
  oauth_disabled: 503,
  oauth_failed: 400,
  unavailable: 502,
  timeout: 504,
  not_found: 404,
  duplicate: 409,
  bad_request: 400,
}

function sendError(res: Response, e: unknown, secrets: unknown[] = []): void {
  const err = e as (A2aError & { providerId?: string }) | null
  const code = e instanceof A2aError ? e.code : 'internal'
  // an unexpected error is logged with its cause and answered with a fixed code (a connection error can carry host and port)
  if (!(e instanceof A2aError)) logger.warn('a2a route failed', { err: e })
  const body: Record<string, unknown> = { error: e instanceof A2aError ? safeMessage(e, secrets) : 'internal_error', code }
  // a fixed reason code only (e.g. front_door_forbidden), never free text
  if (typeof err?.reason === 'string' && /^[a-z_]{1,32}$/.test(err.reason)) body.reason = err.reason
  if (err?.providerId) {
    body.providerId = err.providerId
    body.providerName = providerById(err.providerId)?.name || err.providerId
  }
  res.status(HTTP_BY_CODE[code] || 500).json(body)
}

export interface AgentForClient {
  id: string
  slug: string
  toolName: string
  displayName: string
  cardUrl: string
  appName: string
  authStrategy: string
  authProvider: string | null
  authProviderName: string | null
  enabled: boolean
  status: string
  lastError: string
  lastCheckedAt: string | null
  cardPublic: boolean
  card: { description: string; version: string; provider: string; streaming: boolean; skills: { id: string; name: string; description: string; tags: string[] }[] }
  addedBy?: string | null
  configStatus?: string
  configError?: string
  configCheckedAt?: string | null
}

/** The agent as the client sees it. `admin`: the catalog's own fields (the configuration check and its error), never sent to other users. */
export function shapeAgentForClient(agent: A2aAgentRow, { admin = false, status = 'unknown', lastError = '', lastCheckedAt = null }: { admin?: boolean; status?: string; lastError?: string; lastCheckedAt?: string | null } = {}): AgentForClient {
  const provider = agent.authProvider ? providerById(agent.authProvider) : null
  const card = agent.card || {}
  const out: AgentForClient = {
    id: agent.id,
    slug: agent.slug,
    toolName: a2aToolName(agent.slug),
    displayName: agent.displayName,
    cardUrl: agent.cardUrl,
    appName: agent.appName || '',
    authStrategy: agent.authStrategy,
    authProvider: agent.authProvider || null,
    authProviderName: provider?.name || agent.authProvider || null,
    enabled: agent.enabled !== false,
    status,
    lastError,
    lastCheckedAt,
    cardPublic: agent.cardPublic === true,
    card: {
      description: card.description || '',
      version: card.version || '',
      provider: card.provider || '',
      streaming: !!card.streaming,
      skills: (card.skills || []).map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags || [] })),
    },
  }
  if (admin) {
    out.addedBy = agent.addedByHash ? 'admin' : null
    out.configStatus = agent.configStatus
    out.configError = agent.configError || ''
    out.configCheckedAt = agent.configCheckedAt
  }
  return out
}

// Statuses of an oauth2-user agent that say something beyond the login itself.
const NON_LOGIN_STATUSES = new Set(['no_access', 'unavailable', 'invalid_card'])

/**
 * An agent's status for THIS user. An oauth2-user agent comes from the same
 * source as "Minhas conexões": the user's own login for its provider against
 * what the agent's destination needs. A provider that is not configured
 * (removed, or rejected at load) makes it unavailable. Without a usable login
 * it is auth_required; with one, a finding the last call made beyond the login
 * (no_access, unavailable, invalid_card) stays, anything else is connected.
 */
export function userAgentStatus(agent: A2aAgentRow, seen: { status: string } | null, tokens: Map<string, ConnectionInfo>): string {
  if (agent.authStrategy !== STRATEGY_OAUTH) return seen?.status || 'unknown'
  const provider = providerById(agent.authProvider)
  if (!provider) return 'unavailable'
  if (connectionState(provider, tokens.get(provider.id), agent.cardUrl) !== 'connected') return 'auth_required'
  return seen && NON_LOGIN_STATUSES.has(seen.status) ? seen.status : 'connected'
}

function requestOrigin(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]!.trim()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0]!.trim()
  return `${proto}://${host}`
}

/** The OAuth redirect URI to register with the IdP: <app origin>/api/a2a/oauth/<provider>/callback. */
export function oauthRedirectUri(req: Request, providerId: string, env: Record<string, string | undefined> = process.env): string {
  const base = String(env.A2A_OAUTH_REDIRECT_BASE || env.DATABRICKS_APP_URL || '').replace(/\/+$/, '') || requestOrigin(req)
  return `${base}/api/a2a/oauth/${providerId}/callback`
}

const fixedCode = (c: unknown): string | null => (typeof c === 'string' && /^[a-z_]{1,32}$/.test(c) ? c : null)

// Popup landing page: tells the opener (same origin only) how the login ended and closes.
// `reason` is a fixed code the client localizes (`cause`: the rejection behind grant_not_revoked); `message` never carries IdP claims.
function callbackPage(res: Response, { providerId, ok, message, reason = null, cause = null, idpEmailVerified = false }: { providerId: string; ok: boolean; message: string; reason?: string | null; cause?: string | null; idpEmailVerified?: boolean }): void {
  const code = fixedCode(reason) || (ok ? null : 'internal')
  const payload = JSON.stringify({ type: 'a2a-oauth', provider: providerId, ok, error: ok ? '' : message, reason: code, cause: fixedCode(cause), idpEmailVerified: ok && idpEmailVerified === true }).replace(/</g, '\\u003c')
  const text = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  res.status(ok ? 200 : 400).send(`<!doctype html><html><head><meta charset="utf-8"><title>AI Prism</title></head>
<body style="font-family:Inter,system-ui,sans-serif;padding:24px;background:#0b0d0f;color:#e8eaed"><p>${text}</p>
<script>(function(){var d=${payload};try{if(window.opener){window.opener.postMessage(d,window.location.origin)}}catch(e){}
setTimeout(function(){window.close()},${ok ? 400 : 5000})})()</script></body></html>`)
}

const callbackReason = (e: unknown): string => {
  const err = e as { reason?: string; code?: string } | null
  return err?.reason || (err?.code === 'oauth_disabled' ? 'oauth_disabled' : 'internal')
}

async function cardUrlFromApp(token: string, appName: string, cardPath: string, cfg: A2aConfig): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(appName)) throw new A2aError('bad_request', 'Nome de App inválido.')
  if (!cfg.workspaceHost) throw new A2aError('bad_request', 'DATABRICKS_HOST não configurado; informe a URL do Agent Card.')
  const fetchImpl = createGuardedFetch({ token, allowUrl: (u) => u.hostname === cfg.workspaceHost, cfg })
  const r = await fetchImpl(`https://${cfg.workspaceHost}/api/2.0/apps/${appName}`, { headers: { accept: 'application/json' } })
  if (r.status === 401 || r.status === 403) throw new A2aError('no_access', `Você não tem acesso ao App "${appName}".`)
  if (r.status === 404) throw new A2aError('not_found', `App "${appName}" não encontrado neste workspace.`)
  if (!r.ok) throw new A2aError('unavailable', `Consulta do App falhou (HTTP ${r.status}).`)
  const d = (await r.json()) as { url?: string }
  if (!d?.url) throw new A2aError('unavailable', `O App "${appName}" não tem URL (ele está rodando?).`)
  const path = cardPath ? (cardPath.startsWith('/') ? cardPath : `/${cardPath}`) : '/.well-known/agent-card.json'
  return new URL(path, d.url).href
}

// A card URL's readable name when the host serves no card without a credential.
function nameFromUrl(url: URL, appName: string): string {
  if (appName) return appName
  // the path segment that names the agent: /api/agents/<name>/.well-known/agent-card.json
  const segment = url.pathname.match(/\/([A-Za-z0-9_-]{1,60})\/\.well-known\//)?.[1]
  if (segment && segment !== 'api') return segment
  return url.hostname.split('.')[0] || url.hostname
}

// a refusal that only says "credential needed": 401/403, or the login redirect of a workspace proxy
const needsCredential = (e: unknown): boolean => {
  const err = e as { code?: string; httpStatus?: number } | null
  return err?.code === 'auth_required' || err?.code === 'no_access' || (typeof err?.httpStatus === 'number' && err.httpStatus >= 300 && err.httpStatus < 400)
}

export interface AgentConfig {
  authStrategy: Strategy
  authProvider: string | null
  summary: CardSummary | null
  cardPublic: boolean
  configStatus: ConfigStatus
  configError: string
}

type AnonymousFetch = NonNullable<A2aDeps['anonymousFetch']>

/**
 * The configuration check of a card URL, WITHOUT any credential: the host is
 * covered by a strategy (this workspace → databricks-obo; a provider's
 * hostPatterns → oauth2-user; A2A_ALLOWED_HOSTS → none), the provider exists,
 * and the card is read and validated when the host serves it anonymously. A
 * host that requires a credential for the card leaves the catalog without one
 * (cardPublic false; each user's card is read with their own credential when
 * they use it). Throws for a URL nothing can serve (host not covered, card
 * invalid, an ambiguous provider choice without a card).
 */
export async function checkAgentConfig(cardUrl: string, { cfg = a2aConfig(), providers = usableProviders(), fetchImpl = null }: { cfg?: A2aConfig; providers?: OAuthProvider[]; fetchImpl?: AnonymousFetch | null } = {}): Promise<AgentConfig> {
  const url = checkUrl(cardUrl, cfg)
  const pre = strategyForUrl(url, { cfg, providers })
  const allowUrl: (u: URL) => boolean =
    pre.strategy === STRATEGY_OBO ? (u) => isDatabricksUrl(u, cfg) : pre.strategy === STRATEGY_NONE ? (u) => u.origin === url.origin : (u) => (pre.providers || []).some((p) => providerMatchesUrl(p, u))
  const state: { frontDoor?: boolean } = {}
  // no token, no ID token, no gateway header: nothing of the admin's is sent
  const anonymous = (fetchImpl || makeFetch({ token: null, requireToken: false, allowUrl, cfg, state })) as AnonymousFetch
  let raw: Record<string, unknown>
  try {
    raw = await fetchAgentCard(url.href, anonymous, cfg, undefined, state)
  } catch (e) {
    if (!needsCredential(e)) throw e
    if (pre.strategy === STRATEGY_NONE) {
      throw new A2aError('unsupported_auth', `O agente em ${url.host} exige credencial para entregar o card, mas foi registrado como público (A2A_ALLOWED_HOSTS).`)
    }
    if (pre.strategy === STRATEGY_OAUTH && (pre.providers || []).length > 1) {
      throw new A2aError('unsupported_auth', `Vários provedores OAuth cobrem ${url.host} e o card só é lido com login; deixe um só provedor para esse host.`)
    }
    return {
      authStrategy: pre.strategy,
      authProvider: pre.strategy === STRATEGY_OAUTH ? ((pre.providers as OAuthProvider[])[0] as OAuthProvider).id : null,
      summary: null,
      cardPublic: false,
      configStatus: 'card_requires_auth',
      configError: '',
    }
  }
  const sel = selectStrategy({ url, card: raw, cfg, providers })
  const provider = sel.providerId ? providerById(sel.providerId) : null
  const checkAllow: (u: URL) => boolean = provider ? (u) => providerMatchesUrl(provider, u) : sel.strategy === STRATEGY_NONE ? (u) => u.origin === url.origin : (u) => isDatabricksUrl(u, cfg)
  const summary = validateAgentCard(raw, { allowUrl: checkAllow, cfg, anonymous: sel.strategy === STRATEGY_NONE })
  return { authStrategy: sel.strategy, authProvider: sel.providerId || null, summary, cardPublic: true, configStatus: 'ok', configError: '' }
}

/** What the routes use of the catalog's database layer (injectable for tests). */
export interface A2aRouteDb {
  create: (adminEmail: string, token: string | null, a: NewA2aAgent) => Promise<A2aAgentRow>
  update: (adminEmail: string, token: string | null, id: string, patch: CatalogPatch) => Promise<A2aAgentRow | null>
  remove: (adminEmail: string, token: string | null, id: string) => Promise<boolean>
}

export interface A2aRouteDeps {
  auth?: RequestHandler
  requireAdmin?: RequestHandler
  ensureReady?: typeof realEnsureReady
  isAdmin?: (email: string, token: string) => Promise<boolean>
  deps?: A2aDeps
  db?: A2aRouteDb
  env?: Record<string, string | undefined>
}

const realDb: A2aRouteDb = { create: createA2aAgent, update: updateA2aCatalogEntry, remove: deleteA2aAgent }

export default function registerA2aRoutes(app: Express, routeDeps: A2aRouteDeps = {}): void {
  const {
    auth = realAuth,
    requireAdmin = realRequireAdmin,
    ensureReady = realEnsureReady,
    isAdmin = realIsAdmin,
    deps = defaultA2aDeps(),
    db = realDb,
    env = process.env,
  } = routeDeps
  const ready = (req: Request) => ensureReady(authed(req))

  // the enabled catalog with this user's own state; admins also get the disabled entries and the catalog's own fields
  app.get('/api/a2a/agents', auth, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const admin = await isAdmin(r.email, r.token).catch(() => false)
      const agents = (await deps.agents.list(r.email, r.token)).filter((a) => admin || a.enabled !== false)
      const tokens = agents.some((a) => a.authStrategy === STRATEGY_OAUTH) && !oauthDisabledReason(env) ? await deps.vault.connections(r.email, r.token).catch(() => new Map<string, ConnectionInfo>()) : new Map<string, ConnectionInfo>()
      res.json({
        agents: agents.map((a) => {
          const seen = observedStatus(r.email, a.id)
          return shapeAgentForClient(a, { admin, status: userAgentStatus(a, seen, tokens), lastError: seen?.lastError || '', lastCheckedAt: seen ? new Date(seen.at).toISOString() : null })
        }),
      })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  app.post('/api/a2a/agents', auth, requireAdmin, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const cfg = a2aConfig(env)
      const body = (req.body || {}) as Record<string, unknown>
      const appName = String(body.appName || '').trim()
      let cardUrl = String(body.cardUrl || '').trim()
      if (appName) cardUrl = await cardUrlFromApp(r.token, appName, String(body.cardPath || '').trim(), cfg)
      if (!cardUrl) throw new A2aError('bad_request', 'Informe a URL do Agent Card ou o nome do App.')
      const url = checkUrl(cardUrl, cfg)
      const existing = await deps.agents.list(r.email, r.token)
      if (existing.some((a) => a.cardUrl === url.href)) throw new A2aError('duplicate', 'Este agente já está registrado.')
      const checked = await checkAgentConfig(url.href, { cfg, fetchImpl: deps.anonymousFetch || null })
      const given = String(body.displayName || '').trim().slice(0, 120)
      const displayName = checked.summary?.name || given || nameFromUrl(url, appName)
      const agent = await db.create(r.email, r.token, {
        slug: uniqueSlug(displayName, existing.map((a) => a.slug)),
        displayName,
        cardUrl: url.href,
        appName,
        authStrategy: checked.authStrategy,
        authProvider: checked.authProvider,
        card: checked.summary || {},
        cardPublic: checked.cardPublic,
        enabled: body.enabled !== false,
        configStatus: checked.configStatus,
        configError: checked.configError || null,
      })
      res.json({ agent: shapeAgentForClient(agent, { admin: true }) })
    } catch (e) {
      // a concurrent registration of the same card
      if ((e as { code?: string })?.code === '23505') return sendError(res, new A2aError('duplicate', 'Este agente já está registrado.'))
      sendError(res, e, [r.token])
    }
  })

  // admin: the configuration check again (reachability, public card, provider); the catalog keeps its outcome,
  // never anything read with a credential
  app.post('/api/a2a/agents/:id/verify', auth, requireAdmin, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const agent = await deps.agents.get(r.email, r.token, String(req.params.id))
      if (!agent) throw new A2aError('not_found', 'Agente não encontrado.')
      let patch: CatalogPatch
      try {
        const checked = await checkAgentConfig(agent.cardUrl, { cfg: a2aConfig(env), fetchImpl: deps.anonymousFetch || null })
        if (checked.authStrategy !== agent.authStrategy || (checked.authProvider || null) !== (agent.authProvider || null)) {
          patch = { configStatus: 'invalid_card', configError: AUTH_CHANGED }
        } else {
          patch = { configStatus: checked.configStatus, configError: '', cardPublic: checked.cardPublic, card: checked.summary || {} }
          if (checked.summary?.name) patch.displayName = checked.summary.name
        }
      } catch (e) {
        const code = (e as { code?: string })?.code
        patch = { configStatus: code === 'invalid_card' || code === 'unsupported_auth' || code === 'blocked_url' ? 'invalid_card' : 'unavailable', configError: safeMessage(e, [r.token]) }
      }
      const updated = await db.update(r.email, r.token, agent.id, patch)
      forgetUserCards(r.email, agent.id)
      res.json({ agent: shapeAgentForClient(updated || { ...agent }, { admin: true }) })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  // admin: offered to users or not
  app.put('/api/a2a/agents/:id/enabled', auth, requireAdmin, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      if (typeof req.body?.enabled !== 'boolean') throw new A2aError('bad_request', 'Informe enabled (true/false).')
      const updated = await db.update(r.email, r.token, String(req.params.id), { enabled: req.body.enabled })
      if (!updated) throw new A2aError('not_found', 'Agente não encontrado.')
      res.json({ agent: shapeAgentForClient(updated, { admin: true }) })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  app.delete('/api/a2a/agents/:id', auth, requireAdmin, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      if (!(await db.remove(r.email, r.token, String(req.params.id)))) throw new A2aError('not_found', 'Agente não encontrado.')
      res.json({ ok: true })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  // this user's own check: THEIR credential against the agent's card (what "Verificar" in Minhas conexões runs)
  app.post('/api/a2a/agents/:id/check', auth, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const agent = await deps.agents.get(r.email, r.token, String(req.params.id))
      if (!agent || (agent.enabled === false && !(await isAdmin(r.email, r.token).catch(() => false)))) throw new A2aError('not_found', 'Agente não encontrado.')
      const out = await checkUserAccess(agent, { email: r.email, databricksToken: r.token, deps })
      recordCallStatus(r.email, agent.id, out.status, out.error || null)
      res.json({ status: out.status, error: out.error || '', ...(out.reason ? { reason: out.reason } : {}) })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  // ---- delegated OAuth (oauth2-user strategy) ----------------------------------

  // this user's own connection per provider (Minhas conexões)
  app.get('/api/a2a/providers', auth, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const disabledReason = oauthDisabledReason(env)
      const connections = disabledReason ? new Map<string, ConnectionInfo>() : await deps.vault.connections(r.email, r.token).catch(() => new Map<string, ConnectionInfo>())
      // a connection is shown as the Databricks identity only: nothing the IdP sent reaches the browser
      const providers = usableProviders(env).map((p) => ({
        id: p.id,
        name: p.name || p.id,
        type: p.type || null,
        disabled: !!disabledReason,
        connected: connections.has(p.id),
        // true only when the login checked the IdP's verified e-mail against it (requireEmailMatch)
        idpEmailVerified: connections.get(p.id)?.idpEmailVerified === true,
        expiresAt: connections.get(p.id)?.expiresAt || null,
      }))
      res.json({ providers, disabledReason: disabledReason ? 'oauth_disabled' : null })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  // admin: the providers' configuration (errors, the redirect URI to register at the IdP)
  app.get('/api/admin/a2a/providers', auth, requireAdmin, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const disabledReason = oauthDisabledReason(env)
      const cfg = a2aConfig(env)
      const providers = loadProviders(env).map((p) => {
        const ok = !p.error && 'hostPatterns' in p
        return {
          id: p.id,
          name: ('name' in p && p.name) || p.id,
          type: ('type' in p && p.type) || null,
          error: p.error || null,
          disabled: !!(p.error || disabledReason),
          scopes: ok ? (p as OAuthProvider).scopes : [],
          hostPatterns: ok ? (p as OAuthProvider).hostPatterns.map((h) => ({ pattern: h.text, send: h.send })) : [],
          redirectUri: ok ? oauthRedirectUri(req, p.id, env) : '',
        }
      })
      res.json({ providers, disabledReason, publicHosts: cfg.publicPatterns.map((p) => p.text), databricksHosts: cfg.databricksPatterns.map((p) => p.text) })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })

  app.get('/api/a2a/oauth/:provider/start', auth, async (req, res) => {
    const r = authed(req)
    const provider = providerById(String(req.params.provider), env)
    if (!provider) return callbackPage(res, { providerId: String(req.params.provider), ok: false, message: 'Provedor OAuth não configurado.', reason: 'provider_unknown' })
    try {
      const { url } = await beginAuthorization({ provider, email: r.email, redirectUri: oauthRedirectUri(req, provider.id, env), env })
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      res.redirect(302, url)
    } catch (e) {
      callbackPage(res, { providerId: provider.id, ok: false, message: safeMessage(e, [provider.clientSecret, r.token]), reason: callbackReason(e) })
    }
  })

  app.get('/api/a2a/oauth/:provider/callback', auth, async (req, res) => {
    const r = authed(req)
    const provider = providerById(String(req.params.provider), env)
    const state = String(req.query.state || '')
    if (!provider) {
      cancelAuthorization(state)
      return callbackPage(res, { providerId: String(req.params.provider), ok: false, message: 'Provedor OAuth não configurado.', reason: 'provider_unknown' })
    }
    peekAuthorization(state, r.email)
    if (req.query.error) {
      cancelAuthorization(state)
      const idpCode = oauthErrorCode(String(req.query.error))
      return callbackPage(res, {
        providerId: provider.id,
        ok: false,
        message: `O ${provider.name} não concluiu o login${idpCode ? ` (${idpCode})` : ''}.`,
        reason: idpCode === 'access_denied' ? 'access_denied' : 'idp_error',
      })
    }
    try {
      await ready(req)
      const { email: boundEmail, idpEmailVerified } = await completeAuthorization({ provider, email: r.email, state, code: String(req.query.code || ''), vault: deps.vault, dbToken: r.token })
      // cards read for this user with the previous credential (or none) are read again
      forgetUserCards(r.email)
      // the Databricks identity only (never the IdP's e-mail)
      const unverified = idpEmailVerified ? '' : ` (o e-mail da conta no ${provider.name} não foi verificado)`
      callbackPage(res, { providerId: provider.id, ok: true, message: `${provider.name} conectado para ${boundEmail}${unverified}. Você já pode fechar esta janela.`, idpEmailVerified })
    } catch (e) {
      // e.secrets: the tokens this login was just issued (see completeAuthorization)
      callbackPage(res, {
        providerId: provider.id,
        ok: false,
        message: safeMessage(e, [provider.clientSecret, r.token, ...(((e as { secrets?: string[] })?.secrets) || [])]),
        reason: callbackReason(e),
        cause: (e as { cause?: string } | null)?.cause ?? null,
      })
    }
  })

  app.delete('/api/a2a/oauth/:provider', auth, async (req, res) => {
    const r = authed(req)
    try {
      await ready(req)
      const provider = providerById(String(req.params.provider), env)
      if (!provider) throw new A2aError('not_found', 'Provedor OAuth não configurado.')
      // revoked → tokens deleted; no revocation endpoint → deleted locally only; IdP refused/unreachable → kept
      // (retry), unless `force` removes them locally
      const force = req.query.force === '1' || req.query.force === 'true'
      const { revoked, removedLocally, reason } = await deps.vault.disconnect(r.email, r.token, provider, { force })
      if (!removedLocally) {
        return void res.status(reason === 'unreadable_token' ? 500 : 502).json({
          ok: false,
          revoked: false,
          removedLocally: false,
          reason: reason || 'unknown',
          code: 'revoke_failed',
          providerId: provider.id,
          providerName: provider.name,
          error: `O ${provider.name} não confirmou a revogação; a conexão foi mantida para tentar de novo.`,
        })
      }
      forgetUserCards(r.email)
      forgetObservedStatuses(r.email)
      res.json({ ok: true, revoked: !!revoked, removedLocally: true, reason: revoked ? null : reason || 'unknown' })
    } catch (e) {
      sendError(res, e, [r.token])
    }
  })
}

// kept for the static import graph of the route-table test (route modules register on `app` directly)
export type { Strategy }
export { STRATEGY_NONE, isPublicAgentUrl }
