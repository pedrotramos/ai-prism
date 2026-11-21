import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sheetChartToBlock } from './sheetChart.ts'

const sheet = {
  blocks: [
    { kind: 'title', text: 'x' },
    {
      kind: 'table',
      columns: [{ header: 'Ticket' }, { header: 'Margem' }, { header: 'Custo' }],
      rows: [[10, 2, 4], [20, { v: 5, role: 'input' }, '=B3*2'], [30, 7, 9]],
    },
  ],
}

test('bar: one series per value column, labelled by the category column', () => {
  const b = sheetChartToBlock(sheet, { kind: 'bar', title: 'T', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] })
  assert.equal(b!.chartType, 'bar')
  assert.deepEqual(b!.series.map((s) => s.name), ['Margem', 'Custo'])
  assert.deepEqual(b!.series[0]!.data, [{ label: '10', value: 2 }, { label: '20', value: 5 }, { label: '30', value: 7 }])
  // a formula cell is not drawn as a fake 0
  assert.equal(b!.series[1]!.data[1]!.value, null)
})

test('scatter: x from the category column, y from each value column, axis labels', () => {
  const b = sheetChartToBlock(sheet, { kind: 'scatter', tableBlock: 1, categoryColumn: 0, valueColumns: [1] })
  assert.equal(b!.chartType, 'scatter')
  assert.deepEqual(b!.series[0]!.data, [{ x: 10, y: 2 }, { x: 20, y: 5 }, { x: 30, y: 7 }])
  assert.equal(b!.xLabel, 'Ticket')
  assert.equal(b!.yLabel, 'Margem')
})

test('histogram and pie use the first value column; heatmap keeps the matrix', () => {
  assert.equal(sheetChartToBlock(sheet, { kind: 'histogram', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] })!.series.length, 1)
  assert.equal(sheetChartToBlock(sheet, { kind: 'pie', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] })!.series.length, 1)
  const h = sheetChartToBlock(sheet, { kind: 'heatmap', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] })
  assert.equal(h!.chartType, 'heatmap')
  assert.equal(h!.series.length, 2)
})

test('ungroundable charts render nothing; unknown kinds fall back to bars', () => {
  assert.equal(sheetChartToBlock(sheet, { kind: 'bar', tableBlock: 0, categoryColumn: 0, valueColumns: [1] }), null)
  assert.equal(sheetChartToBlock(sheet, { kind: 'bar', tableBlock: 1, categoryColumn: 0, valueColumns: [0] }), null)
  assert.equal(sheetChartToBlock(sheet, { kind: 'radar', tableBlock: 1, categoryColumn: 0, valueColumns: [1] })!.chartType, 'bar')
})

// ---- N7 item 8: formula cells are drawn with their computed values

import { materializeWorkbook } from '../../lib/sheetEval.ts'
import { chartValueResolver } from './sheetChart.ts'

const FSHEET = {
  name: 'Dados',
  blocks: [
    { kind: 'title', text: 'x' },
    {
      kind: 'table',
      columns: [{ header: 'Mês' }, { header: 'Receita' }, { header: 'Dobro' }],
      rows: [['jan', 10, '=[@Receita]*2'], ['fev', 20, '=[@Receita]*2'], ['mar', 30, '=[@Receita]*2']],
    },
  ],
}

test('N7-8: a formula column is charted with its computed values, not left out', () => {
  const wb = materializeWorkbook({ sheets: [FSHEET] })
  const computedAt = chartValueResolver(wb, 'Dados')
  const b = sheetChartToBlock(FSHEET, { kind: 'bar', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] }, computedAt)
  assert.deepEqual(b!.series[1]!.data, [{ label: 'jan', value: 20 }, { label: 'fev', value: 40 }, { label: 'mar', value: 60 }])
  assert.deepEqual(b!.series[0]!.data.map((d) => d.value), [10, 20, 30])
})

test('N7-8: a chart made only of formula columns now renders (it used to be dropped as empty)', () => {
  const wb = materializeWorkbook({ sheets: [FSHEET] })
  const b = sheetChartToBlock(FSHEET, { kind: 'line', tableBlock: 1, categoryColumn: 0, valueColumns: [2] }, chartValueResolver(wb, 'Dados'))
  assert.ok(b)
  assert.equal(b!.series[0]!.data.length, 3)
  assert.equal(sheetChartToBlock(FSHEET, { kind: 'line', tableBlock: 1, categoryColumn: 0, valueColumns: [2] }), null, 'without a resolver the old behaviour holds')
})

test('N7-8: an expression the preview cannot evaluate stays a gap, never a fake 0', () => {
  const sheet = { name: 'S', blocks: [{ kind: 'table', columns: [{ header: 'A' }, { header: 'B' }], rows: [['x', 1], ['y', '=XPTO(1)']] }] }
  const wb = materializeWorkbook({ sheets: [sheet] })
  const b = sheetChartToBlock(sheet, { kind: 'bar', tableBlock: 0, categoryColumn: 0, valueColumns: [1] }, chartValueResolver(wb, 'S'))
  assert.equal(b!.series[0]!.data[0]!.value, 1)
  assert.equal(b!.series[0]!.data[1]!.value, null)
})

test('N7-8: scatter takes formula x and y too', () => {
  const wb = materializeWorkbook({ sheets: [FSHEET] })
  const b = sheetChartToBlock(FSHEET, { kind: 'scatter', tableBlock: 1, categoryColumn: 1, valueColumns: [2] }, chartValueResolver(wb, 'Dados'))
  assert.deepEqual(b!.series[0]!.data, [{ x: 10, y: 20 }, { x: 20, y: 40 }, { x: 30, y: 60 }])
})
