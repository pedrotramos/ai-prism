import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveBudget, budgetState, validateBudgetSettings, validateBudgetRule, meterView, meterMonthMode } from './budgets.js'

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
    enabled: true, defaultUsd: 50, enforcement: 'block', warnPct: 90, timezone: 'America/Sao_Paulo', meterSession: true, meterMonth: 'usd',
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

// ---- taxímetro visibility (admin decides what users see) ----------------------
test('display settings: defaults, validation, pct needs budgets on', () => {
  const d = validateBudgetSettings({ enabled: false }).value
  assert.equal(d.meterSession, true)
  assert.equal(d.meterMonth, 'usd')
  assert.equal(validateBudgetSettings({ meterMonth: 'eur' }).error, 'meter_month_invalid')
  assert.equal(validateBudgetSettings({ meterSession: 'no' }).error, 'meter_session_invalid')
  // budgets off → a percentage of nothing: back to dollars
  assert.equal(validateBudgetSettings({ enabled: false, meterMonth: 'pct' }).value.meterMonth, 'usd')
  assert.equal(validateBudgetSettings({ enabled: true, defaultUsd: 50, meterMonth: 'pct' }).value.meterMonth, 'pct')
  assert.equal(validateBudgetSettings({ enabled: false, meterMonth: 'hidden', meterSession: false }).value.meterMonth, 'hidden')
})

const summary = () => ({
  month: { start: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', timezone: 'UTC', usd: 42.5, estimated: false, unpriced: false },
  session: { id: '7', usd: 1.25, byKind: { chat: { usd: 1.25, calls: 3 } }, estimated: false, unpriced: false },
  budget: { limitUsd: 100, remainingUsd: 57.5, pct: 42.5, source: { kind: 'default', principal: null }, warnPct: 80, enforcement: 'block', state: 'ok', groupCheck: null },
})
// every key holding a dollar amount anywhere in the payload
const dollarKeys = (o, path = '') =>
  Object.entries(o || {}).flatMap(([k, v]) =>
    v && typeof v === 'object' ? dollarKeys(v, `${path}${k}.`) : /usd/i.test(k) ? [`${path}${k}`] : []
  )

test('meterView: usd mode with session passes everything through', () => {
  const v = meterView(summary(), { enabled: true, meterSession: true, meterMonth: 'usd' })
  assert.deepEqual(v.display, { session: true, month: 'usd' })
  assert.equal(v.month.usd, 42.5)
  assert.equal(v.session.usd, 1.25)
  assert.equal(v.budget.limitUsd, 100)
})

test('meterView: session off drops the conversation cost', () => {
  const v = meterView(summary(), { enabled: true, meterSession: false, meterMonth: 'usd' })
  assert.equal(v.session, null)
  assert.equal(v.display.session, false)
  assert.equal(v.month.usd, 42.5)
})

test('meterView: pct mode carries no dollar amounts, only the share and state', () => {
  const v = meterView(summary(), { enabled: true, meterSession: false, meterMonth: 'pct' })
  assert.deepEqual(dollarKeys(v), [])
  assert.equal(v.budget.pct, 42.5)
  assert.equal(v.budget.state, 'ok')
  assert.equal(v.budget.enforcement, 'block')
  assert.equal(v.month.resetsAt, '2026-12-01T00:00:00.000Z')
})

test('meterView: hidden mode keeps only what the blocked notice needs', () => {
  const v = meterView(summary(), { enabled: true, meterSession: false, meterMonth: 'hidden' })
  assert.deepEqual(dollarKeys(v), [])
  assert.deepEqual(v.budget, { state: 'ok', enforcement: 'block' })
  assert.deepEqual(Object.keys(v.month).sort(), ['resetsAt', 'start', 'timezone'])
})

test('meterView: pct without a budget (or settings) falls back to dollars', () => {
  const s = { ...summary(), budget: null }
  assert.equal(meterView(s, { enabled: true, meterMonth: 'pct' }).display.month, 'usd')
  assert.equal(meterMonthMode({ enabled: false, meterMonth: 'pct' }, { limitUsd: 1 }), 'usd')
  // no settings at all (config failed to load) → today's behavior
  assert.deepEqual(meterView(summary(), null).display, { session: true, month: 'usd' })
})
