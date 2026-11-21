// N7 item 2: the MCP admission cache is keyed per user + service, not per
// service. One user's classification (it depends on THEIR login check) must
// never admit or refuse the same service for another user.
//
//   node --test server/mcpAdmissionPerUser.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ext from './externalMcp.ts'

const { admitMcpConnection, mcpAdmissionForTurn, resetMcpAdmissionCache } = ext
const SVC = 'acme.tools.per_user_oauth'
const A = 'a@example.com'
const B = 'b@example.com'

function classifier(byUser) {
  const calls = []
  const fn = (name, { adminToken }) => {
    calls.push({ name, token: adminToken })
    return Promise.resolve({ credentialClass: byUser[adminToken] || 'unverified', credentialType: null })
  }
  fn.calls = calls
  return fn
}

test.beforeEach(() => resetMcpAdmissionCache())

test('N7-2: user A being admitted does not admit user B: B is classified on its own', async () => {
  const classify = classifier({ 'tok-a': 'per_user', 'tok-b': 'shared' })
  assert.equal((await admitMcpConnection('tok-a', A, SVC, { catalog: [], classify })).ok, true)
  const b = await admitMcpConnection('tok-b', B, SVC, { catalog: [], classify })
  assert.equal(b.ok, false, 'B must not inherit A\'s cached class')
  assert.equal(classify.calls.length, 2, 'one classification per user')
})

test('N7-2: the turn-time read is per user too: A\'s warm entry leaves B cold', async () => {
  const classify = classifier({ 'tok-a': 'per_user' })
  await admitMcpConnection('tok-a', A, SVC, { catalog: [], classify })
  assert.equal(mcpAdmissionForTurn('tok-a', A, SVC).ok, true)
  const b = mcpAdmissionForTurn('tok-b', B, SVC)
  assert.equal(b.ok, false)
  assert.equal(b.cold, true)
})

test('N7-2: the same user is still served from the cache (no reclassification)', async () => {
  const classify = classifier({ 'tok-a': 'per_user' })
  await admitMcpConnection('tok-a', A, SVC, { catalog: [], classify })
  await admitMcpConnection('tok-a', A, SVC, { catalog: [], classify })
  assert.equal(classify.calls.length, 1)
})
