// Pure helpers of the web-search cost tile (toolUsageData.js): the API query,
// the zero-filled per-day series, the price editor rows and input parsing, the
// tile states and its i18n keys (present in en, pt and es).
//
//   node --test client/src/components/costs/toolUsageData.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  toolUsageQuery,
  fillDays,
  tileState,
  priceEditorRows,
  parsePriceInput,
  dailyChartBlock,
  WEB_SEARCH_TILE_I18N_KEYS,
} from './toolUsageData.js'
import catalogs from '../../lib/locales/index.js'

test('toolUsageQuery: kind and the same period the page uses', () => {
  assert.equal(toolUsageQuery({ from: '2026-11-01', to: '2026-11-18' }), 'kind=web_search&from=2026-11-01&to=2026-11-18')
})

test('fillDays: one point per UTC day of the period, zeros where the ledger has nothing', () => {
  const out = fillDays([{ day: '2026-11-02', calls: 3, unpricedCalls: 1, costUsd: 0.01 }], { from: '2026-11-01', to: '2026-11-03' })
  assert.deepEqual(out, [
    { day: '2026-11-01', calls: 0, costUsd: 0 },
    { day: '2026-11-02', calls: 3, costUsd: 0.01 },
    { day: '2026-11-03', calls: 0, costUsd: 0 },
  ])
  assert.deepEqual(fillDays([], { from: '2026-11-03', to: '2026-11-03' }), [{ day: '2026-11-03', calls: 0, costUsd: 0 }])
})

test('tileState: empty on zero calls, partial when some calls are unpriced, else ok', () => {
  assert.equal(tileState({ calls: 0, pricedCalls: 0, unpricedCalls: 0, costUsd: 0 }), 'empty')
  assert.equal(tileState({ calls: 10, pricedCalls: 6, unpricedCalls: 4, costUsd: 0.03 }), 'unpriced')
  assert.equal(tileState({ calls: 10, pricedCalls: 10, unpricedCalls: 0, costUsd: 0.05 }), 'ok')
  assert.equal(tileState(null), 'empty')
})

test('priceEditorRows: web_search first, then each provider seen; override and price in effect apart', () => {
  const rows = priceEditorRows({
    byProvider: [
      { provider: 'brave', pricePer1k: 5 },
      { provider: 'databricks', pricePer1k: null },
    ],
    prices: { web_search: null, 'web_search:brave': null, 'web_search:databricks': null },
  })
  assert.deepEqual(rows, [
    { key: 'web_search', provider: null, override: null, effective: null },
    { key: 'web_search:brave', provider: 'brave', override: null, effective: 5 },
    { key: 'web_search:databricks', provider: 'databricks', override: null, effective: null },
  ])
})

test('parsePriceInput: blank clears, 0..1000 accepted (comma or dot), everything else refused', () => {
  assert.deepEqual(parsePriceInput(''), { ok: true, value: null })
  assert.deepEqual(parsePriceInput('  '), { ok: true, value: null })
  assert.deepEqual(parsePriceInput('5'), { ok: true, value: 5 })
  assert.deepEqual(parsePriceInput('0'), { ok: true, value: 0 })
  assert.deepEqual(parsePriceInput('1000'), { ok: true, value: 1000 })
  assert.deepEqual(parsePriceInput('2,5'), { ok: true, value: 2.5 })
  for (const bad of ['-1', '1000.01', 'abc', '1e9', 'NaN', '1,2,3', '5 USD']) assert.equal(parsePriceInput(bad).ok, false, bad)
})

test('dailyChartBlock: a bar chart block over calls per day (ChartBlock input), with a text alternative title', () => {
  const b = dailyChartBlock([{ day: '2026-11-01', calls: 2, costUsd: 0 }], { title: 'Calls per day', seriesLabel: 'Calls' })
  assert.equal(b.type, 'chart')
  assert.equal(b.title, 'Calls per day')
  assert.equal(b.chartType, 'bar')
  assert.deepEqual(b.series, [{ name: 'Calls', data: [{ label: '2026-11-01', value: 2 }] }])
})

test('every key the tile uses exists in en, pt and es', () => {
  assert.ok(WEB_SEARCH_TILE_I18N_KEYS.length > 10)
  for (const lang of ['en', 'pt', 'es']) {
    const missing = WEB_SEARCH_TILE_I18N_KEYS.filter((k) => typeof catalogs[lang][k] !== 'string' || !catalogs[lang][k].trim())
    assert.deepEqual(missing, [], `${lang}: ${missing.join(', ')}`)
  }
})
