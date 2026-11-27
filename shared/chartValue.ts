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
//   donut                                 like pie: [{name, data:[{label, value}]}], one series
//   map                                   choropleth by region: one series, data [{label: region
//                                         name or code, value|null}]; the block's `geo` names the
//                                         geo set (shared/geoTypes.ts) the labels resolve in

export const CHART_KINDS = ['bar', 'line', 'area', 'pie', 'pivot', 'heatmap', 'scatter', 'histogram', 'donut', 'map'] as const
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
  donut: { series: 1, points: 12 },
  map: { series: 1, points: 400 },
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
    // Duplicates follow the pivot rule analysis.js uses (sum of the matching
    // rows): a row label repeated within a column, or a column name repeated
    // across series, is SUMMED into one cell; a cell with only nulls stays
    // null. Nothing is overwritten. The row order is first-seen across the
    // columns, so a model that lists rows in a different order per column
    // still lands each value in its cell.
    const colNames: string[] = []
    const cells = new Map<string, Map<string, number | null>>()
    const rows: string[] = []
    for (const s of list) {
      const name = seriesName(s)
      if (name == null || !Array.isArray(s.data)) continue
      if (!cells.has(name)) {
        if (colNames.length >= lim.series) continue
        colNames.push(name)
        cells.set(name, new Map())
      }
      const col = cells.get(name) as Map<string, number | null>
      for (const d of s.data as unknown[]) {
        if (!isObj(d)) continue
        const label = str(d.label, 60)
        if (!rows.includes(label)) {
          if (rows.length >= lim.points) continue
          rows.push(label)
        }
        const v = toChartNumber(d.value)
        const prev = col.get(label) ?? null
        col.set(label, v == null ? prev : (prev ?? 0) + v)
      }
    }
    if (!colNames.length) return null
    out = colNames.map((name) => {
      const col = cells.get(name) as Map<string, number | null>
      return { name, data: rows.map((label) => ({ label, value: col.get(label) ?? null })) }
    })
  } else if (kind === 'map') {
    // a region without a number is "no data" (null), never a 0 that would paint as the lowest shade
    out = list.slice(0, lim.series).flatMap((s) => {
      const name = seriesName(s)
      if (name == null || !Array.isArray(s.data)) return []
      const data = s.data
        .slice(0, lim.points)
        .filter(isObj)
        .map((d) => ({ label: str(d.label, 60), value: toChartNumber(d.value) }))
        .filter((d) => d.label)
      return data.length ? [{ name, data }] : []
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

export interface Share {
  label: string
  value: number
  /** share of the (positive) total, 0..100, one decimal */
  pct: number
}

/**
 * The slices of a donut/pie: only positive values count (a negative or empty
 * one has no share), each with its percentage of the total. `total` is 0 when
 * nothing is positive.
 */
export function shares(data: ValuePoint[]): { items: Share[]; total: number } {
  const pos = data.filter((d): d is { label: string; value: number } => d.value != null && Number.isFinite(d.value) && d.value > 0)
  const total = pos.reduce((a, d) => a + d.value, 0)
  return { items: pos.map((d) => ({ label: d.label, value: d.value, pct: total ? Math.round((d.value / total) * 1000) / 10 : 0 })), total }
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

// Edges are rounded to 12 significant digits (relative, so neither 1e-12 nor
// 1e308 collapses); a rounding that would leave the finite range (near
// Number.MAX_VALUE) keeps the value as is.
const edge = (n: number) => {
  const r = Number(n.toPrecision(12))
  return Number.isFinite(r) ? r : n
}
const roundTo = (n: number, d: number) => {
  const p = 10 ** d
  const scaled = n * p
  return Number.isFinite(scaled) ? Math.round(scaled) / p : n
}
const MAX_LABEL_DECIMALS = 20

// A label set is usable when every bin's label is distinct and a bin that
// spans a range (x0 < x1) never reads "a–a".
function usableLabels(edges: [number, number][], fmt: (n: number) => string): string[] | null {
  const labels: string[] = []
  for (const [a, b] of edges) {
    const lo = fmt(a)
    const hi = fmt(b)
    if (a < b && lo === hi) return null
    labels.push(`${lo}–${hi}`)
  }
  return new Set(labels).size === labels.length ? labels : null
}

// "x0–x1" labels with the fewest decimals (2 at least, as before) that keep
// the labels usable; then 12..17 significant digits; then the exact shortest
// representation, which is always usable because the edges strictly increase.
function binLabels(edges: [number, number][]): string[] {
  for (let d = 2; d <= MAX_LABEL_DECIMALS; d++) {
    const labels = usableLabels(edges, (n) => String(roundTo(n, d)))
    if (labels) return labels
  }
  for (let p = 12; p <= 17; p++) {
    const labels = usableLabels(edges, (n) => String(Number(n.toPrecision(p))))
    if (labels) return labels
  }
  return edges.map(([a, b]) => `${String(a)}–${String(b)}`)
}

const strictlyIncreasing = (xs: number[]) => xs.every((x, i) => Number.isFinite(x) && (i === 0 || (xs[i - 1] as number) < x))

// The k+1 edges of k equal-width bins over [min, max], computed on the range
// scaled into [-1, 1] (divide by the largest magnitude) so no intermediate
// overflows at ±Number.MAX_VALUE; null when the edges cannot be represented
// as a strictly increasing sequence of finite doubles (a subnormal range, or
// a spread of a few ulps), in which case the caller tries fewer bins.
function binEdges(min: number, max: number, k: number): number[] | null {
  const s = Math.max(Math.abs(min), Math.abs(max))
  const a = min / s
  const b = max / s
  const w = (b - a) / k
  const raw = Array.from({ length: k + 1 }, (_, i) => (i === 0 ? min : i === k ? max : (a + i * w) * s))
  const rounded = raw.map((x, i) => (i === 0 || i === k ? x : edge(x)))
  if (strictlyIncreasing(rounded)) return rounded
  return strictlyIncreasing(raw) ? raw : null
}

/**
 * Deterministic histogram: Sturges' rule (ceil(log2 n) + 1 bins, at most 20)
 * over [min, max], equal widths, half-open bins with the last one closed so
 * the maximum is counted. Every finite input keeps every sample, finite
 * strictly increasing edges and distinct labels: when the range is too narrow
 * for k representable edges (subnormals, a few ulps) the bin count drops,
 * down to one bin [min, max]. Labels are "x0–x1" with edges rounded to 2
 * decimals, or more when needed to keep them distinct (binLabels).
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
  if (min === max) return [{ label: String(edge(min)), value: nums.length, x0: min, x1: max }]
  let k = Math.min(MAX_HISTOGRAM_BINS, Math.ceil(Math.log2(nums.length)) + 1)
  let edges = binEdges(min, max, k)
  while (!edges && k > 1) edges = binEdges(min, max, --k)
  const e = edges ?? [min, max]
  const pairs: [number, number][] = e.slice(0, -1).map((x0, i) => [x0, e[i + 1] as number])
  const labels = binLabels(pairs)
  const bins: Bin[] = pairs.map(([x0, x1], i) => ({ label: labels[i] as string, value: 0, x0, x1 }))
  // count by comparing with the edges themselves (binary search), not by
  // arithmetic on the width: no overflow, no NaN index, and a value always
  // lands in the bin its label shows; the last bin is closed
  for (const v of nums) {
    let lo = 0
    let hi = bins.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((e[mid] as number) <= v) lo = mid
      else hi = mid - 1
    }
    const bin = bins[lo]
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
