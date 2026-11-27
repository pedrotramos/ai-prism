// The disposable-database guard must refuse exactly what the test clients would connect to (QA r4):
// the persistent dev database 127.0.0.1:55432/ai_prism, however the port or host is spelled, and CI=false
// must never mark it disposable.
//
//   node --test tests/helpers/disposableDb.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { disposableDbSkipReason } from './disposableDb.mjs'
import { testChildEnv } from '../run.mjs'

const target = (over) => ({ PGHOST: '127.0.0.1', PGPORT: '55432', PGDATABASE: 'ai_prism', ...over })

test('the persistent dev database is refused, any spelling of its port or host', () => {
  for (const over of [{}, { PGPORT: '055432' }, { PGPORT: '55432.0' }, { PGPORT: ' 55432' }, { PGPORT: '55432 ' }, { PGHOST: 'localhost' }, { PGHOST: '::1' }, { PGHOST: 'LOCALHOST' }, { PGHOST: '[::1]' }]) {
    assert.match(String(disposableDbSkipReason(target(over))), /refusing/, JSON.stringify(over))
  }
})

test('a throwaway cluster on another port, or another database name, is allowed', () => {
  assert.equal(disposableDbSkipReason(target({ PGPORT: '55871' })), null)
  assert.equal(disposableDbSkipReason(target({ PGDATABASE: 'scratch_db' })), null)
})

test('only CI=true (any case) marks the database disposable; false, 0, empty and unset do not', () => {
  for (const ci of ['true', 'TRUE', 'True']) assert.equal(testChildEnv({ CI: ci }).AI_PRISM_TEST_DISPOSABLE_DB, '1', ci)
  for (const ci of ['false', 'FALSE', '0', '', ' ', 'no', undefined]) {
    const env = ci === undefined ? {} : { CI: ci }
    assert.equal(testChildEnv(env).AI_PRISM_TEST_DISPOSABLE_DB, undefined, String(ci))
  }
})

test('an explicit AI_PRISM_TEST_DISPOSABLE_DB=1 from the runner that made the throwaway database is honoured', () => {
  assert.equal(disposableDbSkipReason(target({ AI_PRISM_TEST_DISPOSABLE_DB: '1' })), null)
})
