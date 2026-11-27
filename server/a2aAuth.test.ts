// Per-user A2A authentication: the provider configuration, the token encryption (AES-256-GCM bound to its row),
// the OAuth 2.0 authorization-code + PKCE login against a mocked IdP, refresh, revocation and strategy selection.
//
//   node --test server/a2aAuth.test.ts
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { SignJWT, generateKeyPair } from 'jose'
import { a2aConfig } from './a2aGuard.ts'
import {
  STRATEGY_NONE,
  STRATEGY_OAUTH,
  STRATEGY_OBO,
  beginAuthorization,
  cancelAuthorization,
  completeAuthorization,
  connectionState,
  createTokenVault,
  encryptionKey,
  idpDeps,
  loadProviders,
  oauthDisabledReason,
  peekAuthorization,
  providerById,
  resetIdpCaches,
  resolveCredential,
  seal,
  selectStrategy,
  strategyForUrl,
  unseal,
  usableProviders,
} from './a2aAuth.ts'
import type { OAuthProvider, TokenRow } from './a2aAuth.ts'
import { memoryTokenStore as memoryStore } from './testing/memoryTokenStore.ts'
import { startIdp } from './testing/mockIdp.ts'
import type { Idp } from './testing/mockIdp.ts'

const KEY_HEX = randomBytes(32).toString('hex')
const ENV_BASE = { A2A_TOKEN_ENC_KEY: KEY_HEX, A2A_ALLOW_INSECURE_LOCAL: '1' }
const ME = 'ana@example.com'
const DB_TOKEN = 'dapi-user-databricks-token'

let idp: Idp
before(async () => {
  idp = await startIdp(ME)
  idpDeps.cfg = a2aConfig(ENV_BASE)
})
after(async () => {
  await idp.close()
  delete idpDeps.cfg
})

const providerEnv = (over: Record<string, unknown> = {}, env: Record<string, string> = {}) => ({
  ...ENV_BASE,
  ...env,
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
      hostPatterns: [`${idp.host}`],
      ...over,
    },
  ]),
})

const authParams = (url: string) => new URL(url).searchParams

async function login(provider: OAuthProvider, vault: ReturnType<typeof createTokenVault>, env: Record<string, string>, email = ME) {
  const { url, state } = await beginAuthorization({ provider, email, redirectUri: 'https://app.example.com/api/a2a/oauth/idp/callback', env })
  idp.challenge = authParams(url).get('code_challenge') as string
  return { url, state, done: () => completeAuthorization({ provider, email, state, code: 'the-code', vault, dbToken: DB_TOKEN }) }
}

// ---- configuration -----------------------------------------------------------------------------------------------

test('providers: a valid one loads; reserved ids, a missing client and a missing host pattern are refused with a reason', () => {
  const ok = loadProviders(providerEnv())
  assert.equal(ok.length, 1)
  assert.equal((ok[0] as OAuthProvider).error, undefined)
  assert.equal(usableProviders(providerEnv()).length, 1)
  assert.equal(providerById('idp', providerEnv())?.name, 'Test IdP')

  assert.match(loadProviders(providerEnv({ id: 'databricks' }))[0]?.error ?? '', /reservado/)
  assert.match(loadProviders(providerEnv({ id: 'Bad Id!' }))[0]?.error ?? '', /id inválido/)
  assert.match(loadProviders(providerEnv({ clientId: '' }))[0]?.error ?? '', /clientId/)
  assert.match(loadProviders(providerEnv({ hostPatterns: [] }))[0]?.error ?? '', /hostPatterns/)
  assert.match(loadProviders(providerEnv({ authParams: { state: 'x' } }))[0]?.error ?? '', /authParams/)
  assert.match(loadProviders(providerEnv({ idTokenHeader: 'Authorization' }))[0]?.error ?? '', /idTokenHeader/)
  assert.equal(usableProviders(providerEnv({ clientId: '' })).length, 0, 'a broken provider is never offered')
})

test('providers: an id-token destination always asks for the OIDC scopes and the header option is a plain header name', () => {
  const [p] = usableProviders(providerEnv({ type: 'oidc', scopes: [], hostPatterns: [{ pattern: 'gw.example.com', send: 'id-token' }], idTokenHeader: 'X-Gateway-Id-Token' }))
  assert.ok(p)
  assert.deepEqual([...p.scopes].sort(), ['email', 'openid', 'profile'])
  assert.equal(p.idTokenHeader, 'x-gateway-id-token')
})

test('A2A_TOKEN_ENC_KEY: 32 bytes as hex or base64; anything else leaves external sign-in off', () => {
  assert.equal(encryptionKey({ A2A_TOKEN_ENC_KEY: KEY_HEX })?.length, 32)
  assert.equal(encryptionKey({ A2A_TOKEN_ENC_KEY: randomBytes(32).toString('base64') })?.length, 32)
  assert.equal(encryptionKey({ A2A_TOKEN_ENC_KEY: 'short' }), null)
  assert.equal(encryptionKey({}), null)
  assert.match(oauthDisabledReason({}) ?? '', /A2A_TOKEN_ENC_KEY/)
  assert.match(oauthDisabledReason({ A2A_TOKEN_ENC_KEY: 'short' }) ?? '', /inválida/)
  assert.equal(oauthDisabledReason({ A2A_TOKEN_ENC_KEY: KEY_HEX }), null)
})

// ---- encryption --------------------------------------------------------------------------------------------------

test('seal / unseal: round trip, a fresh IV each time, and a ciphertext bound to its row (AAD)', () => {
  const key = encryptionKey({ A2A_TOKEN_ENC_KEY: KEY_HEX }) as Buffer
  const a = seal(key, 'secret-token', 'row-1')
  const b = seal(key, 'secret-token', 'row-1')
  assert.notEqual(a, b)
  assert.ok(!a.includes('secret-token'))
  assert.equal(unseal(key, a, 'row-1'), 'secret-token')
  assert.throws(() => unseal(key, a, 'row-2'), 'copied to another row it does not open')
  assert.throws(() => unseal(randomBytes(32), a, 'row-1'), 'another key does not open it')
  const [v, iv, tag, ct] = a.split('.') as [string, string, string, string]
  assert.throws(() => unseal(key, [v, iv, tag, Buffer.from('x').toString('base64url') + ct.slice(1)].join('.'), 'row-1'), 'tampered ciphertext')
  assert.throws(() => unseal(key, 'v2.a.b.c', 'row-1'), /formato/)
})

// ---- the login ---------------------------------------------------------------------------------------------------

test('authorization code + PKCE: S256 challenge, state and nonce, the verifier is sent at the token endpoint, tokens are stored sealed', async () => {
  const env = providerEnv()
  const store = memoryStore()
  const vault = createTokenVault({ store, env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.requests.length = 0
  idp.identity = { sub: 'user-1', email: ME, email_verified: true }
  const l = await login(provider, vault, env)
  const q = authParams(l.url)
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('client_id'), 'client-1')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('redirect_uri'), 'https://app.example.com/api/a2a/oauth/idp/callback')
  assert.equal(q.get('scope'), 'openid email')
  assert.ok((q.get('state') || '').length >= 32 && (q.get('nonce') || '').length >= 16)
  assert.deepEqual(peekAuthorization(l.state, ME), null, 'a login without a context has none to give back')
  assert.equal(peekAuthorization(l.state, 'mallory@example.com'), null)

  const out = await l.done()
  assert.equal(out.email, ME)
  assert.equal(out.idpEmailVerified, true)
  const tokenCall = idp.requests.find((r) => r.path === '/token')
  assert.equal(tokenCall?.body.get('grant_type'), 'authorization_code')
  assert.equal(tokenCall?.body.get('code'), 'the-code')
  assert.ok(tokenCall?.body.get('code_verifier'))

  // at rest: ciphertext only, bound to the row, the subject only as a digest
  const row = store.rows.get(`${ME}\nidp`) as TokenRow
  assert.ok(row.accessTokenEnc.startsWith('v1.') && !JSON.stringify(row).includes('at-'))
  assert.ok(row.refreshTokenEnc?.startsWith('v1.'))
  assert.ok(row.externalSubjectHmac && !row.externalSubjectHmac.includes('user-1'))
  const creds = await vault.credentials(ME, DB_TOKEN, provider)
  assert.equal(creds.accessToken, 'at-1')
  const conns = await vault.connections(ME, DB_TOKEN)
  assert.equal(conns.has('idp'), true)
  assert.equal(connectionState(provider, conns.get('idp'), `https://${idp.host}/agent`), 'connected')
})

test('a login state is single use, bound to the user who started it and to the provider', async () => {
  const env = providerEnv()
  const vault = createTokenVault({ store: memoryStore(), env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.identity = { sub: 'user-1', email: ME, email_verified: true }

  const l1 = await login(provider, vault, env)
  await assert.rejects(() => completeAuthorization({ provider, email: 'mallory@example.com', state: l1.state, code: 'c', vault, dbToken: DB_TOKEN }), (e: { reason?: string }) => e.reason === 'state_mismatch')
  // the state was used up by the failed attempt
  await assert.rejects(() => l1.done(), (e: { reason?: string }) => e.reason === 'state_expired')

  const l2 = await login(provider, vault, env)
  await l2.done()
  await assert.rejects(() => l2.done(), (e: { reason?: string }) => e.reason === 'state_expired', 'a replayed callback is refused')

  const l3 = await login(provider, vault, env)
  cancelAuthorization(l3.state)
  await assert.rejects(() => l3.done(), (e: { reason?: string }) => e.reason === 'state_expired')
  await assert.rejects(() => completeAuthorization({ provider, email: ME, state: 'unknown', code: 'c', vault, dbToken: DB_TOKEN }), (e: { reason?: string }) => e.reason === 'state_expired')
})

test('a wrong PKCE verifier is refused by the IdP and nothing is stored', async () => {
  const env = providerEnv()
  const store = memoryStore()
  const vault = createTokenVault({ store, env })
  const provider = providerById('idp', env) as OAuthProvider
  const { state } = await beginAuthorization({ provider, email: ME, redirectUri: 'https://app.example.com/cb', env })
  idp.challenge = 'a-different-challenge'
  await assert.rejects(() => completeAuthorization({ provider, email: ME, state, code: 'c', vault, dbToken: DB_TOKEN }))
  assert.equal(store.rows.size, 0)
})

test('requireEmailMatch: another IdP account is rejected, nothing is stored and the grant is revoked at the IdP', async () => {
  const env = providerEnv()
  const store = memoryStore()
  const vault = createTokenVault({ store, env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.identity = { sub: 'user-9', email: 'someone.else@example.com', email_verified: true }
  idp.revoked.length = 0
  const l = await login(provider, vault, env)
  await assert.rejects(
    () => l.done(),
    (e: { reason?: string; message?: string }) => e.reason === 'email_mismatch' && !String(e.message).includes('someone.else@example.com'),
    'the IdP e-mail is never repeated'
  )
  assert.equal(store.rows.size, 0)
  assert.equal(idp.revoked.length, 1, 'the grant that could not be bound to this user was revoked')
  // the right address but not verified by the IdP is not proof either
  idp.identity = { sub: 'user-1', email: ME, email_verified: false }
  await assert.rejects(async () => (await login(provider, vault, env)).done(), (e: { reason?: string }) => e.reason === 'email_mismatch')
  // no address at all
  idp.identity = { sub: 'user-1' } as Idp['identity']
  await assert.rejects(async () => (await login(provider, vault, env)).done(), (e: { reason?: string }) => e.reason === 'email_unverified')
  assert.equal(store.rows.size, 0)
})

test('a provider stays bound to the account it was first connected with', async () => {
  const env = providerEnv()
  const vault = createTokenVault({ store: memoryStore(), env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.identity = { sub: 'user-1', email: ME, email_verified: true }
  await (await login(provider, vault, env)).done()
  await (await login(provider, vault, env)).done() // the same account again is fine
  idp.identity = { sub: 'user-2', email: ME, email_verified: true }
  await assert.rejects(async () => (await login(provider, vault, env)).done(), (e: { reason?: string }) => e.reason === 'identity_conflict' || e.reason === 'grant_not_revoked')
})

test('OIDC: the id_token is verified against the JWKS (signature, audience, nonce) before the identity is trusted', async () => {
  resetIdpCaches()
  // a token endpoint that returns the id_token the test hands it
  let idToken = ''
  const tokenServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'at-oidc', refresh_token: 'rt-oidc', id_token: idToken, expires_in: 3600 }))
  })
  await new Promise<void>((r) => tokenServer.listen(0, '127.0.0.1', r))
  const tokenPort = (tokenServer.address() as AddressInfo).port
  const env = providerEnv({ type: 'oidc', jwksUri: `${idp.url}/jwks`, tokenEndpoint: `http://127.0.0.1:${tokenPort}/token`, userinfoEndpoint: '' }, {})
  const provider = providerById('idp', env) as OAuthProvider
  const run = async (claims: (nonce: string) => Promise<string>) => {
    const store = memoryStore()
    const vault = createTokenVault({ store, env })
    const { url, state } = await beginAuthorization({ provider, email: ME, redirectUri: 'https://app.example.com/cb', env })
    idToken = await claims(authParams(url).get('nonce') as string)
    return { store, out: completeAuthorization({ provider, email: ME, state, code: 'c', vault, dbToken: DB_TOKEN }) }
  }
  try {
    const good = await run((nonce) => idp.sign({ iss: idp.url, aud: 'client-1', sub: 'user-1', email: ME, email_verified: true, nonce }))
    assert.equal((await good.out).email, ME)
    assert.equal(good.store.rows.size, 1)

    const wrongNonce = await run((nonce) => idp.sign({ aud: 'client-1', sub: 'user-1', email: ME, email_verified: true, nonce: `${nonce}x` }))
    await assert.rejects(() => wrongNonce.out, (e: { reason?: string; cause?: string }) => e.reason === 'id_token_invalid' || e.cause === 'id_token_invalid')
    assert.equal(wrongNonce.store.rows.size, 0)

    const wrongAudience = await run((nonce) => idp.sign({ aud: 'someone-else', sub: 'user-1', email: ME, email_verified: true, nonce }))
    await assert.rejects(() => wrongAudience.out, (e: { reason?: string; cause?: string }) => e.reason === 'id_token_invalid' || e.cause === 'id_token_invalid')

    // signed by a key the IdP does not publish
    const other = await generateKeyPair('RS256')
    const forged = await run((nonce) => new SignJWT({ aud: 'client-1', sub: 'user-1', email: ME, email_verified: true, nonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(other.privateKey))
    await assert.rejects(() => forged.out, (e: { reason?: string; cause?: string }) => e.reason === 'id_token_invalid' || e.cause === 'id_token_invalid')
    assert.equal(forged.store.rows.size, 0)
  } finally {
    await new Promise<void>((r) => (tokenServer.closeAllConnections?.(), tokenServer.close(() => r())))
  }
})

// ---- refresh and disconnect -----------------------------------------------------------------------------------------

test('an expired access token is refreshed with the refresh token and the row is replaced; a rejected refresh asks to sign in again', async () => {
  const env = providerEnv()
  const store = memoryStore()
  const vault = createTokenVault({ store, env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.identity = { sub: 'user-1', email: ME, email_verified: true }
  idp.failRefresh = false
  await (await login(provider, vault, env)).done()
  const before = store.rows.get(`${ME}\nidp`) as TokenRow
  store.rows.set(`${ME}\nidp`, { ...before, expiresAt: new Date(Date.now() - 1000) })
  idp.requests.length = 0
  const fresh = await vault.credentials(ME, DB_TOKEN, provider)
  assert.ok(fresh.accessToken.startsWith('at-'))
  assert.equal(idp.requests.find((r) => r.path === '/token')?.body.get('grant_type'), 'refresh_token')
  assert.notEqual((store.rows.get(`${ME}\nidp`) as TokenRow).accessTokenEnc, before.accessTokenEnc)

  store.rows.set(`${ME}\nidp`, { ...(store.rows.get(`${ME}\nidp`) as TokenRow), expiresAt: new Date(Date.now() - 1000) })
  idp.failRefresh = true
  await assert.rejects(() => vault.credentials(ME, DB_TOKEN, provider), (e: { code?: string; providerId?: string }) => e.code === 'auth_required' && e.providerId === 'idp')
  idp.failRefresh = false
})

test('no stored login: auth_required, never another user\'s credential', async () => {
  const env = providerEnv()
  const store = memoryStore()
  const vault = createTokenVault({ store, env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.identity = { sub: 'user-1', email: ME, email_verified: true }
  await (await login(provider, vault, env)).done()
  await assert.rejects(() => vault.credentials('bob@example.com', DB_TOKEN, provider), (e: { code?: string }) => e.code === 'auth_required')
  // a ciphertext copied to another user's row does not open
  store.rows.set('bob@example.com\nidp', store.rows.get(`${ME}\nidp`) as TokenRow)
  await assert.rejects(() => vault.credentials('bob@example.com', DB_TOKEN, provider))
})

test('disconnect revokes at the IdP then deletes the row; an IdP that refuses keeps it unless forced', async () => {
  const env = providerEnv()
  const store = memoryStore()
  const vault = createTokenVault({ store, env })
  const provider = providerById('idp', env) as OAuthProvider
  idp.identity = { sub: 'user-1', email: ME, email_verified: true }
  await (await login(provider, vault, env)).done()
  idp.revoked.length = 0
  const done = await vault.disconnect(ME, DB_TOKEN, provider)
  assert.deepEqual({ revoked: done.revoked, removedLocally: done.removedLocally }, { revoked: true, removedLocally: true })
  assert.ok(idp.revoked.length >= 1)
  assert.equal(store.rows.size, 0)

  // an IdP without a revocation endpoint: removed locally only
  const noRevoke = providerEnv({ revocationEndpoint: '' })
  const p2 = providerById('idp', noRevoke) as OAuthProvider
  const v2 = createTokenVault({ store, env: noRevoke })
  await (await login(p2, v2, noRevoke)).done()
  const r2 = await v2.disconnect(ME, DB_TOKEN, p2)
  assert.deepEqual({ revoked: r2.revoked, removedLocally: r2.removedLocally, reason: r2.reason }, { revoked: false, removedLocally: true, reason: 'no_revocation_endpoint' })
})

// ---- strategy and credential ----------------------------------------------------------------------------------------

test('strategyForUrl: a provider host, this workspace, a public host, and nothing else', () => {
  const env = { ...providerEnv(), DATABRICKS_HOST: 'https://adb-1.azuredatabricks.net', A2A_ALLOWED_HOSTS: 'public.example.org' }
  const cfg = a2aConfig(env)
  const providers = usableProviders(env)
  assert.equal(strategyForUrl(`http://${idp.host}/agent`, { cfg, providers }).strategy, STRATEGY_OAUTH)
  assert.equal(strategyForUrl('https://adb-1.azuredatabricks.net/api/agents/x', { cfg, providers }).strategy, STRATEGY_OBO)
  assert.equal(strategyForUrl('https://public.example.org/card', { cfg, providers }).strategy, STRATEGY_NONE)
  assert.throws(() => strategyForUrl('https://elsewhere.example.net/card', { cfg, providers }), (e: { code?: string }) => e.code === 'unsupported_auth')
})

test('selectStrategy: a public host whose card asks for authentication cannot be called with none', () => {
  const cfg = a2aConfig({ A2A_ALLOWED_HOSTS: 'public.example.org' })
  const open = { name: 'x', supportedInterfaces: [], securitySchemes: {}, securityRequirements: [] }
  assert.equal(selectStrategy({ url: 'https://public.example.org/c', card: open, cfg, providers: [] }).strategy, STRATEGY_NONE)
  const closed = { ...open, securitySchemes: { b: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer' } } } }, securityRequirements: [{ schemes: { b: { list: [] } } }] }
  assert.throws(() => selectStrategy({ url: 'https://public.example.org/c', card: closed, cfg, providers: [] }), (e: { code?: string }) => e.code === 'unsupported_auth')
})

test('resolveCredential: OBO carries only the user token and only for workspace hosts; none carries nothing and stays on its origin; no token fails closed', async () => {
  const cfg = a2aConfig({ DATABRICKS_HOST: 'https://adb-1.azuredatabricks.net' })
  const obo = await resolveCredential({ agent: { authStrategy: STRATEGY_OBO, cardUrl: 'https://adb-1.azuredatabricks.net/c' }, databricksToken: DB_TOKEN, email: ME, dbToken: DB_TOKEN, cfg })
  assert.equal(obo.token, DB_TOKEN)
  assert.equal(obo.allowUrl(new URL('https://adb-1.azuredatabricks.net/x')), true)
  assert.equal(obo.allowUrl(new URL('https://evil.example.net/x')), false, 'the Databricks token is never sent off the workspace')
  await assert.rejects(() => resolveCredential({ agent: { authStrategy: STRATEGY_OBO, cardUrl: 'https://adb-1.azuredatabricks.net/c' }, databricksToken: null, email: ME, dbToken: null, cfg }), (e: { code?: string }) => e.code === 'no_token')
  const none = await resolveCredential({ agent: { authStrategy: STRATEGY_NONE, cardUrl: 'https://public.example.org/c' }, databricksToken: DB_TOKEN, email: ME, dbToken: DB_TOKEN, cfg })
  assert.equal(none.token, null)
  assert.equal(none.allowUrl(new URL('https://public.example.org/other')), true)
  assert.equal(none.allowUrl(new URL('https://other.example.org/x')), false)
})
