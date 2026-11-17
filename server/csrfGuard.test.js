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
