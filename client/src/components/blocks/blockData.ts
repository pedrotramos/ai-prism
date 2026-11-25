// Pure data rules behind the inline artifact blocks. Kept free of React so
// node --test can pin them (blockData.test.js).
import { CHART_KINDS, contrastRatio, heatColor, readableOn } from '../../../../shared/chartValue.js'
import type { ChartKind } from '../../../../shared/chartValue.js'

// One point of any chart kind: value charts read label/value, scatter x/y.
export interface ChartPoint {
  label: string
  value?: number | null
  x?: number
  y?: number
}

export interface ChartSeries {
  name?: string
  data: ChartPoint[]
}

// A chart block as it arrives from the server, read loosely: older rows can
// miss any field.
export interface ChartBlockData {
  type?: string
  chartType?: ChartKind | string
  title?: string
  caption?: string | null
  series?: ChartSeries[]
  xLabel?: string
  yLabel?: string
  rowLabel?: string
  colLabel?: string
  valueLabel?: string
}

export interface TableBlockData {
  type?: 'table'
  title?: string | null
  columns?: string[]
  rows?: (string | null)[][]
}

type Read = (name: string) => string | null | undefined

const TEASER_MAX = 140

function cleanInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(\*|_)(.+?)\1/g, '$2') // italics
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') // list marker
    .replace(/^\s*>\s?/, '') // blockquote
}

/**
 * A one-line teaser for a document card: the first prose paragraph, with
 * headings, tables, fenced code and rules skipped and inline marks removed,
 * so the card never shows raw markdown syntax ("| Region | Q2 |…").
 */
export function documentTeaser(markdown: unknown, max = TEASER_MAX): string {
  const lines = String(markdown || '').split('\n')
  const para: string[] = []
  let inFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      if (para.length) break
      continue
    }
    if (inFence) continue
    const skip =
      !line ||
      /^#{1,6}\s/.test(line) ||
      /^\|/.test(line) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(line) ||
      /^:?-{2,}:?(\s*\|\s*:?-{2,}:?)*\|?$/.test(line)
    if (skip) {
      if (para.length) break
      continue
    }
    para.push(cleanInline(line))
  }
  const text = para.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

/** A view of a chart block: one of its kinds, or the rows as a table. */
export type ChartView = ChartKind | 'table'

// A pie keeps one series, so it only reads right for one series of
// non-negative shares, at least two and few enough to tell apart.
const PIE_MAX_SLICES = 8

/**
 * The views the chart type switch offers (Q15-A): only kinds the block's own
 * data already fits, in a fixed order, plus "table". Nothing is re-queried and
 * no kind outside the sanitized set is ever offered. The block's own kind is
 * always among them, so what the model drew can always be shown again. A
 * pivot or heatmap is one matrix, so the pivot is its table and no extra
 * "table" view is added.
 */
export function chartViews(block: ChartBlockData | null | undefined): ChartView[] {
  const kind = String(block?.chartType || 'bar')
  const series = block?.series || []
  const first = series[0]?.data || []
  const own: string = (CHART_KINDS as readonly string[]).includes(kind) ? kind : 'bar'

  if (own === 'pivot' || own === 'heatmap') return ['heatmap', 'pivot']
  if (own === 'scatter') return ['scatter', 'table']

  const fits = new Set<string>([own])
  if (own === 'histogram') {
    fits.add('bar')
  } else {
    const values = first.map((p) => p.value)
    fits.add('bar')
    if (first.length >= 2) {
      fits.add('line')
      fits.add('area')
    }
    const slices = first.length
    const shares = values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    if (series.length === 1 && shares && slices >= 2 && slices <= PIE_MAX_SLICES && values.some((v) => (v as number) > 0)) fits.add('pie')
  }
  const order: ChartKind[] = ['bar', 'line', 'area', 'pie', 'histogram']
  return [...order.filter((k) => fits.has(k)), 'table']
}

/** The rows behind a chart as a `table` block, for the "View data" toggle. */
export function chartToTable(block: ChartBlockData | null | undefined, labelHeader: string): TableBlockData {
  const series = block?.series || []
  if (block?.chartType === 'scatter') {
    return {
      type: 'table',
      title: null,
      columns: [labelHeader, block.xLabel || 'x', block.yLabel || 'y'],
      rows: series.flatMap((s) => (s.data || []).map((p) => [String(p.label || s.name || ''), String(p.x), String(p.y)])),
    }
  }
  const labels = series[0]?.data?.map((d) => d.label) || []
  return {
    type: 'table',
    title: null,
    columns: [labelHeader, ...series.map((s, i) => s.name || `Series ${i + 1}`)],
    rows: labels.map((label, i) => [
      String(label),
      ...series.map((s) => {
        const v = s.data?.[i]?.value
        return v == null ? null : String(v)
      }),
    ]),
  }
}

// Categorical order: a design system may define --chart-1…--chart-6; the app
// falls back to its semantic tokens, which already meet 3:1 on every surface.
const CATEGORICAL: string[][] = [
  ['--chart-1', '--info'],
  ['--chart-2', '--success'],
  ['--chart-3', '--warning'],
  ['--chart-4', '--accent'],
  ['--chart-5', '--muted'],
]
const NEUTRAL: string[] = ['--chart-neutral', '--faint']
// kinds whose two series read as "prior vs current"; scatter groups, pivot
// columns and pie slices are categories, not a comparison
const COMPARISON_KINDS = new Set<string | undefined>(['bar', 'line', 'area'])

/**
 * Series colours for a chart, resolved to concrete values through `read`
 * (getComputedStyle(...).getPropertyValue), so the PNG export, which cannot
 * see CSS variables, paints the same colours. Two series on a bar/line/area
 * chart are a comparison: the first (prior period) is neutral, the second
 * (current) primary; the brand red never marks a prior period as "bad".
 */
export function seriesPalette({ chartType, count, read }: { chartType?: string; count: number; read: Read }): string[] {
  const pick = (names: string[]): string => {
    for (const n of names) {
      const v = (read(n) || '').trim()
      if (v) return v
    }
    return 'currentColor'
  }
  if (COMPARISON_KINDS.has(chartType) && count === 2) return [pick(NEUTRAL), pick(CATEGORICAL[0]!)]
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(pick(CATEGORICAL[i % CATEGORICAL.length]!))
  return out
}

// Heatmap ramp: from a quiet surface token to the primary chart token, mixed
// in JS from the resolved values so the PNG export paints the same fills. The
// label on each cell is whichever text token reads better; in the mid-ramp
// band where neither reaches AA (4.5:1) the label sits on an opaque --surface
// chip instead (both pinned by the tests for both app themes).
const HEAT_HIGH: string[] = ['--chart-1', '--info']
const HEAT_LOW: string[] = ['--chart-heat-low', '--surface-3']
const HEAT_TEXT: string[][] = [['--text'], ['--bg']]
const HEAT_CHIP: string[] = ['--surface']
const AA = 4.5

export interface HeatPalette {
  low: string
  high: string
  text: string[]
  chip: string
}

export function heatmapPalette({ read }: { read: Read }): HeatPalette {
  const pick = (names: string[]): string => {
    for (const n of names) {
      const v = (read(n) || '').trim()
      if (v) return v
    }
    return ''
  }
  return { low: pick(HEAT_LOW), high: pick(HEAT_HIGH), text: HEAT_TEXT.map(pick).filter(Boolean), chip: pick(HEAT_CHIP) }
}

/**
 * Fill and label colours of a heatmap cell at position t in [0, 1]. `chip` is
 * set when the label needs a surface chip behind it to stay AA.
 */
export function heatCell(palette: HeatPalette, t: number): { fill: string; text: string; chip: string | null } {
  const fill = heatColor(palette.low, palette.high, t)
  const text = readableOn(fill, palette.text)
  if (contrastRatio(text, fill) >= AA || !palette.chip) return { fill, text, chip: null }
  return { fill, text: readableOn(palette.chip, palette.text), chip: palette.chip }
}
