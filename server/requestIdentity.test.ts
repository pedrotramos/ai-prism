import test from 'node:test'
import assert from 'node:assert/strict'
import { devIdentityAllowed, identityKey, listenHost, requestIdentity } from './requestIdentity.ts'

const req = (headers = {}) => ({ headers })

test('runtime: a missing e-mail header means no identity, even with a token and env identity', () => {
  const env = { DATABRICKS_APP_NAME: 'ai-prism', DATABRICKS_USER_EMAIL: 'env@example.com', DATABRICKS_USER_TOKEN: 'env-token', LOCAL_DEV_MODE: '1' }
  const id = requestIdentity(req({ 'x-forwarded-access-token': 'obo' }), env)
  assert.equal(id.email, null)
  assert.equal(id.token, 'obo')
})

test('runtime: nothing from the environment when the headers are missing', () => {
  const env = { DATABRICKS_APP_PORT: '8000', DATABRICKS_USER_EMAIL: 'env@example.com', DATABRICKS_USER_TOKEN: 'env-token' }
  const id = requestIdentity(req(), env)
  assert.deepEqual([id.email, id.token, id.key], [null, null, null])
})

test('runtime headers win and the e-mail keeps its forwarded spelling', () => {
  const id = requestIdentity(req({ 'x-forwarded-email': 'Ana@Example.com', 'x-forwarded-access-token': 'obo' }), {})
  assert.equal(id.email, 'Ana@Example.com')
  assert.equal(id.key, 'ana@example.com')
})

test('local dev (LOCAL_DEV_MODE=1, no runtime markers) falls back to the environment', () => {
  const id = requestIdentity(req(), { LOCAL_DEV_MODE: '1', DATABRICKS_USER_EMAIL: 'dev@example.com', DATABRICKS_USER_TOKEN: 'dev-token' })
  assert.deepEqual([id.email, id.token], ['dev@example.com', 'dev-token'])
})

test('LOCAL_DEV_IDENTITY=1 allows the local fallback; NODE_ENV alone does not', () => {
  assert.equal(devIdentityAllowed({ LOCAL_DEV_IDENTITY: '1' }), true)
  assert.equal(devIdentityAllowed({ NODE_ENV: 'production' }), false)
  assert.equal(devIdentityAllowed({ LOCAL_DEV_MODE: '1', DATABRICKS_APP_URL: 'https://x.databricksapps.com' }), false)
})

test('the local token placeholder needs LOCAL_DEV_MODE=1 (not only LOCAL_DEV_IDENTITY)', () => {
  assert.equal(requestIdentity(req({ 'x-forwarded-email': 'a@b.c' }), { LOCAL_DEV_IDENTITY: '1' }).token, null)
  assert.equal(requestIdentity(req({ 'x-forwarded-email': 'a@b.c' }), { LOCAL_DEV_MODE: '1' }).token, 'local-dev-token')
})

test('identityKey lowercases and trims', () => {
  assert.equal(identityKey('  Ana@EXAMPLE.com '), 'ana@example.com')
  assert.equal(identityKey(''), '')
})

// P3: with the dev identity fallback on, anyone who can reach the port is the
// owner — so the dev server only listens on loopback. The Apps runtime (and any
// run without the dev fallback) keeps listening on every interface.
test('listenHost: loopback when the dev identity fallback is on, all interfaces otherwise', () => {
  assert.equal(listenHost({ LOCAL_DEV_MODE: '1' }), '127.0.0.1')
  assert.equal(listenHost({ LOCAL_DEV_IDENTITY: '1' }), '127.0.0.1')
  assert.equal(listenHost({}), '0.0.0.0')
  assert.equal(listenHost({ DATABRICKS_APP_PORT: '8000' }), '0.0.0.0')
  assert.equal(listenHost({ LOCAL_DEV_MODE: '1', DATABRICKS_APP_NAME: 'ai-prism' }), '0.0.0.0')
})
