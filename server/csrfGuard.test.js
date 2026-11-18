// CSRF guard on state-changing /api/* calls. Pure middleware tests (no app).
//
//   node --test server/csrfGuard.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { csrfGuard } from './csrfGuard.js'

const APP_HOST = 'ai-prism-123.aws.databricksapps.com'

function call({ method = 'POST', headers = {}, env = {} } = {}) {
  const guard = csrfGuard({ env })
  const req = { method, headers: { host: 'localhost:8000', ...headers } }
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
  let passed = false
  guard(req, res, () => {
    passed = true
  })
  return { passed, status: res.statusCode, body: res.body }
}

test('cross-site POST (Sec-Fetch-Site: cross-site, Origin alheio): 403', () => {
  const r = call({ headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } })
  assert.equal(r.passed, false)
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'cross_site_request')
})

test('same-site também é bloqueado (outro app sob o mesmo domínio registrável)', () => {
  const r = call({ headers: { 'sec-fetch-site': 'same-site', origin: 'https://other-app.aws.databricksapps.com' } })
  assert.equal(r.status, 403)
})

test('Sec-Fetch-Site same-origin ou none: passa', () => {
  assert.equal(call({ headers: { 'sec-fetch-site': 'same-origin', origin: 'https://whatever.example' } }).passed, true)
  assert.equal(call({ headers: { 'sec-fetch-site': 'none' } }).passed, true)
})

test('sem Sec-Fetch-Site: Origin igual ao host da requisição passa', () => {
  assert.equal(call({ headers: { origin: 'http://localhost:8000' } }).passed, true)
  assert.equal(call({ headers: { origin: `https://${APP_HOST}`, 'x-forwarded-host': APP_HOST } }).passed, true)
})

test('sem Sec-Fetch-Site: Origin igual ao DATABRICKS_APP_URL passa', () => {
  const env = { DATABRICKS_APP_URL: `https://${APP_HOST}` }
  assert.equal(call({ env, headers: { origin: `https://${APP_HOST}` } }).passed, true)
})

test('sem Sec-Fetch-Site: Origin alheio ou "null" é bloqueado', () => {
  assert.equal(call({ headers: { origin: 'https://evil.example' } }).status, 403)
  assert.equal(call({ headers: { origin: 'null' } }).status, 403)
  // same host name, different port = different origin
  assert.equal(call({ headers: { origin: 'http://localhost:9999' } }).status, 403)
})

test('só Referer: compara o host do Referer', () => {
  assert.equal(call({ headers: { referer: 'http://localhost:8000/chat/3' } }).passed, true)
  assert.equal(call({ headers: { referer: 'https://evil.example/x' } }).status, 403)
})

test('sem nenhum dos três cabeçalhos (curl, servidor-a-servidor, testes): passa', () => {
  assert.equal(call({ headers: {} }).passed, true)
})

test('GET, HEAD e OPTIONS nunca são bloqueados', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const r = call({ method, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } })
    assert.equal(r.passed, true, method)
  }
})

test('PUT, PATCH e DELETE cross-site são bloqueados como o POST', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = call({ method, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } })
    assert.equal(r.status, 403, method)
  }
})

// QA r1 (PR #59): default ports are normalized on both sides before comparing
// (:443 for https, :80 for http); any other port is a different origin.
test('porta padrão explícita no Host, Origin normalizado: mesma origem (https :443 e http :80)', () => {
  assert.equal(call({ headers: { host: 'APP.EXAMPLE.COM:443', origin: 'https://app.example.com' } }).passed, true)
  assert.equal(call({ headers: { host: 'app.example.com:80', origin: 'http://app.example.com' } }).passed, true)
  assert.equal(call({ headers: { host: 'proxy.internal', 'x-forwarded-host': 'app.example.com:443', origin: 'https://app.example.com' } }).passed, true)
})

test('porta padrão explícita no Origin/Referer/APP_URL, Host sem porta: mesma origem', () => {
  assert.equal(call({ headers: { host: 'app.example.com', origin: 'https://app.example.com:443' } }).passed, true)
  assert.equal(call({ headers: { host: 'app.example.com', origin: 'http://app.example.com:80' } }).passed, true)
  assert.equal(call({ headers: { host: 'app.example.com', referer: 'https://app.example.com:443/chat/1' } }).passed, true)
  const env = { DATABRICKS_APP_URL: 'https://app.example.com:443' }
  assert.equal(call({ env, headers: { host: 'proxy.internal', origin: 'https://app.example.com' } }).passed, true)
})

test('porta não padrão continua sendo outra origem, nos dois sentidos', () => {
  assert.equal(call({ headers: { host: 'app.example.com:8443', origin: 'https://app.example.com' } }).status, 403)
  assert.equal(call({ headers: { host: 'app.example.com', origin: 'https://app.example.com:8443' } }).status, 403)
  // the default port of the OTHER scheme is not a default here
  assert.equal(call({ headers: { host: 'app.example.com:80', origin: 'https://app.example.com' } }).status, 403)
  assert.equal(call({ headers: { host: 'app.example.com:443', origin: 'http://app.example.com' } }).status, 403)
})

// QA r2: DATABRICKS_APP_URL is a full origin, so its scheme counts. Same host and
// numeric port over the other scheme is a different origin.
test('DATABRICKS_APP_URL: esquema conta (http na :443 não casa com app https)', () => {
  const env = { DATABRICKS_APP_URL: 'https://app.example.com' }
  assert.equal(call({ env, headers: { host: 'proxy.internal', origin: 'http://app.example.com:443' } }).status, 403)
  assert.equal(call({ env, headers: { host: 'proxy.internal', origin: 'http://app.example.com' } }).status, 403)
  assert.equal(call({ env, headers: { host: 'proxy.internal', origin: 'https://app.example.com' } }).passed, true)
  assert.equal(call({ env: { DATABRICKS_APP_URL: 'http://app.example.com:80' }, headers: { host: 'proxy.internal', origin: 'http://app.example.com' } }).passed, true)
  assert.equal(call({ env: { DATABRICKS_APP_URL: 'http://app.example.com' }, headers: { host: 'proxy.internal', origin: 'https://app.example.com:80' } }).status, 403)
})

// W1-4: the browser's own verdict "cross-site" is final. An Origin that happens
// to equal Host (a proxy rewriting Host, a forged-looking but inconsistent
// request) must not re-open the door.
test('Sec-Fetch-Site: cross-site é 403 mesmo com Origin igual ao host', () => {
  const r = call({ headers: { host: APP_HOST, origin: `https://${APP_HOST}`, 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 403)
  const viaAppUrl = call({
    env: { DATABRICKS_APP_URL: `https://${APP_HOST}` },
    headers: { host: 'proxy.internal', origin: `https://${APP_HOST}`, 'sec-fetch-site': 'Cross-Site' },
  })
  assert.equal(viaAppUrl.status, 403)
})
