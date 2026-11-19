import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainRowState, overallState, activeRowIndex, forbiddenLast24h } from './webSearchStatus.js'

test('chainRowState: backend row → one card state', () => {
  const cases = [
    [{ kind: 'managed-mcp', state: 'up' }, 'up'],
    [{ kind: 'brave', state: 'unknown', keyPresent: true }, 'unknown'],
    [{ kind: 'managed-mcp', state: 'down', code: 'forbidden' }, 'forbidden'],
    [{ kind: 'external-mcp', state: 'down', code: 'unconfigured' }, 'no_tool'],
    [{ kind: 'managed-mcp', state: 'down', code: 'unconfigured' }, 'no_tool'],
    [{ kind: 'brave', state: 'down', code: 'unconfigured', keyPresent: false }, 'no_key'],
    [{ kind: 'tavily', state: 'unknown', keyPresent: false }, 'no_key'],
    [{ kind: 'searxng', state: 'down', code: 'unconfigured' }, 'unavailable'],
    [{ kind: 'tavily', state: 'down', code: 'quota' }, 'quota'],
    [{ kind: 'searxng', state: 'down', code: 'timeout' }, 'unavailable'],
    [{ kind: 'brave', state: 'down', code: 'bad_response' }, 'unavailable'],
    [{ kind: 'brave', state: 'down' }, 'unavailable'],
    [{ kind: 'brave', state: 'weird' }, 'unknown'],
    [null, 'unknown'],
  ]
  for (const [row, want] of cases) assert.equal(chainRowState(row), want, JSON.stringify(row))
})

test('overallState: policy off wins, then the backend off reason, then on', () => {
  assert.equal(overallState({ enabled: true, chain: [{}] }, false), 'policy_off')
  assert.equal(overallState({ enabled: false, offReason: 'kill_switch', chain: [] }, true), 'kill_switch')
  assert.equal(overallState({ enabled: false, offReason: 'backend_off', chain: [] }, true), 'backend_off')
  assert.equal(overallState({ enabled: false, offReason: 'invalid_backend', chain: [] }, true), 'invalid_backend')
  assert.equal(overallState({ enabled: false, offReason: 'none_configured', chain: [] }, true), 'none_configured')
  // an older backend without offReason: empty chain reads as nothing configured, never an error
  assert.equal(overallState({ mode: 'auto', enabled: false, chain: [] }, true), 'none_configured')
  assert.equal(overallState({ mode: 'off', enabled: false, chain: [] }, true), 'off')
  assert.equal(overallState({ enabled: true, chain: [{}] }, true), 'on')
  assert.equal(overallState(null, true), null)
})

test('activeRowIndex: first row that is not down; -1 when all are down', () => {
  assert.equal(activeRowIndex([{ state: 'down' }, { state: 'up' }, { state: 'unknown' }]), 1)
  assert.equal(activeRowIndex([{ state: 'unknown' }, { state: 'up' }]), 0)
  assert.equal(activeRowIndex([{ state: 'down' }]), -1)
  assert.equal(activeRowIndex([{ state: 'unknown', keyPresent: false, kind: 'brave' }]), -1, 'no key cannot be active')
  assert.equal(activeRowIndex([]), -1)
  assert.equal(activeRowIndex(undefined), -1)
})

test('forbiddenLast24h reads the count only', () => {
  assert.equal(forbiddenLast24h({ last24h: { byCode: { forbidden: 3 } } }), 3)
  assert.equal(forbiddenLast24h({ last24h: { byCode: {} } }), 0)
  assert.equal(forbiddenLast24h({}), 0)
})
