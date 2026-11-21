// Pure helpers of the Costs page (costsData.js): period presets and labels,
// locale-aware money formatting, the CSV export, the API query string, and
// the i18n keys the page uses (present in en, pt and es).
//
//   node --test client/src/components/costs/costsData.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PERIOD_PRESETS,
  presetPeriod,
  periodLabel,
  formatUsd,
  formatNumber,
  toCsv,
  csvFilename,
  costsQuery,
  COLUMNS,
  COSTS_I18N_KEYS,
  errorState,
} from './costsData.js'
import catalogs from '../../lib/locales/index.ts'

test('period presets: 7, 30 and 90 days ending today (UTC calendar days)', () => {
  assert.deepEqual(PERIOD_PRESETS, [7, 30, 90])
  const today = new Date('2026-11-18T23:30:00Z')
  assert.deepEqual(presetPeriod(30, today), { from: '2026-10-20', to: '2026-11-18' })
  assert.deepEqual(presetPeriod(7, today), { from: '2026-11-12', to: '2026-11-18' })
  assert.deepEqual(presetPeriod(90, new Date('2026-03-01T00:10:00Z')), { from: '2025-12-02', to: '2026-03-01' })
})

test('periodLabel: day/month order per locale, and no off-by-one west of UTC', () => {
  const p = { from: '2026-10-01', to: '2026-10-31' }
  // an ISO date parsed as local midnight would show 30/09 in São Paulo (UTC-3)
  assert.equal(periodLabel(p, 'pt-BR'), '01/10/2026 – 31/10/2026')
  assert.equal(periodLabel(p, 'en-US'), '10/01/2026 – 10/31/2026')
  assert.equal(periodLabel(p, 'es'), '1/10/2026 – 31/10/2026')
})

test('formatUsd / formatNumber follow the UI locale', () => {
  assert.equal(formatUsd(1234.5, 'en-US'), '$1,234.50')
  assert.equal(formatUsd(1234.5, 'pt-BR').replace(/\s/g, ' '), 'US$ 1.234,50')
  assert.equal(formatUsd(0.0042, 'en-US'), '$0.0042') // sub-cent amounts keep their digits
  assert.equal(formatUsd(null, 'en-US'), '—')
  assert.equal(formatNumber(1200000, 'pt-BR'), '1.200.000')
  assert.equal(formatNumber(null, 'en-US'), '—')
})

test('columns per breakdown match the server rows', () => {
  assert.deepEqual(COLUMNS.resource, ['product', 'resource_id', 'dbus', 'usd'])
  assert.deepEqual(COLUMNS.model, ['endpoint_name', 'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'dbus', 'usd'])
  assert.deepEqual(COLUMNS.person, ['user_email', 'requests', 'total_tokens', 'dbus', 'usd'])
  assert.deepEqual(COLUMNS.tag, ['tag_value', 'infra_usd', 'ai_usd', 'dbus', 'usd'])
})

test('toCsv: header row, RFC 4180 quoting, raw numbers, and no spreadsheet formula injection', () => {
  const rows = [
    { user_email: 'ana@example.com', requests: 4, total_tokens: 1200, dbus: 0.5, usd: 0.035 },
    { user_email: '=HYPERLINK("http://x","y")', requests: 1, total_tokens: 10, dbus: null, usd: null },
    { user_email: 'a,b "c"\nd', requests: 2, total_tokens: 20, dbus: -1, usd: 1 },
    { user_email: '+1', requests: 0, total_tokens: 0, dbus: 0, usd: 0 },
  ]
  const csv = toCsv(COLUMNS.person, rows)
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'user_email,requests,total_tokens,dbus,usd')
  assert.equal(lines[1], 'ana@example.com,4,1200,0.5,0.035')
  assert.equal(lines[2], `"'=HYPERLINK(""http://x"",""y"")",1,10,,`)
  assert.ok(csv.includes('"a,b ""c""\nd",2,20,-1,1'), 'quoted cell with comma, quotes and newline; negative number kept')
  assert.ok(csv.includes("'+1,0,0,0,0"))
  assert.ok(csv.endsWith('\r\n'))
})

test('csvFilename names the breakdown and the period', () => {
  assert.equal(csvFilename('model', { from: '2026-10-01', to: '2026-10-31' }), 'ai-prism-costs-model-2026-10-01_2026-10-31.csv')
})

test('costsQuery: only known params, URL-encoded', () => {
  assert.equal(costsQuery({ by: 'tag', from: '2026-10-01', to: '2026-10-31', tag: 'área x' }), 'by=tag&from=2026-10-01&to=2026-10-31&tag=%C3%A1rea+x')
  assert.equal(costsQuery({ by: 'model', from: '2026-10-01', to: '2026-10-31', tag: 'ignored' }), 'by=model&from=2026-10-01&to=2026-10-31')
})

test('errorState maps HTTP status + server code to the page state', () => {
  assert.equal(errorState(403, 'no_access'), 'noAccess')
  assert.equal(errorState(403, undefined), 'notAdmin')
  assert.equal(errorState(503, 'no_warehouse'), 'noWarehouse')
  assert.equal(errorState(400, 'bad_period'), 'badPeriod')
  assert.equal(errorState(502, 'query_failed'), 'error')
  assert.equal(errorState(0, undefined), 'error')
})

test('every key the Costs page uses exists in en, pt and es', () => {
  assert.ok(COSTS_I18N_KEYS.length > 20)
  for (const lang of ['en', 'pt', 'es']) {
    const missing = COSTS_I18N_KEYS.filter((k) => typeof catalogs[lang][k] !== 'string' || !catalogs[lang][k].trim())
    assert.deepEqual(missing, [], lang)
  }
})
