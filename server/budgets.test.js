import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveBudget, budgetState, validateBudgetSettings, validateBudgetRule } from './budgets.js'

const on = { enabled: true, defaultUsd: 100, enforcement: 'warn', warnPct: 80, timezone: 'UTC' }
const rules = [
  { kind: 'group', principal: 'eng_dados', monthlyUsd: 200 },
  { kind: 'group', principal: 'diretoria', monthlyUsd: 1000 },
  { kind: 'group', principal: 'estagiarios', monthlyUsd: 20 },
  { kind: 'user', principal: 'paulo.machado@empresa.com', monthlyUsd: 500 },
]

test('Paulo: nominal US$ 500 beats his group eng_dados (US$ 200)', () => {
  const b = effectiveBudget({ settings: on, rules, email: 'Paulo.Machado@empresa.com', groups: new Set(['eng_dados']) })
  assert.deepEqual(b, { limitUsd: 500, source: { kind: 'user', principal: 'paulo.machado@empresa.com' } })
})

test('the largest applicable override wins, even over a user rule', () => {
  const b = effectiveBudget({ settings: on, rules, email: 'paulo.machado@empresa.com', groups: new Set(['eng_dados', 'diretoria']) })
  assert.equal(b.limitUsd, 1000)
  assert.deepEqual(b.source, { kind: 'group', principal: 'diretoria' })
})

test('a group override sets each member budget, replacing the default (even if lower)', () => {
  const b = effectiveBudget({ settings: on, rules, email: 'ana@empresa.com', groups: new Set(['estagiarios']) })
  assert.equal(b.limitUsd, 20)
  assert.equal(b.source.kind, 'group')
})

test('no override → default; budgets off → null', () => {
  assert.deepEqual(effectiveBudget({ settings: on, rules, email: 'x@empresa.com', groups: new Set() }), {
    limitUsd: 100,
    source: { kind: 'default', principal: null },
  })
  assert.equal(effectiveBudget({ settings: { ...on, enabled: false }, rules, email: 'paulo.machado@empresa.com', groups: new Set() }), null)
})

test('SCIM unavailable (no groups resolved) falls back to user rule / default', () => {
  assert.equal(effectiveBudget({ settings: on, rules, email: 'paulo.machado@empresa.com', groups: new Set() }).limitUsd, 500)
  assert.equal(effectiveBudget({ settings: on, rules, email: 'ana@empresa.com', groups: new Set() }).limitUsd, 100)
})

test('budgetState thresholds', () => {
  assert.equal(budgetState(10, 100, 80), 'ok')
  assert.equal(budgetState(80, 100, 80), 'warn')
  assert.equal(budgetState(100, 100, 80), 'exceeded')
  assert.equal(budgetState(0, 0, 80), 'exceeded') // a US$ 0 budget allows nothing
  assert.equal(budgetState(5, null, 80), null)
})

test('validateBudgetSettings: default required when enabled, ranges, IANA zone', () => {
  assert.equal(validateBudgetSettings({ enabled: true }).error, 'default_required')
  assert.equal(validateBudgetSettings({ enabled: true, defaultUsd: 0 }).error, 'default_invalid')
  assert.equal(validateBudgetSettings({ enabled: true, defaultUsd: 50, enforcement: 'nuke' }).error, 'enforcement_invalid')
  assert.equal(validateBudgetSettings({ enabled: true, defaultUsd: 50, warnPct: 100 }).error, 'warn_pct_invalid')
  assert.equal(validateBudgetSettings({ enabled: true, defaultUsd: 50, timezone: 'Mars/Olympus' }).error, 'timezone_invalid')
  assert.deepEqual(validateBudgetSettings({ enabled: true, defaultUsd: '49.999', enforcement: 'block', warnPct: 90, timezone: 'America/Sao_Paulo' }).value, {
    enabled: true, defaultUsd: 50, enforcement: 'block', warnPct: 90, timezone: 'America/Sao_Paulo',
  })
  // turning budgets off never requires a default
  assert.equal(validateBudgetSettings({ enabled: false }).value.enabled, false)
})

test('validateBudgetRule: normalizes the principal, rejects bad input', () => {
  assert.deepEqual(validateBudgetRule({ kind: 'group', principal: '  Eng_Dados ', monthlyUsd: 200 }).value, {
    kind: 'group', principal: 'eng_dados', monthlyUsd: 200,
  })
  assert.equal(validateBudgetRule({ kind: 'team', principal: 'x', monthlyUsd: 1 }).error, 'kind_invalid')
  assert.equal(validateBudgetRule({ kind: 'user', principal: '', monthlyUsd: 1 }).error, 'principal_invalid')
  assert.equal(validateBudgetRule({ kind: 'user', principal: 'a@b.c', monthlyUsd: -1 }).error, 'amount_invalid')
})
