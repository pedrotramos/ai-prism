// The authorization descriptor and the fixed texts around it (server/userAuth.ts): no token, bounded, localized.
//
//   node --test server/userAuth.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTH_REASONS, authDescriptor, authRequiredText, identityKey, mcpAuthReason, mcpLoginUrl, pauseNotice } from './userAuth.ts'

test('authDescriptor: only the fixed fields, a known reason, bounded names', () => {
  const d = authDescriptor({ kind: 'a2a', id: 7, name: 'x'.repeat(500), provider: 'idp', providerName: 'Test IdP', reason: 'expired', loginUrl: null })
  assert.deepEqual(Object.keys(d).sort(), ['id', 'kind', 'name', 'provider', 'providerName', 'reason'])
  assert.equal(d.id, '7')
  assert.equal(d.name.length, 200)
  assert.equal(d.reason, 'expired')
  assert.equal(authDescriptor({ kind: 'a2a', id: 1, reason: 'whatever' }).reason, 'missing', 'an unknown reason is the default')
  for (const r of AUTH_REASONS) assert.equal(authDescriptor({ kind: 'mcp', id: 'a.b.c', reason: r }).reason, r)
})

test('the texts for the model and the chat: localized, quote the name safely, never carry a URL', () => {
  for (const lang of ['pt', 'en', 'es', 'fr']) {
    const t = authRequiredText('Echo "bad"\nname', lang)
    assert.match(t, /^AUTH_REQUIRED/)
    assert.ok(!/https?:\/\//.test(t))
    assert.ok(!t.includes('\n'))
  }
  assert.match(authRequiredText('Echo', 'en'), /Do not retry/)
  assert.match(pauseNotice([{ name: 'A' }, { name: 'A' }, { name: 'B' }], 'en'), /^_Waiting for your authorization for: A, B\._$/)
  assert.match(pauseNotice([{ name: 'A' }], 'es'), /Esperando tu autorización/)
})

test('identityKey: the forwarded e-mail, trimmed and lowercased', () => {
  assert.equal(identityKey('  Ana@Example.COM '), 'ana@example.com')
  assert.equal(identityKey(undefined), '')
})

test('mcpAuthReason: the gateway\'s "authorize first" answers, and not an access problem', () => {
  assert.equal(mcpAuthReason('The connection x is not connected for this user, or its credential has expired'), 'missing')
  assert.equal(mcpAuthReason('Request was rejected (HTTP 401)'), 'missing')
  assert.equal(mcpAuthReason('error_code UNAUTHENTICATED'), 'missing')
  assert.equal(mcpAuthReason('ACCESS_TOKEN_SCOPE_INSUFFICIENT'), 'insufficient_scope')
  assert.equal(mcpAuthReason('PERMISSION_DENIED: missing USE CONNECTION'), null)
  assert.equal(mcpAuthReason('timeout'), null)
  assert.equal(mcpAuthReason(''), null)
})

test('mcpLoginUrl: built from the catalog name and the workspace host, never from a gateway message', () => {
  const env = { DATABRICKS_HOST: 'adb-1.azuredatabricks.net', DATABRICKS_WORKSPACE_ID: '123' }
  assert.equal(mcpLoginUrl('main.mcp.github', env), 'https://adb-1.azuredatabricks.net/mcp-service-login?name=main.mcp.github&o=123')
  assert.equal(mcpLoginUrl('not a service', env), null)
  assert.equal(mcpLoginUrl('a.b.c', {}), null)
  assert.equal(mcpLoginUrl('a.b.c; evil', env), null)
})
