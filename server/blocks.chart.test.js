// Chart blocks for the W2-9 analysis kinds: Mode 1 (ref to a deterministic
// candidate) and Mode 2 (inline series) must both work for pivot, heatmap,
// scatter and histogram; the native spreadsheet charts accept the kinds the
// .xlsx injection can draw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPrismBlocks, buildBlocksInstruction, sanitizeSpreadsheet } from './blocks.js'

const fence = (obj) => '```prism-block\n' + JSON.stringify(obj) + '\n```'
const one = (obj, cands = []) => extractPrismBlocks(`Antes\n${fence(obj)}\nDepois`, cands).blocks

const PIVOT_SERIES = [
  { name: 'Loja', data: [{ label: 'Sul', value: 10 }, { label: 'Norte', value: 4 }] },
  { name: 'Online', data: [{ label: 'Sul', value: 7 }, { label: 'Norte', value: null }] },
]
const CANDIDATES = [
  { id: 'candidate_1', chartType: 'pivot', title: 'Receita por região e canal', rowLabel: 'regiao', colLabel: 'canal', valueLabel: 'receita', series: PIVOT_SERIES },
  { id: 'candidate_2', chartType: 'heatmap', title: 'Mapa de calor', rowLabel: 'regiao', colLabel: 'canal', valueLabel: 'receita', series: PIVOT_SERIES },
  { id: 'candidate_3', chartType: 'scatter', title: 'Pedidos vs Receita', xLabel: 'receita', yLabel: 'pedidos', series: [{ name: 'Sul', data: [{ label: '', x: 1, y: 2 }] }] },
  { id: 'candidate_4', chartType: 'histogram', title: 'Distribuição de receita', series: [{ name: 'receita', data: [{ label: '0–10', value: 3 }] }] },
]

test('Mode 1: a ref to each new kind resolves with its series and axis metadata', () => {
  for (const cand of CANDIDATES) {
    const [b] = one({ type: 'chart', ref: cand.id, caption: 'ok' }, CANDIDATES)
    assert.equal(b.type, 'chart')
    assert.equal(b.chartType, cand.chartType)
    assert.equal(b.title, cand.title)
    assert.deepEqual(b.series, cand.series)
    assert.equal(b.caption, 'ok')
    for (const k of ['xLabel', 'yLabel', 'rowLabel', 'colLabel', 'valueLabel']) assert.equal(b[k], cand[k], `${cand.chartType}.${k}`)
  }
})

test('Mode 2: inline pivot and heatmap keep missing cells as null and align rows', () => {
  for (const chartType of ['pivot', 'heatmap']) {
    const [b] = one({ type: 'chart', chartType, title: 'T', rowLabel: 'Região', colLabel: 'Canal', series: PIVOT_SERIES })
    assert.equal(b.chartType, chartType)
    assert.deepEqual(b.series, PIVOT_SERIES)
    assert.equal(b.rowLabel, 'Região')
    assert.equal(b.colLabel, 'Canal')
  }
})

test('Mode 2: inline scatter takes {x,y} points and axis labels', () => {
  const [b] = one({
    type: 'chart',
    chartType: 'scatter',
    title: 'Preço vs volume',
    xLabel: 'Preço',
    yLabel: 'Volume',
    series: [{ name: 'Produtos', data: [{ label: 'A', x: 10, y: 3 }, { x: 'bad', y: 1 }, { x: 12, y: 5 }] }],
  })
  assert.equal(b.chartType, 'scatter')
  assert.deepEqual(b.series, [{ name: 'Produtos', data: [{ label: 'A', x: 10, y: 3 }, { label: '', x: 12, y: 5 }] }])
  assert.equal(b.xLabel, 'Preço')
  assert.equal(b.yLabel, 'Volume')
})

test('Mode 2: inline histogram from raw values is binned on the server', () => {
  const [b] = one({ type: 'chart', chartType: 'histogram', title: 'Idades', series: [{ name: 'Idade', values: [21, 22, 25, 30, 31, 33, 40, 41, 45, 60] }] })
  assert.equal(b.chartType, 'histogram')
  assert.equal(b.series.length, 1)
  assert.equal(b.series[0].data.reduce((a, d) => a + d.value, 0), 10)
  const [pre] = one({ type: 'chart', chartType: 'histogram', series: [{ name: 'Idade', data: [{ label: '20–30', value: 4 }] }] })
  assert.deepEqual(pre.series, [{ name: 'Idade', data: [{ label: '20–30', value: 4 }] }])
})

test('the original kinds are unchanged and unknown kinds (map) are dropped', () => {
  const [bar] = one({ type: 'chart', chartType: 'bar', series: [{ name: 'R', data: [{ label: 'A', value: '3' }] }] })
  assert.deepEqual(bar.series, [{ name: 'R', data: [{ label: 'A', value: 3 }] }])
  assert.equal(bar.xLabel, undefined)
  const labels = one({ type: 'chart', chartType: 'line', labels: ['a', 'b'], series: [{ name: 'S', values: [1, 2] }] })
  assert.deepEqual(labels[0].series, [{ name: 'S', data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }])
  assert.deepEqual(one({ type: 'chart', chartType: 'map', series: [{ name: 'R', data: [{ label: 'SP', value: 1 }] }] }), [])
  assert.deepEqual(one({ type: 'chart', ref: 'candidate_99' }, CANDIDATES), [])
})

test('the chart policy teaches the four new chartTypes and their shapes', () => {
  const text = buildBlocksInstruction([], null, { deck: false, spreadsheet: false })
  for (const k of ['pivot', 'heatmap', 'scatter', 'histogram']) assert.ok(text.includes(`"${k}"`), k)
  assert.match(text, /\{"x":/)
  assert.ok(!/mapa geográfico|"map"/.test(text) || /sem mapas|não há mapa/i.test(text))
  const withCands = buildBlocksInstruction(CANDIDATES, null, { deck: false, spreadsheet: false })
  assert.match(withCands, /candidate_3 \(scatter\)/)
})

const ssSpec = (kind) => ({
  title: 'Vendas',
  sheets: [
    {
      name: 'Dados',
      blocks: [
        { kind: 'table', columns: [{ header: 'Preço' }, { header: 'Volume' }, { header: 'Margem' }], rows: [[1, 2, 3], [4, 5, 6]] },
      ],
      charts: [{ kind, title: 'G', tableBlock: 0, categoryColumn: 0, valueColumns: [1, 2] }],
    },
  ],
})

test('spreadsheet native charts accept scatter, histogram and heatmap; unknown kinds fall back to bar', () => {
  for (const kind of ['scatter', 'histogram', 'heatmap', 'bar', 'pie']) {
    const out = sanitizeSpreadsheet(ssSpec(kind))
    assert.equal(out.sheets[0].charts[0].kind, kind, kind)
  }
  assert.equal(sanitizeSpreadsheet(ssSpec('map')).sheets[0].charts[0].kind, 'bar')
})
