import test from 'node:test'
import assert from 'node:assert/strict'
import { assertUserCredentialsAllowed, currentRunAs, SP_NO_USER_CREDENTIALS, withRunIdentity } from './runIdentity.ts'

test('outside any run there is no run identity and user credentials are allowed', () => {
  assert.equal(currentRunAs(), null)
  assert.doesNotThrow(() => assertUserCredentialsAllowed('conexão MCP'))
})

test('a user run may use user credentials', async () => {
  await withRunIdentity({ runAs: 'user' }, async () => {
    assert.equal(currentRunAs(), 'user')
    assert.doesNotThrow(() => assertUserCredentialsAllowed('conexão MCP'))
  })
})

test('an app_sp run fails closed on user credentials, across awaits and timers', async () => {
  await withRunIdentity({ runAs: 'app_sp' }, async () => {
    await new Promise((r) => setTimeout(r, 5))
    await Promise.resolve()
    assert.throws(() => assertUserCredentialsAllowed('conexão MCP'), (e: { code?: string }) => e.code === SP_NO_USER_CREDENTIALS)
  })
})

test('app_sp is sticky: a nested run cannot downgrade it to user', async () => {
  await withRunIdentity({ runAs: 'app_sp' }, async () => {
    await withRunIdentity({ runAs: 'user' }, async () => {
      assert.equal(currentRunAs(), 'app_sp')
      assert.throws(() => assertUserCredentialsAllowed('x'))
    })
  })
  assert.equal(currentRunAs(), null)
})

test('the caller may build the error', async () => {
  await withRunIdentity({ runAs: 'app_sp' }, async () => {
    assert.throws(() => assertUserCredentialsAllowed('x', (code, message) => new RangeError(`${code}: ${message}`)), RangeError)
  })
})
