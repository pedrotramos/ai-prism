// A spreadsheet chart spec ({ kind, title, tableBlock, categoryColumn,
// valueColumns }) → the chat's chart block ({ chartType, title, series }), so
// the Spreadsheet Studio preview draws every kind the workbook exports —
// including W2-9's scatter, histogram and heatmap — with the one ChartBlock
// renderer (token palette, AA, colour-blind-safe order, text alternative)
// instead of a second, bar-only copy. Pure: no DOM, unit-tested.
//
// Values are the table's literal cells; a formula cell (computed only in the
// grid) is left out of the series rather than drawn as a fake 0.

const KINDS = new Set(['bar', 'line', 'area', 'pie', 'scatter', 'histogram', 'heatmap'])

const raw = (cell) => (cell && typeof cell === 'object' && !Array.isArray(cell) ? cell.v : cell)
const num = (cell) => {
  const v = raw(cell)
  if (typeof v === 'string' && v.trim().startsWith('=')) return null
  if (v === '' || v == null || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function sheetChartToBlock(sheet, chart) {
  const table = sheet?.blocks?.[chart?.tableBlock]
  if (!table || table.kind !== 'table' || !Array.isArray(table.rows)) return null
  const cols = table.columns || []
  const cat = chart.categoryColumn
  const valueCols = (chart.valueColumns || []).filter((c) => Number.isInteger(c) && c !== cat && c >= 0)
  if (!Number.isInteger(cat) || !valueCols.length) return null
  const chartType = KINDS.has(chart.kind) ? chart.kind : 'bar'
  const header = (c) => cols[c]?.header || `#${c + 1}`
  const rows = table.rows.filter(Array.isArray)
  let series
  if (chartType === 'scatter') {
    series = valueCols.map((c) => ({
      name: header(c),
      data: rows.map((r) => ({ x: num(r[cat]), y: num(r[c]) })).filter((p) => p.x != null && p.y != null),
    }))
  } else {
    const cols2 = chartType === 'pie' || chartType === 'histogram' ? valueCols.slice(0, 1) : valueCols
    series = cols2.map((c) => ({
      name: header(c),
      data: rows.map((r) => ({ label: String(raw(r[cat]) ?? ''), value: num(r[c]) })),
    }))
  }
  if (!series.some((s) => s.data.some((d) => (chartType === 'scatter' ? true : d.value != null)))) return null
  const block = { type: 'chart', chartType, title: chart.title || '', series }
  if (chartType === 'scatter') {
    block.xLabel = header(cat)
    if (valueCols.length === 1) block.yLabel = header(valueCols[0])
  }
  return block
}
