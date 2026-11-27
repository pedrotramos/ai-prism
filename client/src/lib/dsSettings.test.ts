import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceSourceOf, chartColorsOf, isHex } from './dsSettings.ts'

test('priceSourceOf: a typed override is negotiated, a curated price is the list price, else none', () => {
  assert.equal(priceSourceOf({ priceIn: 3, priceOut: null, inferredPriceIn: 1, inferredPriceOut: 2 }), 'negotiated')
  assert.equal(priceSourceOf({ priceIn: null, priceOut: 9, inferredPriceIn: null, inferredPriceOut: null }), 'negotiated')
  assert.equal(priceSourceOf({ priceIn: null, priceOut: null, inferredPriceIn: 1, inferredPriceOut: 2 }), 'list')
  assert.equal(priceSourceOf({ priceIn: null, priceOut: null, inferredPriceIn: null, inferredPriceOut: null }), 'none')
  assert.equal(priceSourceOf({ priceIn: null, priceOut: null }), 'none')
})

test('isHex accepts only #rrggbb', () => {
  assert.equal(isHex('#0E6B5C'), true)
  assert.equal(isHex('0E6B5C'), false)
  assert.equal(isHex('#abc'), false)
  assert.equal(isHex(undefined), false)
})

test('chartColorsOf: palette tokens named like chart/series come first, then the core colours; valid, unique, capped', () => {
  const out = chartColorsOf({
    primaryColor: '#111111',
    secondaryColor: '#222222',
    accentColor: '#111111',
    backgroundColor: '#FFFFFF',
    palette: [
      { varName: '--chart-1', name: 'Series 1', value: '#AA0000' },
      { varName: '--brand-x', name: 'Brand', value: '#00AA00' },
      { varName: '--data-2', name: 'Series 2', value: 'not-a-colour' },
      { varName: '--series-3', name: 'S3', value: '#aa0000' },
    ],
  })
  assert.deepEqual(out, ['#AA0000', '#111111', '#222222'])
})

test('chartColorsOf: a template with nothing usable yields an empty list (the tab shows an honest empty state)', () => {
  assert.deepEqual(chartColorsOf({}), [])
  assert.deepEqual(chartColorsOf(null), [])
})

test('chartColorsOf: never more than 8 colours', () => {
  const palette = Array.from({ length: 12 }, (_, i) => ({ varName: `--chart-${i}`, name: `c${i}`, value: `#0000${(i + 16).toString(16)}` }))
  assert.equal(chartColorsOf({ palette }).length, 8)
})
