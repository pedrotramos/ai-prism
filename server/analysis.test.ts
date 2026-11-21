// analyzeSpreadsheet / chartCandidatesFromRows (W2-9): the four new analysis
// kinds (pivot, heatmap, scatter, histogram) next to the original bar/pie/line
// candidates, with deterministic ids the model can reference. Fixture:
// scripts/fixtures/analysis-sales.golden.csv (4 regions x 3 channels x 6
// months, receita/pedidos/desconto_pct measures).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { analyzeSpreadsheet, chartCandidatesFromRows, describeCandidates } from './analysis.ts'

// `any`: loosely-typed fixtures, the tests assert shapes at runtime.
type Json = any

const CSV_PATH = fileURLToPath(new URL('../scripts/fixtures/analysis-sales.golden.csv', import.meta.url))
const CSV = readFileSync(CSV_PATH)
const ROWS = CSV.toString('utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => {
    const [regiao, canal, mes, receita, pedidos, desconto_pct] = l.split(',')
    return { regiao, canal, mes: Number(mes), receita: Number(receita), pedidos: Number(pedidos), desconto_pct: Number(desconto_pct) }
  })

const byKind = (cands: Json, kind: Json) => cands.filter((c: Json) => c.chartType === kind)

test('emits pivot, heatmap, scatter and histogram candidates after the original ones', () => {
  const { chartCandidates: c } = analyzeSpreadsheet('vendas.csv', CSV)
  for (const kind of ['pivot', 'heatmap', 'scatter', 'histogram']) assert.ok(byKind(c, kind).length >= 1, `${kind} candidate`)
  // the original candidates keep their positions (and so their ids)
  const firstNew = c.findIndex((x) => ['pivot', 'heatmap', 'scatter', 'histogram'].includes(x.chartType))
  assert.equal(firstNew, 15, 'the 15 original candidates come first')
  assert.ok(c.slice(0, 15).every((x) => ['bar', 'pie', 'line'].includes(x.chartType)))
  assert.ok(c.every((x) => !['map', 'geo', 'choropleth'].includes(x.chartType)), 'no geodata kind')
})

test('ids are sequential candidate_N and the result is identical across runs', () => {
  const a = analyzeSpreadsheet('vendas.csv', CSV).chartCandidates
  const b = analyzeSpreadsheet('vendas.csv', CSV).chartCandidates
  assert.deepEqual(a, b)
  a.forEach((c, i) => assert.equal(c.id, `candidate_${i + 1}`))
  assert.equal(new Set(a.map((c) => c.id)).size, a.length)
})

test('pivot: one series per column key, cells are the real sums of the rows', () => {
  const { chartCandidates: c } = analyzeSpreadsheet('vendas.csv', CSV)
  const pivot = byKind(c, 'pivot')[0]
  assert.equal(pivot.rowLabel, 'regiao')
  assert.equal(pivot.colLabel, 'canal')
  assert.equal(pivot.valueLabel, 'receita')
  assert.deepEqual(pivot.series.map((s: Json) => s.name).sort(), ['Loja', 'Online', 'Parceiro'])
  const labels = pivot.series[0].data.map((d: Json) => d.label)
  for (const s of pivot.series) assert.deepEqual(s.data.map((d: Json) => d.label), labels, 'rows aligned across columns')
  const expected = ROWS.filter((r) => r.regiao === 'Sul' && r.canal === 'Online').reduce((a, r) => a + r.receita, 0)
  const cell = pivot.series.find((s: Json) => s.name === 'Online').data.find((d: Json) => d.label === 'Sul').value
  assert.equal(cell, Math.round(expected * 100) / 100)
  const heat = byKind(c, 'heatmap')[0]
  assert.deepEqual(heat.series, pivot.series, 'the heatmap shades the same matrix')
})

test('histogram: every row lands in one bin of the measure', () => {
  const { chartCandidates: c } = analyzeSpreadsheet('vendas.csv', CSV)
  const h = byKind(c, 'histogram')[0]
  assert.equal(h.series.length, 1)
  assert.equal(h.series[0].name, 'receita')
  assert.equal(h.series[0].data.reduce((a: Json, d: Json) => a + d.value, 0), ROWS.length)
  assert.equal(h.series[0].data.length, Math.ceil(Math.log2(ROWS.length)) + 1)
})

test('scatter: x/y points from two measures, grouped by the first dimension', () => {
  const { chartCandidates: c } = analyzeSpreadsheet('vendas.csv', CSV)
  const s = byKind(c, 'scatter')[0]
  assert.equal(s.xLabel, 'receita')
  assert.equal(s.yLabel, 'pedidos')
  assert.deepEqual(s.series.map((x: Json) => x.name).sort(), ['Nordeste', 'Norte', 'Sudeste', 'Sul'])
  const points = s.series.flatMap((x: Json) => x.data)
  assert.equal(points.length, ROWS.length)
  const first = ROWS[0]!
  assert.ok(s.series.find((x: Json) => x.name === first.regiao).data.some((p: Json) => p.x === first.receita && p.y === first.pedidos))
})

test('chartCandidatesFromRows (Genie path) builds the same new kinds with local ids', () => {
  const c = chartCandidatesFromRows('Genie One', ROWS)
  for (const kind of ['pivot', 'heatmap', 'scatter', 'histogram']) assert.ok(byKind(c, kind).length >= 1, kind)
  c.forEach((x, i) => assert.equal(x.id, `c${i + 1}`))
})

test('no new kind from data that cannot support it', () => {
  // one dimension, one measure, 3 rows: no pivot (needs 2 dims), no scatter
  // (needs 2 measures), no histogram (needs >= 10 values)
  const c = chartCandidatesFromRows('x', [
    { regiao: 'Sul', receita: 1 },
    { regiao: 'Norte', receita: 2 },
    { regiao: 'Sul', receita: 3 },
  ])
  assert.deepEqual(c.map((x) => x.chartType), ['bar', 'pie'])
})

test('describeCandidates summarizes the new kinds without dumping every point', () => {
  const { chartCandidates: c } = analyzeSpreadsheet('vendas.csv', CSV)
  const text = describeCandidates(c)
  const scatterLine = text.split('\n').find((l: Json) => l.includes('(scatter)'))
  assert.match(scatterLine, /72 pontos/)
  const pivotLine = text.split('\n').find((l: Json) => l.includes('(pivot)'))
  assert.match(pivotLine, /4 linhas × 3 colunas/)
  assert.ok(text.length < 6000)
})
