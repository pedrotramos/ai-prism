// Shared chart-value rules (W2-9): the kinds a chart block may carry, the
// per-kind shape validation used by the server sanitizer AND the client
// renderer, the pivot matrix behind pivot/heatmap, deterministic histogram
// binning and the token-only heatmap shading. Expected values are by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHART_KINDS,
  isChartKind,
  toChartNumber,
  sanitizeChartSeries,
  pivotMatrix,
  histogramBins,
  parseColor,
  contrastRatio,
  heatColor,
  readableOn,
  formatChartValue,
} from './chartValue.js'

test('the eight kinds: the four originals plus pivot, heatmap, scatter, histogram (no map)', () => {
  assert.deepEqual([...CHART_KINDS], ['bar', 'line', 'area', 'pie', 'pivot', 'heatmap', 'scatter', 'histogram'])
  for (const k of CHART_KINDS) assert.equal(isChartKind(k), true)
  for (const k of ['map', 'choropleth', 'geo', '', null, undefined, 'BAR']) assert.equal(isChartKind(k), false)
})

test('toChartNumber: finite numbers and numeric strings, everything else null', () => {
  assert.equal(toChartNumber(3), 3)
  assert.equal(toChartNumber(' 4.5 '), 4.5)
  assert.equal(toChartNumber('abc'), null)
  assert.equal(toChartNumber(''), null)
  assert.equal(toChartNumber(null), null)
  assert.equal(toChartNumber(Infinity), null)
  assert.equal(toChartNumber(NaN), null)
})

test('label/value kinds keep the historical shape and coercion (non-numbers become 0)', () => {
  const out = sanitizeChartSeries('bar', [{ name: 'Receita', data: [{ label: 'Sul', value: '10' }, { label: 'Norte', value: 'x' }] }])
  assert.deepEqual(out, [{ name: 'Receita', data: [{ label: 'Sul', value: 10 }, { label: 'Norte', value: 0 }] }])
  // 6 series x 30 points cap is unchanged for the original kinds
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, data: Array.from({ length: 40 }, (_, j) => ({ label: `${j}`, value: j })) }))
  const capped = sanitizeChartSeries('line', many)
  assert.equal(capped.length, 6)
  assert.equal(capped[0].data.length, 30)
  assert.equal(sanitizeChartSeries('bar', 'nope'), null)
  assert.equal(sanitizeChartSeries('bar', [{ data: [] }]), null)
  assert.equal(sanitizeChartSeries('map', [{ name: 'a', data: [{ label: 'x', value: 1 }] }]), null)
})

test('pivot/heatmap: one series per column, missing cells stay null, rows aligned to the first series', () => {
  const series = [
    { name: '2024', data: [{ label: 'Sul', value: 10 }, { label: 'Norte', value: null }] },
    { name: '2025', data: [{ label: 'Norte', value: 7 }, { label: 'Sul', value: 12 }] },
  ]
  const out = sanitizeChartSeries('pivot', series)
  assert.deepEqual(out, [
    { name: '2024', data: [{ label: 'Sul', value: 10 }, { label: 'Norte', value: null }] },
    { name: '2025', data: [{ label: 'Sul', value: 12 }, { label: 'Norte', value: 7 }] },
  ])
  // up to 12 columns x 20 rows
  const wide = Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, data: Array.from({ length: 25 }, (_, j) => ({ label: `r${j}`, value: j })) }))
  const capped = sanitizeChartSeries('heatmap', wide)
  assert.equal(capped.length, 12)
  assert.equal(capped[0].data.length, 20)
})

test('scatter: points carry finite x and y; invalid points are dropped; up to 500 points', () => {
  const out = sanitizeChartSeries('scatter', [
    { name: 'Pedidos', data: [{ x: 1, y: '2', label: 'A' }, { x: 'x', y: 3 }, [4, 5], { x: 6, y: 7 }] },
  ])
  assert.deepEqual(out, [{ name: 'Pedidos', data: [{ label: 'A', x: 1, y: 2 }, { label: '', x: 4, y: 5 }, { label: '', x: 6, y: 7 }] }])
  const big = [{ name: 'p', data: Array.from({ length: 800 }, (_, i) => ({ x: i, y: i })) }]
  assert.equal(sanitizeChartSeries('scatter', big)[0].data.length, 500)
  assert.equal(sanitizeChartSeries('scatter', [{ name: 'p', data: [{ x: 'a', y: 'b' }] }]), null)
})

test('histogram: pre-binned label/value, or raw values binned deterministically', () => {
  const binned = sanitizeChartSeries('histogram', [{ name: 'Idade', data: [{ label: '0–10', value: 3 }] }])
  assert.deepEqual(binned, [{ name: 'Idade', data: [{ label: '0–10', value: 3 }] }])
  const raw = sanitizeChartSeries('histogram', [{ name: 'Idade', values: [1, 2, 2, 3, 3, 3, 4, 4, 5, 10] }])
  assert.equal(raw.length, 1)
  assert.equal(raw[0].data.reduce((a, d) => a + d.value, 0), 10, 'every value lands in exactly one bin')
  // only one series: a histogram is one distribution
  const two = sanitizeChartSeries('histogram', [{ name: 'a', values: [1, 2] }, { name: 'b', values: [1, 2] }])
  assert.equal(two.length, 1)
})

test('pivotMatrix: rows, columns, cells, totals, min and max', () => {
  const m = pivotMatrix([
    { name: '2024', data: [{ label: 'Sul', value: 10 }, { label: 'Norte', value: null }] },
    { name: '2025', data: [{ label: 'Sul', value: 12 }, { label: 'Norte', value: 7 }] },
  ])
  assert.deepEqual(m.rowLabels, ['Sul', 'Norte'])
  assert.deepEqual(m.colLabels, ['2024', '2025'])
  assert.deepEqual(m.cells, [[10, 12], [null, 7]])
  assert.deepEqual(m.rowTotals, [22, 7])
  assert.deepEqual(m.colTotals, [10, 19])
  assert.equal(m.total, 29)
  assert.equal(m.min, 7)
  assert.equal(m.max, 12)
})

test('histogramBins: Sturges bins, contiguous, last bin closed, deterministic labels', () => {
  const values = [1, 2, 2, 3, 3, 3, 4, 4, 5, 10]
  const a = histogramBins(values)
  const b = histogramBins([...values].reverse())
  assert.deepEqual(a, b, 'order of the input does not change the bins')
  assert.equal(a.length, 5) // ceil(log2 10) + 1
  assert.equal(a[0].x0, 1)
  assert.equal(a.at(-1).x1, 10)
  for (let i = 1; i < a.length; i++) assert.equal(a[i].x0, a[i - 1].x1)
  assert.equal(a.reduce((s, d) => s + d.value, 0), 10)
  assert.equal(a.at(-1).value, 1, 'the max lands in the last bin')
  assert.match(a[0].label, /^1–2\.8$/)
  // a constant column is one bin with every value
  assert.deepEqual(histogramBins([5, 5, 5]), [{ label: '5', value: 3, x0: 5, x1: 5 }])
  assert.deepEqual(histogramBins([]), [])
  assert.ok(histogramBins(Array.from({ length: 5000 }, (_, i) => i)).length <= 20, 'capped at 20 bins')
})

test('colour helpers: parse, WCAG contrast, token-to-token shading, readable label colour', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseColor('#1d64d8'), [29, 100, 216])
  assert.deepEqual(parseColor('rgb(29, 100, 216)'), [29, 100, 216])
  assert.equal(parseColor('var(--x)'), null)
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21)
  assert.equal(heatColor('#000000', '#ffffff', 0), '#000000')
  assert.equal(heatColor('#000000', '#ffffff', 1), '#ffffff')
  assert.equal(heatColor('#000000', '#ffffff', 0.5), '#808080')
  // the label colour is whichever of the two candidates reads better on the fill
  assert.equal(readableOn('#ffffff', ['#111111', '#eeeeee']), '#111111')
  assert.equal(readableOn('#000000', ['#111111', '#eeeeee']), '#eeeeee')
})

test('formatChartValue: locale numbers, an em dash for a missing cell', () => {
  assert.equal(formatChartValue(1234.5, 'en'), '1,234.5')
  assert.equal(formatChartValue(1234.5, 'pt-BR'), '1.234,5')
  assert.equal(formatChartValue(null, 'en'), '—')
})
