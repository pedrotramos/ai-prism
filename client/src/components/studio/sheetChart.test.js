import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sheetChartToBlock } from './sheetChart.js'

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
  assert.equal(b.chartType, 'bar')
  assert.deepEqual(b.series.map((s) => s.name), ['Margem', 'Custo'])
  assert.deepEqual(b.series[0].data, [{ label: '10', value: 2 }, { label: '20', value: 5 }, { label: '30', value: 7 }])
  // a formula cell is not drawn as a fake 0
  assert.equal(b.series[1].data[1].value, null)
})

test('scatter: x from the category column, y from each value column, axis labels', () => {
  const b = sheetChartToBlock(sheet, { kind: 'scatter', tableBlock: 1, categoryColumn: 0, valueColumns: [1] })
  assert.equal(b.chartType, 'scatter')
  assert.deepEqual(b.series[0].data, [{ x: 10, y: 2 }, { x: 20, y: 5 }, { x: 30, y: 7 }])
  assert.equal(b.xLabel, 'Ticket')
  assert.equal(b.yLabel, 'Margem')
})

test('histogram and pie use the first value column; heatmap keeps the matrix', () => {
  assert.equal(sheetChartToBlock(sheet, { kind: 'histogram', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] }).series.length, 1)
  assert.equal(sheetChartToBlock(sheet, { kind: 'pie', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] }).series.length, 1)
  const h = sheetChartToBlock(sheet, { kind: 'heatmap', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] })
  assert.equal(h.chartType, 'heatmap')
  assert.equal(h.series.length, 2)
})

test('ungroundable charts render nothing; unknown kinds fall back to bars', () => {
  assert.equal(sheetChartToBlock(sheet, { kind: 'bar', tableBlock: 0, categoryColumn: 0, valueColumns: [1] }), null)
  assert.equal(sheetChartToBlock(sheet, { kind: 'bar', tableBlock: 1, categoryColumn: 0, valueColumns: [0] }), null)
  assert.equal(sheetChartToBlock(sheet, { kind: 'radar', tableBlock: 1, categoryColumn: 0, valueColumns: [1] }).chartType, 'bar')
})
