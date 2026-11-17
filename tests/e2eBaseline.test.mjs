// Tests for client/e2e/baseline.mjs: how the e2e/a11y job turns 16 axe runs
// plus Lighthouse and the token audit into numbers, and when it fails.
//   node --test tests/e2eBaseline.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateRuns, compareToBaseline, strictFailures, baselineFor } from '../client/e2e/baseline.mjs'

const runs = [
  { screen: 'welcome', variant: 'dark-desktop', axe: [{ id: 'color-contrast', impact: 'serious', nodes: 3 }, { id: 'region', impact: 'moderate', nodes: 2 }], touch: { under24: 1, noName: 2 } },
  { screen: 'welcome', variant: 'dark-mobile', axe: [{ id: 'color-contrast', impact: 'serious', nodes: 4 }, { id: 'button-name', impact: 'critical', nodes: 1 }], touch: { under24: 0, noName: 1 } },
]

test('aggregateRuns sums axe nodes per rule, serious+critical nodes, small targets and unnamed elements', () => {
  assert.deepEqual(aggregateRuns(runs), {
    axe: { 'button-name': 1, 'color-contrast': 7, region: 2 },
    seriousCritical: 8,
    touchUnder24: 1,
    unnamed: 3,
  })
})

const base = {
  axe: { 'color-contrast': 7, region: 2, 'button-name': 1 },
  seriousCritical: 8,
  touchUnder24: 1,
  unnamed: 3,
  lighthouse: { welcome: 84, chat: 92, history: 62 },
  oneOff: { total: 538, byKind: { style_props_any: 69 } },
}

test('compareToBaseline: equal numbers pass', () => {
  assert.deepEqual(compareToBaseline(structuredClone(base), base).regressions, [])
})

test('compareToBaseline fails on any rise: an axe rule, a new rule, targets, names, one-off styles', () => {
  const cur = structuredClone(base)
  cur.axe['color-contrast'] = 8
  cur.axe.label = 1
  cur.touchUnder24 = 2
  cur.unnamed = 4
  cur.oneOff.total = 539
  cur.oneOff.byKind.style_props_any = 70
  const r = compareToBaseline(cur, base).regressions.join('\n')
  assert.match(r, /axe color-contrast: 8 > 7/)
  assert.match(r, /axe label: 1 > 0/)
  assert.match(r, /touch targets < 24 px: 2 > 1/)
  assert.match(r, /unnamed interactive elements: 4 > 3/)
  assert.match(r, /one-off styles: 539 > 538/)
  assert.match(r, /one-off style_props_any: 70 > 69/)
})

test('compareToBaseline fails when a Lighthouse score drops and reports improvements', () => {
  const cur = structuredClone(base)
  cur.lighthouse.history = 61
  cur.lighthouse.welcome = 90
  cur.axe.region = 0
  const { regressions, improvements } = compareToBaseline(cur, base)
  assert.deepEqual(regressions, ['lighthouse history: 61 < 62'])
  assert.ok(improvements.includes('axe region: 0 < 2'))
  assert.ok(improvements.includes('lighthouse welcome: 90 > 84'))
})

test('strictFailures (E2E_STRICT=1) fails on any serious or critical node', () => {
  assert.deepEqual(strictFailures({ seriousCritical: 0 }), [])
  assert.match(strictFailures({ seriousCritical: 8 }).join(' '), /8 serious\/critical axe nodes/)
})

test('baselineFor picks the platform entry and explains how to record a missing one', () => {
  const file = { platforms: { linux: base } }
  assert.equal(baselineFor(file, 'linux'), base)
  assert.throws(() => baselineFor(file, 'win32'), /no e2e baseline for platform "win32".*E2E_UPDATE_BASELINE=1/)
})

test('compareToBaseline: one more serious/critical node is a regression even without E2E_STRICT', () => {
  const cur = structuredClone(base)
  cur.seriousCritical = base.seriousCritical + 1
  assert.deepEqual(compareToBaseline(cur, base).regressions, ['axe serious/critical nodes: 9 > 8'])
  cur.seriousCritical = base.seriousCritical - 1
  assert.ok(compareToBaseline(cur, base).improvements.includes('axe serious/critical nodes: 7 < 8'))
})
