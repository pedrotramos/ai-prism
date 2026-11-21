// A spreadsheet chart spec ({ kind, title, tableBlock, categoryColumn,
// valueColumns }) → the chat's chart block ({ chartType, title, series }), so
// the Spreadsheet Studio preview draws every kind the workbook exports —
// including W2-9's scatter, histogram and heatmap — with the one ChartBlock
// renderer (token palette, AA, colour-blind-safe order, text alternative)
// instead of a second, bar-only copy. Pure: no DOM, unit-tested.
//
// Values are the table's cells. A formula cell takes its COMPUTED value from the
// preview evaluator (`computedAt`, see chartValueResolver); one the evaluator
// cannot compute stays a gap rather than a fake 0 (Excel still computes it on
// export). Without a resolver a formula cell is left out, as before.
import { colLetter } from '../../lib/sheetEval.ts'
import type { materializeWorkbook } from '../../lib/sheetEval.ts'
import type { SheetBlock } from '../../../../shared/sheetModel.ts'

/** The chart spec the workbook carries (all fields optional: the spec comes from the model). */
interface SheetChartSpec {
  kind?: string
  title?: string
  tableBlock?: number
  categoryColumn?: number
  valueColumns?: number[]
}

type ComputedAt = (blockIndex: number, rowIndex: number, col: number) => unknown

interface ChartBlockSeries {
  name: string
  data: Array<{ x?: number | null; y?: number | null; label?: string; value?: number | null }>
}

interface ChartBlock {
  type: 'chart'
  chartType: string
  title: string
  series: ChartBlockSeries[]
  xLabel?: string
  yLabel?: string
}

const KINDS = new Set(['bar', 'line', 'area', 'pie', 'scatter', 'histogram', 'heatmap'])

const raw = (cell: unknown): unknown => (cell && typeof cell === 'object' && !Array.isArray(cell) ? (cell as { v?: unknown }).v : cell)
const isFormulaValue = (v: unknown): v is string => typeof v === 'string' && v.trim().startsWith('=')
const toNum = (v: unknown): number | null => {
  if (v === '' || v == null || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * (blockIndex, rowIndex, columnIndex) → the preview evaluator's value of that
 * table cell, for sheetChartToBlock's `computedAt`. `wbModel` is the studio's
 * materializeWorkbook (lib/sheetEval.js).
 */
export function chartValueResolver(wbModel: ReturnType<typeof materializeWorkbook> | null | undefined, sheetName: string): ComputedAt {
  return (blockIndex, rowIndex, col) => {
    const geom = wbModel?.sheets?.[sheetName]?.tableGeom?.[blockIndex]
    if (!geom) return null
    return wbModel!.computed(sheetName, `${colLetter(col)}${geom.dataStart + rowIndex}`)
  }
}

export function sheetChartToBlock(sheet: { blocks?: SheetBlock[] } | null | undefined, chart: SheetChartSpec, computedAt?: ComputedAt | null): ChartBlock | null {
  const table = sheet?.blocks?.[chart?.tableBlock as number]
  if (!table || table.kind !== 'table' || !Array.isArray(table.rows)) return null
  const cols = table.columns || []
  const cat = chart.categoryColumn as number
  const valueCols = (chart.valueColumns || []).filter((c) => Number.isInteger(c) && c !== cat && c >= 0)
  if (!Number.isInteger(cat) || !valueCols.length) return null
  const chartType = KINDS.has(chart.kind as string) ? (chart.kind as string) : 'bar'
  const header = (c: number): string => cols[c]?.header || `#${c + 1}`
  const rows = table.rows.filter(Array.isArray) as unknown[][]
  // the cell's value: a formula takes the evaluator's result when a resolver is given
  const valueAt = (r: unknown[], c: number): unknown => {
    const v = raw(r[c])
    if (!isFormulaValue(v)) return v
    return typeof computedAt === 'function' ? computedAt(chart.tableBlock as number, table.rows!.indexOf(r), c) : null
  }
  const num = (r: unknown[], c: number) => toNum(valueAt(r, c))
  let series: ChartBlockSeries[]
  if (chartType === 'scatter') {
    series = valueCols.map((c) => ({
      name: header(c),
      data: rows.map((r) => ({ x: num(r, cat), y: num(r, c) })).filter((p) => p.x != null && p.y != null),
    }))
  } else {
    const cols2 = chartType === 'pie' || chartType === 'histogram' ? valueCols.slice(0, 1) : valueCols
    series = cols2.map((c) => ({
      name: header(c),
      data: rows.map((r) => ({ label: String(valueAt(r, cat) ?? ''), value: num(r, c) })),
    }))
  }
  if (!series.some((s) => s.data.some((d) => (chartType === 'scatter' ? true : d.value != null)))) return null
  const block: ChartBlock = { type: 'chart', chartType, title: chart.title || '', series }
  if (chartType === 'scatter') {
    block.xLabel = header(cat)
    if (valueCols.length === 1) block.yLabel = header(valueCols[0]!)
  }
  return block
}
