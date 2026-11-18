// Chart values shared by the server (blocks.js sanitizer, analysis.js
// candidates) and the client (ChartBlock / PivotBlock renderers): the kinds a
// `chart` block may carry, the per-kind shape and limits, the pivot matrix
// behind pivot/heatmap, deterministic histogram binning, and the colour maths
// the heatmap uses to shade between two THEME TOKENS (never a raw colour).
//
// Shapes (all inside block.series):
//   bar | line | area | pie | histogram   [{name, data:[{label, value}]}]
//   pivot | heatmap                       one series per COLUMN, data rows aligned:
//                                         [{name: colKey, data:[{label: rowKey, value|null}]}]
//   scatter                               [{name: group, data:[{label, x, y}]}]
// No geographic kind: maps need geodata, which is out of scope by design.

export const CHART_KINDS = ['bar', 'line', 'area', 'pie', 'pivot', 'heatmap', 'scatter', 'histogram'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export interface ValuePoint {
  label: string
  value: number | null
}
export interface XYPoint {
  label: string
  x: number
  y: number
}
export interface Series<P = ValuePoint> {
  name: string
  data: P[]
}

const LIMITS: Record<ChartKind, { series: number; points: number }> = {
  bar: { series: 6, points: 30 },
  line: { series: 6, points: 30 },
  area: { series: 6, points: 30 },
  pie: { series: 6, points: 30 },
  histogram: { series: 1, points: 40 },
  pivot: { series: 12, points: 20 },
  heatmap: { series: 12, points: 20 },
  scatter: { series: 6, points: 500 },
}
const MAX_HISTOGRAM_BINS = 20
const MAX_HISTOGRAM_VALUES = 5000

export function isChartKind(k: unknown): k is ChartKind {
  return typeof k === 'string' && (CHART_KINDS as readonly string[]).includes(k)
}

/** A finite number from a number or a numeric string; anything else is null. */
export function toChartNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

const str = (v: unknown, max: number) => String(v ?? '').slice(0, max)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

function seriesName(s: Record<string, unknown>): string | null {
  return typeof s.name === 'string' ? s.name.slice(0, 60) : null
}

/**
 * Validates a chart's series for its kind. Returns null when nothing usable
 * is left. The original kinds keep their historical coercion (a non-number
 * becomes 0); pivot/heatmap keep a missing cell as null; scatter drops points
 * without a finite x and y; a histogram accepts pre-binned points or raw
 * `values`, which are binned here (so the model never computes the bins).
 */
export function sanitizeChartSeries(kind: unknown, raw: unknown): Series<ValuePoint | XYPoint>[] | null {
  if (!isChartKind(kind) || !Array.isArray(raw)) return null
  const lim = LIMITS[kind]
  const list = raw.filter(isObj)
  let out: Series<ValuePoint | XYPoint>[]

  if (kind === 'scatter') {
    out = list.slice(0, lim.series).flatMap((s) => {
      const name = seriesName(s)
      if (name == null || !Array.isArray(s.data)) return []
      const data: XYPoint[] = []
      for (const p of s.data) {
        if (data.length >= lim.points) break
        const x = toChartNumber(Array.isArray(p) ? p[0] : isObj(p) ? p.x : null)
        const y = toChartNumber(Array.isArray(p) ? p[1] : isObj(p) ? p.y : null)
        if (x == null || y == null) continue
        data.push({ label: isObj(p) && !Array.isArray(p) ? str(p.label, 60) : '', x, y })
      }
      return data.length ? [{ name, data }] : []
    })
  } else if (kind === 'histogram') {
    out = list.slice(0, lim.series).flatMap((s) => {
      const name = seriesName(s)
      if (name == null) return []
      if (Array.isArray(s.data)) {
        const data = s.data.slice(0, lim.points).map((d) => ({
          label: str(isObj(d) ? d.label : '', 60),
          value: (isObj(d) ? toChartNumber(d.value) : null) ?? 0,
        }))
        return data.length ? [{ name, data }] : []
      }
      if (Array.isArray(s.values)) {
        const nums = s.values.slice(0, MAX_HISTOGRAM_VALUES).map(toChartNumber).filter((n): n is number => n != null)
        const data = histogramBins(nums).map(({ label, value }) => ({ label, value }))
        return data.length ? [{ name, data }] : []
      }
      return []
    })
  } else if (kind === 'pivot' || kind === 'heatmap') {
    const cols = list.slice(0, lim.series).filter((s) => seriesName(s) != null && Array.isArray(s.data))
    if (!cols.length) return null
    // the row order is the first column's; later columns are re-aligned to it
    // by label so a model that lists rows in a different order per column
    // still lands each value in its cell
    const rows: string[] = []
    for (const s of cols)
      for (const d of s.data as unknown[]) {
        const label = str(isObj(d) ? d.label : '', 60)
        if (!rows.includes(label) && rows.length < lim.points) rows.push(label)
      }
    out = cols.map((s) => {
      const byLabel = new Map<string, number | null>()
      for (const d of s.data as unknown[]) if (isObj(d)) byLabel.set(str(d.label, 60), toChartNumber(d.value))
      return { name: seriesName(s) as string, data: rows.map((label) => ({ label, value: byLabel.get(label) ?? null })) }
    })
  } else {
    out = list.slice(0, lim.series).flatMap((s) => {
      const name = seriesName(s)
      if (name == null || !Array.isArray(s.data)) return []
      const data = s.data.slice(0, lim.points).map((d) => ({
        label: str(isObj(d) ? d.label : '', 60),
        value: (isObj(d) ? (typeof d.value === 'number' ? d.value : Number(d.value) || 0) : 0),
      }))
      return [{ name, data }]
    })
  }
  return out.length ? out : null
}

export interface PivotMatrix {
  rowLabels: string[]
  colLabels: string[]
  cells: (number | null)[][]
  rowTotals: number[]
  colTotals: number[]
  total: number
  min: number | null
  max: number | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The row x column matrix behind a pivot/heatmap series (one series per column). */
export function pivotMatrix(series: Series[]): PivotMatrix {
  const colLabels = series.map((s) => s.name)
  const rowLabels = series[0]?.data.map((d) => d.label) ?? []
  const cells = rowLabels.map((label, r) =>
    series.map((s) => {
      const d = s.data[r]?.label === label ? s.data[r] : s.data.find((x) => x.label === label)
      return d?.value ?? null
    })
  )
  const sum = (xs: (number | null)[]) => round2(xs.reduce<number>((a, v) => a + (v ?? 0), 0))
  const rowTotals = cells.map(sum)
  const colTotals = colLabels.map((_, c) => sum(cells.map((row) => row[c] ?? null)))
  const values = cells.flat().filter((v): v is number => v != null)
  return {
    rowLabels,
    colLabels,
    cells,
    rowTotals,
    colTotals,
    total: sum(rowTotals),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  }
}

export interface Bin {
  label: string
  value: number
  x0: number
  x1: number
}

const edge = (n: number) => Math.round(n * 1e6) / 1e6
const fmtEdge = (n: number) => String(Math.round(n * 100) / 100)

/**
 * Deterministic histogram: Sturges' rule (ceil(log2 n) + 1 bins, at most 20)
 * over [min, max], equal widths, half-open bins with the last one closed so
 * the maximum is counted. Labels are "x0–x1" with edges rounded to 2 decimals.
 */
export function histogramBins(values: number[]): Bin[] {
  const nums = values.filter((v) => Number.isFinite(v))
  if (!nums.length) return []
  let min = Infinity
  let max = -Infinity
  for (const v of nums) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (min === max) return [{ label: fmtEdge(min), value: nums.length, x0: min, x1: max }]
  const k = Math.min(MAX_HISTOGRAM_BINS, Math.ceil(Math.log2(nums.length)) + 1)
  const width = (max - min) / k
  const bins: Bin[] = Array.from({ length: k }, (_, i) => {
    const x0 = edge(min + i * width)
    const x1 = i === k - 1 ? max : edge(min + (i + 1) * width)
    return { label: `${fmtEdge(x0)}–${fmtEdge(x1)}`, value: 0, x0, x1 }
  })
  for (const v of nums) {
    const i = Math.min(k - 1, Math.floor((v - min) / width))
    const bin = bins[i]
    if (bin) bin.value++
  }
  return bins
}

// ---- colour maths (inputs are resolved token values, never literals) -------

/** [r, g, b] from #rgb, #rrggbb(aa) or rgb()/rgba(); null for anything else. */
export function parseColor(c: unknown): [number, number, number] | null {
  if (typeof c !== 'string') return null
  const s = c.trim().toLowerCase()
  let m = s.match(/^#([0-9a-f]{3})$/)
  if (m && m[1]) return [...m[1]].map((h) => parseInt(h + h, 16)) as [number, number, number]
  m = s.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/)
  if (m && m[1]) {
    const h = m[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  }
  m = s.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/)
  if (m) return [m[1], m[2], m[3]].map((v) => Math.min(255, Math.round(Number(v)))) as [number, number, number]
  return null
}

const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

function relLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio between two colours (1 when either is unparseable). */
export function contrastRatio(a: string, b: string): number {
  const A = parseColor(a)
  const B = parseColor(b)
  if (!A || !B) return 1
  const la = relLuminance(A)
  const lb = relLuminance(B)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Linear sRGB mix from `low` (t=0) to `high` (t=1), as #rrggbb. */
export function heatColor(low: string, high: string, t: number): string {
  const A = parseColor(low)
  const B = parseColor(high)
  if (!A || !B) return high
  const k = Math.min(1, Math.max(0, t))
  return toHex(A.map((v, i) => v + ((B[i] as number) - v) * k))
}

/** The candidate colour with the highest contrast on `fill`. */
export function readableOn(fill: string, candidates: string[]): string {
  let best = candidates[0] ?? ''
  let bestRatio = -1
  for (const c of candidates) {
    const r = contrastRatio(c, fill)
    if (r > bestRatio) {
      best = c
      bestRatio = r
    }
  }
  return best
}

/** A cell/tooltip value in the user's locale; an em dash for a missing value. */
export function formatChartValue(v: number | null | undefined, locale?: string): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString(locale)
}
