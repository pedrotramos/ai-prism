// The A2A routes (catalog, the user's check, providers and the OAuth login popup) with the identity, the database and
// the remote agents injected: a local echo A2A agent (server/testing/a2aEchoAgent.ts) and a mocked IdP
// (server/testing/mockIdp.ts). No database, no workspace.
//
//   node --test server/routes/a2a.test.ts
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { authed } from './authed.ts'
import registerA2aRoutes, { checkAgentConfig, oauthRedirectUri, shapeAgentForClient, userAgentStatus } from './a2a.ts'
import type { A2aRouteDb } from './a2a.ts'
import { a2aConfig } from '../a2aGuard.ts'
import { createTokenVault, idpDeps, providerById, usableProviders } from '../a2aAuth.ts'
import type { ConnectionInfo } from '../a2aAuth.ts'
import { forgetObservedStatuses } from '../a2aClient.ts'
import type { A2aDeps } from '../a2aClient.ts'
import type { A2aAgentRow, CatalogPatch, NewA2aAgent } from '../db/a2a.ts'
import { startEchoAgent } from '../testing/a2aEchoAgent.ts'
import type { EchoAgent } from '../testing/a2aEchoAgent.ts'
import { memoryTokenStore } from '../testing/memoryTokenStore.ts'
import { startIdp } from '../testing/mockIdp.ts'
import type { Idp } from '../testing/mockIdp.ts'

const USER = 'user@example.com'
const OTHER = 'other@example.com'
const ADMIN = 'admin@example.com'
const USER_TOKEN = 'dapi-user-token-not-a-secret'
const ADMIN_TOKEN = 'dapi-admin-token-not-a-secret'
const KEY = randomBytes(32).toString('hex')

let echo: EchoAgent
let guarded: EchoAgent
let idp: Idp
let env: Record<string, string>

before(async () => {
  idp = await startIdp(USER)
  echo = await startEchoAgent()
  guarded = await startEchoAgent({ verifyBearer: (t) => t === 'x', name: 'Guarded Agent' })
  env = {
    A2A_ALLOW_INSECURE_LOCAL: '1',
    A2A_ALLOWED_HOSTS: new URL(echo.url).host,
    A2A_TOKEN_ENC_KEY: KEY,
    A2A_OAUTH_REDIRECT_BASE: 'https://prism.example.com',
    A2A_OAUTH_PROVIDERS: JSON.stringify([
      {
        id: 'idp',
        name: 'Test IdP',
        type: 'oauth2',
        clientId: 'client-1',
        authorizationEndpoint: `${idp.url}/authorize`,
        tokenEndpoint: `${idp.url}/token`,
        userinfoEndpoint: `${idp.url}/userinfo`,
        revocationEndpoint: `${idp.url}/revoke`,
        scopes: ['openid', 'email'],
        hostPatterns: [new URL(guarded.url).host],
      },
    ]),
  }
  idpDeps.cfg = a2aConfig(env)
  // the tool-side helpers read process.env
  Object.assign(process.env, env)
})
after(async () => {
  await Promise.all([idp.close(), echo.close(), guarded.close()])
  delete idpDeps.cfg
  for (const k of Object.keys(env)) delete process.env[k]
})

// the caller is whoever the test says, by header (the real auth middleware is proven elsewhere)
const who = (req: Request): { email: string; token: string; admin: boolean } =>
  req.headers['x-test-user'] === 'admin'
    ? { email: ADMIN, token: ADMIN_TOKEN, admin: true }
    : req.headers['x-test-user'] === 'other'
      ? { email: OTHER, token: 'dapi-other', admin: false }
      : { email: USER, token: USER_TOKEN, admin: false }
const fakeAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const w = who(req)
  authed(req).email = w.email
  authed(req).token = w.token
  next()
}
const fakeRequireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => (who(req).admin ? next() : void res.status(403).json({ error: 'forbidden' }))

function row(over: Partial<A2aAgentRow> = {}): A2aAgentRow {
  return {
    id: '1',
    slug: 'echo',
    displayName: 'Echo',
    cardUrl: echo.cardUrl,
    appName: '',
    authStrategy: 'none',
    authProvider: null,
    card: { description: 'Echoes', skills: [] },
    cardPublic: true,
    enabled: true,
    configStatus: 'ok',
    configError: null,
    configCheckedAt: null,
    addedByHash: 'h',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

async function serve(seed: A2aAgentRow[] = []) {
  forgetObservedStatuses(USER)
  const catalog = [...seed]
  const writes: { op: string; by: string; token: string | null; arg?: unknown }[] = []
  const db: A2aRouteDb = {
    create: async (by, token, a: NewA2aAgent) => {
      writes.push({ op: 'create', by, token, arg: a })
      const created = row({ ...a, id: String(catalog.length + 1), card: a.card, configError: a.configError, addedByHash: 'h' } as Partial<A2aAgentRow>)
      catalog.push(created)
      return created
    },
    update: async (by, token, id, patch: CatalogPatch) => {
      writes.push({ op: 'update', by, token, arg: patch })
      const i = catalog.findIndex((a) => a.id === id)
      if (i < 0) return null
      catalog[i] = { ...(catalog[i] as A2aAgentRow), ...patch, configError: patch.configError ?? (catalog[i] as A2aAgentRow).configError } as A2aAgentRow
      return catalog[i] as A2aAgentRow
    },
    remove: async (by, token, id) => {
      writes.push({ op: 'remove', by, token })
      const i = catalog.findIndex((a) => a.id === id)
      if (i < 0) return false
      catalog.splice(i, 1)
      return true
    },
  }
  const store = memoryTokenStore()
  const deps: A2aDeps = {
    agents: { list: async () => catalog, get: async (_e, _t, id) => catalog.find((a) => a.id === id) || null },
    vault: createTokenVault({ store, env }),
    contexts: { get: async () => null, set: async () => {} },
  }
  const app = express()
  app.use(express.json())
  registerA2aRoutes(app, { auth: fakeAuth, requireAdmin: fakeRequireAdmin, ensureReady: async () => {}, isAdmin: async (email) => email === ADMIN, deps, db, env })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, path: string, { as = 'user', body, redirect = 'manual' }: { as?: string; body?: unknown; redirect?: RequestRedirect } = {}) => {
    const r = await fetch(`${base}${path}`, { method, redirect, headers: { 'content-type': 'application/json', 'x-test-user': as }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await r.text()
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(text)
    } catch {
      /* an HTML page */
    }
    return { status: r.status, json, text, headers: r.headers }
  }
  return { call, catalog, writes, store, deps, close: () => new Promise((r) => server.close(r)) }
}

// ---- catalog --------------------------------------------------------------------------------------------------------

test('GET /api/a2a/agents: users see the enabled agents, admins also the disabled ones and the catalog fields', async () => {
  const s = await serve([row(), row({ id: '2', slug: 'hidden', displayName: 'Hidden', cardUrl: 'https://x.example/c', enabled: false, configStatus: 'unavailable', configError: 'down' })])
  try {
    const user = await s.call('GET', '/api/a2a/agents')
    assert.equal(user.status, 200)
    const agents = user.json?.agents as Record<string, unknown>[]
    assert.deepEqual(agents.map((a) => a.slug), ['echo'])
    assert.equal('configStatus' in (agents[0] as object), false, 'catalog internals are for admins')
    const admin = await s.call('GET', '/api/a2a/agents', { as: 'admin' })
    const all = admin.json?.agents as Record<string, unknown>[]
    assert.deepEqual(all.map((a) => a.slug), ['echo', 'hidden'])
    assert.equal(all[1]?.configStatus, 'unavailable')
  } finally {
    await s.close()
  }
})

test('POST /api/a2a/agents: admin only; registers from the anonymous card and never sends the admin credential', async () => {
  const s = await serve()
  try {
    const denied = await s.call('POST', '/api/a2a/agents', { body: { cardUrl: echo.cardUrl } })
    assert.equal(denied.status, 403)
    assert.equal(s.writes.length, 0)

    echo.requests.length = 0
    const ok = await s.call('POST', '/api/a2a/agents', { as: 'admin', body: { cardUrl: echo.cardUrl } })
    assert.equal(ok.status, 200, ok.text)
    const agent = ok.json?.agent as Record<string, unknown>
    assert.equal(agent.displayName, 'AI Prism Echo Agent')
    assert.equal(agent.slug, 'ai_prism_echo_agent')
    assert.equal(agent.authStrategy, 'none')
    assert.equal(agent.cardPublic, true)
    assert.equal(agent.configStatus, 'ok')
    assert.ok(echo.requests.length >= 1)
    assert.ok(echo.requests.every((r) => r.authorization === null), 'the admin Databricks token was not sent to the agent')
    assert.equal((s.writes[0]?.arg as NewA2aAgent).authStrategy, 'none')
    assert.equal(s.writes[0]?.by, ADMIN)

    const dup = await s.call('POST', '/api/a2a/agents', { as: 'admin', body: { cardUrl: echo.cardUrl } })
    assert.equal(dup.status, 409)
    assert.equal(dup.json?.code, 'duplicate')
  } finally {
    await s.close()
  }
})

test('POST /api/a2a/agents: a host nothing covers, a bad body and an agent whose card needs a credential', async () => {
  const s = await serve()
  try {
    const blocked = await s.call('POST', '/api/a2a/agents', { as: 'admin', body: { cardUrl: 'https://elsewhere.example.net/.well-known/agent-card.json' } })
    assert.equal(blocked.status, 422)
    assert.equal(blocked.json?.code, 'unsupported_auth')
    const empty = await s.call('POST', '/api/a2a/agents', { as: 'admin', body: {} })
    assert.equal(empty.status, 400)
    const metadata = await s.call('POST', '/api/a2a/agents', { as: 'admin', body: { cardUrl: 'https://169.254.169.254/latest/meta-data/' } })
    assert.equal(metadata.status, 422)

    // the guarded agent is covered by the provider's hosts: its card needs the user's own login, so the catalog keeps none
    guarded.requests.length = 0
    const gated = await s.call('POST', '/api/a2a/agents', { as: 'admin', body: { cardUrl: guarded.cardUrl, displayName: 'Guarded' } })
    assert.equal(gated.status, 200, gated.text)
    const agent = gated.json?.agent as Record<string, unknown>
    assert.equal(agent.authStrategy, 'oauth2-user')
    assert.equal(agent.authProvider, 'idp')
    assert.equal(agent.cardPublic, false)
    assert.equal(agent.configStatus, 'card_requires_auth')
    assert.ok(guarded.requests.every((r) => r.authorization === null), 'asked anonymously')
  } finally {
    await s.close()
  }
})

test('verify / enable / remove: admin only and audited writes go through the db layer with the admin identity', async () => {
  const s = await serve([row()])
  try {
    assert.equal((await s.call('POST', '/api/a2a/agents/1/verify')).status, 403)
    assert.equal((await s.call('PUT', '/api/a2a/agents/1/enabled', { body: { enabled: false } })).status, 403)
    assert.equal((await s.call('DELETE', '/api/a2a/agents/1')).status, 403)
    assert.equal(s.writes.length, 0)

    const verified = await s.call('POST', '/api/a2a/agents/1/verify', { as: 'admin' })
    assert.equal(verified.status, 200, verified.text)
    assert.equal((verified.json?.agent as Record<string, unknown>).configStatus, 'ok')

    assert.equal((await s.call('PUT', '/api/a2a/agents/1/enabled', { as: 'admin', body: { enabled: 'yes' } })).status, 400)
    const off = await s.call('PUT', '/api/a2a/agents/1/enabled', { as: 'admin', body: { enabled: false } })
    assert.equal((off.json?.agent as Record<string, unknown>).enabled, false)
    assert.equal((await s.call('PUT', '/api/a2a/agents/99/enabled', { as: 'admin', body: { enabled: true } })).status, 404)

    assert.equal((await s.call('DELETE', '/api/a2a/agents/1', { as: 'admin' })).status, 200)
    assert.equal((await s.call('DELETE', '/api/a2a/agents/1', { as: 'admin' })).status, 404)
    assert.ok(s.writes.every((w) => w.by === ADMIN))
  } finally {
    await s.close()
  }
})

test('verify: an agent whose card now asks for another authentication is marked invalid, not silently accepted', async () => {
  // registered as oauth2-user, but its host is now only a public one (no provider covers it)
  const s = await serve([row({ authStrategy: 'oauth2-user', authProvider: 'idp' })])
  try {
    const r = await s.call('POST', '/api/a2a/agents/1/verify', { as: 'admin' })
    assert.equal(r.status, 200)
    assert.equal((r.json?.agent as Record<string, unknown>).configStatus, 'invalid_card')
  } finally {
    await s.close()
  }
})

// ---- the user's status and check ------------------------------------------------------------------------------------

test('the user\'s status of an oauth2-user agent comes from THEIR login; the check reads the card with it', async () => {
  const agent = row({ id: '5', slug: 'guarded', displayName: 'Guarded', cardUrl: guarded.cardUrl, authStrategy: 'oauth2-user', authProvider: 'idp', cardPublic: false })
  const s = await serve([agent])
  try {
    const before = await s.call('GET', '/api/a2a/agents')
    assert.equal(((before.json?.agents as Record<string, unknown>[])[0] as Record<string, unknown>).status, 'auth_required')
    const check = await s.call('POST', '/api/a2a/agents/5/check')
    assert.equal(check.json?.status, 'auth_required')

    await s.deps.vault.save(USER, USER_TOKEN, 'idp', { accessToken: 'x', refreshToken: 'refresh-token-value', expiresAt: new Date(Date.now() + 3_600_000), scope: 'openid email', idpEmailVerified: true, externalSubject: 'sub-1' })
    const after = await s.call('GET', '/api/a2a/agents')
    assert.equal(((after.json?.agents as Record<string, unknown>[])[0] as Record<string, unknown>).status, 'connected')
    const ok = await s.call('POST', '/api/a2a/agents/5/check')
    assert.equal(ok.json?.status, 'connected')
    // another user has nothing connected
    const other = await s.call('GET', '/api/a2a/agents', { as: 'other' })
    assert.equal(((other.json?.agents as Record<string, unknown>[])[0] as Record<string, unknown>).status, 'auth_required')
    assert.equal((await s.call('POST', '/api/a2a/agents/404/check')).status, 404)
  } finally {
    await s.close()
  }
})

test('userAgentStatus / shapeAgentForClient: pure shaping', () => {
  const providers = usableProviders(env)
  assert.ok(providers.length === 1)
  const tokens = new Map<string, ConnectionInfo>()
  const oauth = row({ authStrategy: 'oauth2-user', authProvider: 'idp', cardUrl: guarded.cardUrl })
  assert.equal(userAgentStatus(oauth, null, tokens), 'auth_required')
  assert.equal(userAgentStatus(row({ authStrategy: 'oauth2-user', authProvider: 'gone' }), null, tokens), 'unavailable')
  assert.equal(userAgentStatus(row(), { status: 'connected' }, tokens), 'connected')
  assert.equal(userAgentStatus(row(), null, tokens), 'unknown')
  const shaped = shapeAgentForClient(row({ addedByHash: 'secret-hash' }))
  assert.equal(shaped.toolName, 'a2a__echo')
  assert.ok(!JSON.stringify(shaped).includes('secret-hash'), 'the audit hash never reaches users')
  assert.equal(shapeAgentForClient(row(), { admin: true }).configStatus, 'ok')
})

test('checkAgentConfig: reads the card anonymously through a guarded fetch; a covered public host is strategy none', async () => {
  const cfg = a2aConfig(env)
  const out = await checkAgentConfig(echo.cardUrl, { cfg, providers: usableProviders(env) })
  assert.equal(out.authStrategy, 'none')
  assert.equal(out.summary?.name, 'AI Prism Echo Agent')
  assert.equal(out.configStatus, 'ok')
})

// ---- providers and the OAuth popup ----------------------------------------------------------------------------------------

test('GET /api/a2a/providers: connection state only, no token and no IdP data; the admin view adds the redirect URI', async () => {
  const s = await serve()
  try {
    const r = await s.call('GET', '/api/a2a/providers')
    const p = (r.json?.providers as Record<string, unknown>[])[0] as Record<string, unknown>
    assert.deepEqual({ id: p.id, name: p.name, connected: p.connected }, { id: 'idp', name: 'Test IdP', connected: false })
    assert.equal(r.json?.disabledReason, null)
    assert.equal((await s.call('GET', '/api/admin/a2a/providers')).status, 403)
    const admin = await s.call('GET', '/api/admin/a2a/providers', { as: 'admin' })
    const ap = (admin.json?.providers as Record<string, unknown>[])[0] as Record<string, unknown>
    assert.equal(ap.redirectUri, 'https://prism.example.com/api/a2a/oauth/idp/callback')
    assert.ok(!JSON.stringify(admin.json).includes('client-1'), 'the client id is not part of the admin view either')
  } finally {
    await s.close()
  }
})

test('OAuth popup: start redirects to the IdP with PKCE; the callback stores the sealed tokens and tells the opener', async () => {
  const s = await serve()
  try {
    const start = await s.call('GET', '/api/a2a/oauth/idp/start')
    assert.equal(start.status, 302)
    const location = new URL(start.headers.get('location') as string)
    assert.equal(location.origin + location.pathname, `${idp.url}/authorize`)
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(location.searchParams.get('redirect_uri'), 'https://prism.example.com/api/a2a/oauth/idp/callback')
    idp.challenge = location.searchParams.get('code_challenge') as string
    const state = location.searchParams.get('state') as string

    // another user cannot finish this login
    const stolen = await s.call('GET', `/api/a2a/oauth/idp/callback?state=${state}&code=c`, { as: 'other' })
    assert.equal(stolen.status, 400)
    assert.match(stolen.text, /"reason":"state_mismatch"/)
    assert.equal(s.store.rows.size, 0)

    // the state was used up by that attempt: start again as the right user
    const again = new URL((await s.call('GET', '/api/a2a/oauth/idp/start')).headers.get('location') as string)
    idp.challenge = again.searchParams.get('code_challenge') as string
    const done = await s.call('GET', `/api/a2a/oauth/idp/callback?state=${again.searchParams.get('state')}&code=the-code`)
    assert.equal(done.status, 200, done.text)
    assert.match(done.text, /"type":"a2a-oauth"/)
    assert.match(done.text, /"ok":true/)
    assert.equal(done.headers.get('cache-control'), 'no-store')
    assert.ok(!done.text.includes('at-'), 'no token in the page')
    assert.ok(s.store.rows.has(`${USER}\nidp`))

    const providers = await s.call('GET', '/api/a2a/providers')
    assert.equal(((providers.json?.providers as Record<string, unknown>[])[0] as Record<string, unknown>).connected, true)
    assert.equal((((await s.call('GET', '/api/a2a/providers', { as: 'other' })).json?.providers as Record<string, unknown>[])[0] as Record<string, unknown>).connected, false)

    const gone = await s.call('DELETE', '/api/a2a/oauth/idp')
    assert.equal(gone.status, 200)
    assert.equal(gone.json?.revoked, true)
    assert.equal(s.store.rows.size, 0)
    assert.ok(idp.revoked.length >= 1)
  } finally {
    await s.close()
  }
})

test('OAuth popup: an IdP error, an unknown provider and a refused disconnect answer with fixed codes', async () => {
  const s = await serve()
  try {
    const denied = await s.call('GET', '/api/a2a/oauth/idp/callback?error=access_denied&state=nope')
    assert.equal(denied.status, 400)
    assert.match(denied.text, /"reason":"access_denied"/)
    const unknown = await s.call('GET', '/api/a2a/oauth/nope/start')
    assert.equal(unknown.status, 400)
    assert.match(unknown.text, /"reason":"provider_unknown"/)
    assert.equal((await s.call('DELETE', '/api/a2a/oauth/nope')).status, 404)
  } finally {
    await s.close()
  }
})

test('oauthRedirectUri: the configured base wins, else the app URL, else the request origin', () => {
  const req = { headers: { host: 'localhost:8000' }, protocol: 'http' } as unknown as Request
  assert.equal(oauthRedirectUri(req, 'idp', { A2A_OAUTH_REDIRECT_BASE: 'https://a.example.com/' }), 'https://a.example.com/api/a2a/oauth/idp/callback')
  assert.equal(oauthRedirectUri(req, 'idp', { DATABRICKS_APP_URL: 'https://b.example.com' }), 'https://b.example.com/api/a2a/oauth/idp/callback')
  assert.equal(oauthRedirectUri(req, 'idp', {}), 'http://localhost:8000/api/a2a/oauth/idp/callback')
  assert.ok(providerById('idp', env))
})
