// Identity binding: the e-mail the proxy forwards must belong to the token it
// forwards. No network: every test injects the resolver (or a fake fetch).
//
//   node --test server/identityBinding.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityBinding, identityBindingMode, scimMeResolver } from './identityBinding.js'

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'
const OWNER = 'owner@example.com'
const TOKENS = { 'tok-alice': ALICE, 'tok-bob': BOB, 'tok-owner': OWNER }

// resolver double: maps a token to its workspace identity and counts calls
function fakeResolver(behaviour = (token) => ({ ok: true, identities: [TOKENS[token]] })) {
  const calls = []
  const resolve = async (token) => {
    calls.push(token)
    return behaviour(token)
  }
  return { resolve, calls }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

// runs the middleware once; resolves with what happened
async function run(binding, { email, token }) {
  const req = { email, token, headers: {} }
  const res = fakeRes()
  let nextCalls = 0
  await binding.middleware(req, res, () => {
    nextCalls++
  })
  return { allowed: nextCalls === 1, status: res.statusCode, body: res.body }
}

function silentLog() {
  const lines = []
  return { lines, log: (msg) => lines.push(msg) }
}

test('modo: enforce no runtime de Apps, off em dev local, IDENTITY_BINDING sobrepõe', () => {
  assert.equal(identityBindingMode({ DATABRICKS_APP_NAME: 'ai-prism' }), 'enforce')
  assert.equal(identityBindingMode({ DATABRICKS_APP_URL: 'https://x.databricksapps.com' }), 'enforce')
  assert.equal(identityBindingMode({}), 'off')
  assert.equal(identityBindingMode({ LOCAL_DEV_MODE: '1' }), 'off')
  assert.equal(identityBindingMode({ DATABRICKS_APP_NAME: 'ai-prism', IDENTITY_BINDING: 'warn' }), 'warn')
  assert.equal(identityBindingMode({ DATABRICKS_APP_NAME: 'ai-prism', IDENTITY_BINDING: 'OFF' }), 'off')
  assert.equal(identityBindingMode({ IDENTITY_BINDING: 'enforce' }), 'enforce')
  // a typo never weakens the default
  assert.equal(identityBindingMode({ DATABRICKS_APP_NAME: 'ai-prism', IDENTITY_BINDING: 'enforec' }), 'enforce')
})

test('e-mail do header igual ao dono do token: segue (comparação sem caixa)', async () => {
  const { resolve } = fakeResolver()
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log })
  const r = await run(binding, { email: 'Alice@Example.com', token: 'tok-alice' })
  assert.equal(r.allowed, true)
  assert.equal(r.status, 200)
})

test('e-mail do header diferente do dono do token: 401 identity_mismatch', async () => {
  const { resolve } = fakeResolver()
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log })
  const r = await run(binding, { email: ALICE, token: 'tok-bob' })
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'identity_mismatch')
})

test('e-mail do admin forjado com o token de outro usuário: 401', async () => {
  const { resolve } = fakeResolver()
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log })
  const r = await run(binding, { email: OWNER, token: 'tok-bob' })
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'identity_mismatch')
})

test('token que o workspace recusa (inválido/forjado): 401 invalid_token', async () => {
  const { resolve } = fakeResolver(() => ({ ok: false, invalid: true }))
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log })
  const r = await run(binding, { email: OWNER, token: 'qualquer-coisa' })
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'invalid_token')
})

test('resolvedor fora do ar: deixa passar e avisa no log, no máximo uma vez por janela', async () => {
  const { resolve } = fakeResolver(() => {
    throw new Error('connect ETIMEDOUT')
  })
  const { lines, log } = silentLog()
  let t = 1_000_000
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log, now: () => t })
  assert.equal((await run(binding, { email: ALICE, token: 'tok-1' })).allowed, true)
  assert.equal((await run(binding, { email: ALICE, token: 'tok-2' })).allowed, true)
  assert.equal(lines.length, 1, 'second warning inside the window is suppressed')
  assert.match(lines[0], /ETIMEDOUT/)
  assert.doesNotMatch(lines[0], /tok-/, 'the token never reaches the log')
  t += 61_000
  assert.equal((await run(binding, { email: ALICE, token: 'tok-3' })).allowed, true)
  assert.equal(lines.length, 2, 'a new window logs again')
})

test('cache: o mesmo token não consulta o workspace de novo dentro de 5 min', async () => {
  const { resolve, calls } = fakeResolver()
  let t = 1_000_000
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log, now: () => t })
  await run(binding, { email: ALICE, token: 'tok-alice' })
  await run(binding, { email: ALICE, token: 'tok-alice' })
  assert.equal(calls.length, 1)
  // the cached identity still rejects a different header e-mail
  assert.equal((await run(binding, { email: OWNER, token: 'tok-alice' })).status, 401)
  assert.equal(calls.length, 1)
  t += 5 * 60 * 1000 + 1
  await run(binding, { email: ALICE, token: 'tok-alice' })
  assert.equal(calls.length, 2, 'expired entry is resolved again')
})

test('cache: requisições simultâneas com o mesmo token fazem uma consulta só', async () => {
  const { resolve, calls } = fakeResolver()
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log })
  const rs = await Promise.all([1, 2, 3].map(() => run(binding, { email: ALICE, token: 'tok-alice' })))
  assert.deepEqual(rs.map((r) => r.allowed), [true, true, true])
  assert.equal(calls.length, 1)
})

test('cache: limitado (LRU) — a entrada mais antiga sai primeiro', async () => {
  const { resolve, calls } = fakeResolver()
  const binding = createIdentityBinding({ resolve, mode: () => 'enforce', log: silentLog().log, maxEntries: 2 })
  await run(binding, { email: ALICE, token: 'tok-alice' })
  await run(binding, { email: BOB, token: 'tok-bob' })
  await run(binding, { email: ALICE, token: 'tok-alice' }) // touch: alice is now the newest
  await run(binding, { email: OWNER, token: 'tok-owner' }) // evicts bob
  assert.equal(calls.length, 3)
  await run(binding, { email: ALICE, token: 'tok-alice' })
  assert.equal(calls.length, 3, 'alice stayed cached')
  await run(binding, { email: BOB, token: 'tok-bob' })
  assert.equal(calls.length, 4, 'bob was evicted')
})

test('modo warn: divergência passa, mas fica no log', async () => {
  const { resolve } = fakeResolver()
  const { lines, log } = silentLog()
  const binding = createIdentityBinding({ resolve, mode: () => 'warn', log })
  const r = await run(binding, { email: ALICE, token: 'tok-bob' })
  assert.equal(r.allowed, true)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /mismatch/)
  assert.doesNotMatch(lines[0], /alice@|bob@/, 'no e-mail in the log line')
})

test('modo off: não consulta o workspace', async () => {
  const { resolve, calls } = fakeResolver()
  const binding = createIdentityBinding({ resolve, mode: () => 'off', log: silentLog().log })
  const r = await run(binding, { email: ALICE, token: 'tok-bob' })
  assert.equal(r.allowed, true)
  assert.equal(calls.length, 0)
})

// ---- the default resolver: SCIM /Me, classified by the live responses seen
// on a real workspace (2026-11-17): 200 with userName/emails; 401 for a
// garbage or forged JWT; 403 "Invalid access token" for a well-formed but
// unknown PAT; anything else (403 scope, 5xx, network) is "can't verify".
function fakeFetch(status, body) {
  const seen = []
  const impl = async (url, init) => {
    seen.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { impl, seen }
}

test('SCIM /Me 200: identidades = userName + e-mails, chamada com o token do usuário', async () => {
  const { impl, seen } = fakeFetch(200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: '123',
    userName: ALICE,
    emails: [{ type: 'work', value: 'alice.alias@example.com', primary: true }],
  })
  const resolve = scimMeResolver({ fetchImpl: impl, host: () => 'https://ws.example.com' })
  const r = await resolve('tok-alice')
  assert.equal(r.ok, true)
  assert.deepEqual(r.identities.sort(), [ALICE, 'alice.alias@example.com'].sort())
  assert.match(seen[0].url, /^https:\/\/ws\.example\.com\/api\/2\.0\/preview\/scim\/v2\/Me/)
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok-alice')
})

test('SCIM /Me 401 ou 403 "Invalid access token": token inválido', async () => {
  for (const [status, message] of [
    [401, 'Credential was not sent or was of an unsupported type for this API. [ReqId: x]'],
    [403, 'Invalid access token. [ReqId: x]'],
  ]) {
    const { impl } = fakeFetch(status, { error_code: status, message })
    const r = await scimMeResolver({ fetchImpl: impl, host: () => 'https://ws.example.com' })('t')
    assert.deepEqual(r, { ok: false, invalid: true }, `HTTP ${status}`)
  }
})

test('SCIM /Me 403 de escopo ou 5xx: lança (não dá para verificar, quem chama decide)', async () => {
  for (const [status, body] of [
    [403, { error_code: 403, message: 'Provided OAuth token does not have required scopes' }],
    [503, { error_code: 'TEMPORARILY_UNAVAILABLE', message: 'try later' }],
  ]) {
    const { impl } = fakeFetch(status, body)
    await assert.rejects(scimMeResolver({ fetchImpl: impl, host: () => 'https://ws.example.com' })('t'), /HTTP/)
  }
})

test('SCIM sem DATABRICKS_HOST: lança (não verificável)', async () => {
  const { impl, seen } = fakeFetch(200, { userName: ALICE })
  await assert.rejects(scimMeResolver({ fetchImpl: impl, host: () => '' })('t'), /DATABRICKS_HOST/)
  assert.equal(seen.length, 0)
})

// ---- matching rule, end to end (real SCIM resolver + binding, fake fetch):
// the header e-mail is accepted when it equals /Me userName OR any emails[].value
// (case-insensitive); only "none matches" rejects. Guards workspaces where the
// userName is not the e-mail the proxy forwards (e.g. external/guest users).
async function bindWithMe(meBody, headerEmail, mode = 'enforce') {
  const { impl } = fakeFetch(200, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: '7', ...meBody })
  const { lines, log } = silentLog()
  const binding = createIdentityBinding({
    resolve: scimMeResolver({ fetchImpl: impl, host: () => 'https://ws.example.com' }),
    mode: () => mode,
    log,
  })
  return { ...(await run(binding, { email: headerEmail, token: 'tok-x' })), lines }
}

test('vínculo: userName diferente do e-mail, mas emails[] contém o e-mail do header → passa', async () => {
  const r = await bindWithMe(
    { userName: 'alice.silva', emails: [{ type: 'work', value: 'Alice@Example.com', primary: true }] },
    'alice@example.com'
  )
  assert.equal(r.allowed, true)
})

test('vínculo: userName externo (#EXT#) com emails[] batendo → passa', async () => {
  const r = await bindWithMe(
    {
      userName: 'alice_partner.com#EXT#@tenant.onmicrosoft.com',
      emails: [{ type: 'work', value: 'alice@partner.com', primary: true }],
    },
    'ALICE@partner.com'
  )
  assert.equal(r.allowed, true)
})

test('vínculo: nem userName nem emails[] batem → 401 identity_mismatch', async () => {
  const r = await bindWithMe(
    { userName: 'bob@example.com', emails: [{ type: 'work', value: 'bob.alias@example.com', primary: true }] },
    'alice@example.com'
  )
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'identity_mismatch')
})

test('modo warn: a linha de log traz o código identity_mismatch (para busca no primeiro deploy)', async () => {
  const r = await bindWithMe({ userName: 'bob@example.com', emails: [] }, 'alice@example.com', 'warn')
  assert.equal(r.allowed, true)
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /identity_mismatch/)
})

// QA r1 (PR #59): only userName and emails[].value prove ownership. A SCIM
// applicationId (service principals) is not an accepted identity field.
test('applicationId do SCIM não prova a posse do e-mail encaminhado → 401', async () => {
  const r = await bindWithMe({ userName: 'alice@example.com', applicationId: 'app-123', emails: [] }, 'app-123')
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'identity_mismatch')
})

test('SCIM /Me: identidades aceitas são só userName e emails[].value', async () => {
  const { impl } = fakeFetch(200, {
    userName: 'alice@example.com',
    applicationId: 'app-123',
    emails: [{ type: 'work', value: 'alias@example.com', primary: true }],
  })
  const r = await scimMeResolver({ fetchImpl: impl, host: () => 'https://ws.example.com' })('t')
  assert.deepEqual(r.identities.sort(), ['alias@example.com', 'alice@example.com'])
})

// A 200 from /Me is a definite answer even when it carries no userName/emails
// (e.g. a service-principal token): no accepted identity → mismatch, never the
// fail-open "could not verify" path.
test('SCIM /Me 200 sem nenhuma identidade aceita (corpo vazio) → 401 identity_mismatch, não fail-open', async () => {
  // nothing identifying at all: the old code threw "no identity" here, which the
  // binding treated as "could not verify" and ALLOWED (fail open)
  const r = await bindWithMe({ userName: undefined, emails: undefined }, 'owner@example.com')
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'identity_mismatch')
  assert.equal(r.lines.filter((l) => /could not verify/.test(l)).length, 0)
})

test('SCIM /Me 200 cujo único campo identificador é applicationId (token de SP) → 401, mesmo com header = applicationId', async () => {
  // a service-principal style body: no userName, no emails; the forwarded e-mail
  // equals the applicationId. The old code accepted it.
  const r = await bindWithMe({ userName: undefined, applicationId: 'sp-app-id', displayName: 'some-sp', emails: [] }, 'sp-app-id')
  assert.equal(r.allowed, false)
  assert.equal(r.status, 401)
  assert.equal(r.body.code, 'identity_mismatch')
  assert.equal(r.lines.filter((l) => /could not verify/.test(l)).length, 0)
})
