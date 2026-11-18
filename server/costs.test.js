// Billed-cost queries for the admin Costs page (server/costs.js): period
// parsing, the parameterised statements over system.billing.usage and
// system.serving.endpoint_usage, error classification and row shaping. No
// warehouse: the statement executor is injected.
//
//   node --test server/costs.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BREAKDOWNS,
  DEFAULT_PERIOD_DAYS,
  MAX_PERIOD_DAYS,
  CostsError,
  parsePeriod,
  costScope,
  buildCostQuery,
  classifyCostsError,
  queryCosts,
} from './costs.js'

const NOW = new Date('2026-11-18T15:00:00Z')
const ENV = { AI_PRISM_RESOURCE_TAGS: '{"cost_center":"1234","area":"Finanças"}' }

test('the four breakdowns of the design row, in page order', () => {
  assert.deepEqual(BREAKDOWNS, ['resource', 'model', 'person', 'tag'])
  assert.equal(DEFAULT_PERIOD_DAYS, 30)
  assert.equal(MAX_PERIOD_DAYS, 366)
})

test('parsePeriod: no dates → the last 30 days, today included (UTC)', () => {
  assert.deepEqual(parsePeriod({}, NOW), { from: '2026-10-20', to: '2026-11-18' })
})

test('parsePeriod: explicit ISO dates pass through', () => {
  assert.deepEqual(parsePeriod({ from: '2026-01-01', to: '2026-01-31' }, NOW), { from: '2026-01-01', to: '2026-01-31' })
  assert.deepEqual(parsePeriod({ from: '2026-11-18', to: '2026-11-18' }, NOW), { from: '2026-11-18', to: '2026-11-18' })
})

test('parsePeriod: rejects anything that is not a real ISO date, inverted ranges and spans over the cap', () => {
  const bad = [
    { from: "2026-01-01' OR 1=1 --", to: '2026-01-31' },
    { from: '01/02/2026', to: '2026-01-31' }, // pt-BR display format is never accepted on the wire
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-13-01', to: '2026-13-02' },
    { from: '2026-03-01', to: '2026-02-01' },
    { from: '2024-01-01', to: '2026-01-31' },
    { from: '2026-11-01', to: '2026-11-25' }, // ends in the future
    { from: ['2026-01-01'], to: '2026-01-31' },
    { from: '2026-01-01' }, // half a range
  ]
  for (const q of bad) {
    assert.throws(() => parsePeriod(q, NOW), (e) => e instanceof CostsError && e.status === 400 && e.code === 'bad_period', JSON.stringify(q))
  }
})

test('costScope: application stamp, app tag value, app name and the tag keys (operator keys, then ai_prism_app)', () => {
  const s = costScope({ ...ENV, DATABRICKS_APP_NAME: 'prism-prod' })
  assert.equal(s.application, 'ai-prism')
  assert.equal(s.appTag, 'prism-prod')
  assert.equal(s.appName, 'prism-prod')
  assert.deepEqual(s.tagKeys, ['cost_center', 'area', 'ai_prism_app'])
  const d = costScope({})
  assert.equal(d.appTag, 'ai-prism')
  assert.equal(d.appName, 'ai-prism')
  assert.deepEqual(d.tagKeys, ['ai_prism_app'])
})

function paramMap(parameters) {
  return Object.fromEntries(parameters.map((p) => [p.name, p]))
}

test('every breakdown is one parameterised statement: user input only travels as named parameters', () => {
  const scope = costScope(ENV)
  const period = { from: '2026-10-01', to: '2026-10-31' }
  for (const by of BREAKDOWNS) {
    const q = buildCostQuery(by, { ...period, tagKey: 'cost_center' }, scope)
    assert.ok(!q.statement.includes('2026-10-01'), `${by}: the date is inlined`)
    assert.ok(!q.statement.includes('cost_center'), `${by}: the tag key is inlined`)
    assert.ok(!q.statement.includes("'ai-prism'"), `${by}: the application stamp is inlined`)
    assert.match(q.statement, /system\.serving\.endpoint_usage/)
    assert.match(q.statement, /system\.billing\.usage/)
    assert.match(q.statement, /usage_context\['application'\]\s*=\s*:application/)
    const p = paramMap(q.parameters)
    assert.deepEqual(p.from, { name: 'from', value: '2026-10-01', type: 'DATE' })
    assert.deepEqual(p.to, { name: 'to', value: '2026-10-31', type: 'DATE' })
    assert.deepEqual(p.application, { name: 'application', value: 'ai-prism', type: 'STRING' })
    // every parameter sent is used, and every marker used is sent
    const markers = new Set([...q.statement.matchAll(/(?<![:\w]):([a-z_]+)/g)].map((m) => m[1]))
    assert.deepEqual([...markers].sort(), Object.keys(p).sort(), by)
    assert.ok(Array.isArray(q.columns) && q.columns.length > 0)
    assert.ok(q.columns.includes('usd'))
  }
})

test('resource: app-tagged infra plus the app by name, serving priced once (allocated, not double counted)', () => {
  const q = buildCostQuery('resource', { from: '2026-10-01', to: '2026-10-31' }, costScope({ DATABRICKS_APP_NAME: 'ai-prism' }))
  assert.match(q.statement, /custom_tags\['ai_prism_app'\]\s*=\s*:app_tag/)
  assert.match(q.statement, /usage_metadata\.app_name\s*=\s*:app_name/)
  assert.match(q.statement, /billing_origin_product\s*<>\s*'MODEL_SERVING'/)
  assert.deepEqual(q.columns, ['product', 'resource_id', 'dbus', 'usd'])
  const p = paramMap(q.parameters)
  assert.equal(p.app_tag.value, 'ai-prism')
  assert.equal(p.app_name.value, 'ai-prism')
})

test('model and person: columns of the page tables', () => {
  const scope = costScope({})
  assert.deepEqual(buildCostQuery('model', { from: '2026-10-01', to: '2026-10-31' }, scope).columns, [
    'endpoint_name',
    'requests',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'dbus',
    'usd',
  ])
  assert.deepEqual(buildCostQuery('person', { from: '2026-10-01', to: '2026-10-31' }, scope).columns, [
    'user_email',
    'requests',
    'total_tokens',
    'dbus',
    'usd',
  ])
})

test('tag: groups infra by custom_tags[:tag_key] and AI calls by usage_context[:tag_key]', () => {
  const q = buildCostQuery('tag', { from: '2026-10-01', to: '2026-10-31', tagKey: 'area' }, costScope(ENV))
  assert.match(q.statement, /custom_tags\[:tag_key\]/)
  assert.match(q.statement, /usage_context\[:tag_key\]/)
  assert.deepEqual(paramMap(q.parameters).tag_key, { name: 'tag_key', value: 'area', type: 'STRING' })
  assert.deepEqual(q.columns, ['tag_value', 'infra_usd', 'ai_usd', 'dbus', 'usd'])
})

test('tag: a key that is not one of the configured tags is refused; none given → the first configured key', () => {
  const scope = costScope(ENV)
  assert.throws(
    () => buildCostQuery('tag', { from: '2026-10-01', to: '2026-10-31', tagKey: "x'] OR 1=1 --" }, scope),
    (e) => e instanceof CostsError && e.status === 400 && e.code === 'bad_tag'
  )
  const q = buildCostQuery('tag', { from: '2026-10-01', to: '2026-10-31' }, scope)
  assert.equal(paramMap(q.parameters).tag_key.value, 'cost_center')
})

test('an unknown breakdown is a 400, not a query', () => {
  assert.throws(
    () => buildCostQuery('requester; DROP TABLE x', { from: '2026-10-01', to: '2026-10-31' }, costScope({})),
    (e) => e instanceof CostsError && e.status === 400 && e.code === 'bad_breakdown'
  )
})

test('classifyCostsError: missing system-table grants are a friendly 403 no_access, never a 500', () => {
  const noAccess = [
    '[INSUFFICIENT_PERMISSIONS] Insufficient privileges: User does not have USE SCHEMA on Schema system.billing.',
    'PERMISSION_DENIED: User does not have SELECT on Table system.serving.endpoint_usage',
    '[TABLE_OR_VIEW_NOT_FOUND] The table or view `system`.`serving`.`endpoint_usage` cannot be found.',
    'SQL Statement API: You do not have permission to use the SQL Warehouse',
  ]
  for (const m of noAccess) assert.deepEqual(classifyCostsError(new Error(m)), { status: 403, code: 'no_access' }, m)
  assert.deepEqual(classifyCostsError(new Error('SQL_WAREHOUSE_ID não configurado (necessário para executar tools).')), {
    status: 503,
    code: 'no_warehouse',
  })
  assert.deepEqual(classifyCostsError(new Error('Tempo esgotado aguardando o SQL Warehouse.')), { status: 504, code: 'timeout' })
  assert.deepEqual(classifyCostsError(new Error('boom')), { status: 502, code: 'query_failed' })
  assert.deepEqual(classifyCostsError(new CostsError(400, 'bad_period')), { status: 400, code: 'bad_period' })
})

test('queryCosts: runs with the caller token, numbers parsed, totals summed', async () => {
  const calls = []
  const exec = async (token, statement, parameters, opts) => {
    calls.push({ token, statement, parameters, opts })
    return {
      columns: ['endpoint_name', 'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'dbus', 'usd'],
      rows: [
        ['databricks-claude-sonnet-5-5', '120', '90000', '10000', '100000', '12.5', '0.875'],
        ['databricks-gpt-5', '30', '2000', '1000', '3000', null, null],
      ],
    }
  }
  const out = await queryCosts({ token: 'fake-obo-token', by: 'model', query: { from: '2026-10-01', to: '2026-10-31' }, env: {}, exec, now: NOW })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].token, 'fake-obo-token')
  assert.ok(calls[0].opts.timeoutMs >= 60000)
  assert.equal(out.by, 'model')
  assert.deepEqual(out.period, { from: '2026-10-01', to: '2026-10-31' })
  assert.equal(out.currency, 'USD')
  assert.deepEqual(out.rows[0], {
    endpoint_name: 'databricks-claude-sonnet-5-5',
    requests: 120,
    prompt_tokens: 90000,
    completion_tokens: 10000,
    total_tokens: 100000,
    dbus: 12.5,
    usd: 0.875,
  })
  assert.equal(out.rows[1].usd, null)
  assert.deepEqual(out.totals, { usd: 0.875, dbus: 12.5, requests: 150, total_tokens: 103000 })
})

test('queryCosts: a bad period never reaches the warehouse', async () => {
  let ran = false
  await assert.rejects(
    queryCosts({ token: 't', by: 'model', query: { from: 'yesterday', to: '2026-10-31' }, env: {}, exec: async () => ((ran = true), { columns: [], rows: [] }), now: NOW }),
    (e) => e.code === 'bad_period'
  )
  assert.equal(ran, false)
})
