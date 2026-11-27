// Deterministic SVG of a chart block, drawn on the server from the block's own
// series (never from numbers the model wrote). It is what leaves the app as an
// image: rasterised by chartRaster.ts into the PNG of a deck slide or a DOCX
// figure. The live chat renders the same blocks with Recharts (ChartBlock.tsx);
// this is the static twin, in the AI Prism light tokens (shared/chartTheme.ts).
//
// Kinds drawn: bar, line, area, pie, donut, histogram, scatter, heatmap, map.
// A pivot is a table, not a figure (chartSvg returns null for it).
import { geoIndex, geoKey } from '../shared/geoTypes.ts'
import type { GeoSet } from '../shared/geoTypes.ts'
import { EXPORT_THEME } from '../shared/chartTheme.ts'
import type { ChartTheme } from '../shared/chartTheme.ts'
import { heatColor, pivotMatrix, readableOn, shares } from '../shared/chartValue.ts'
import type { Series } from '../shared/chartValue.ts'
import { getGeoSet } from './geo.ts'

export interface ChartLike {
  chartType?: string
  title?: string | null
  series?: unknown
  xLabel?: string
  yLabel?: string
  geo?: string
}
export interface SvgOptions {
  width?: number
  height?: number
  locale?: string
  theme?: ChartTheme
  /** override of the geo lookup (tests) */
  geoSet?: GeoSet | null
}

export const FIGURE_SIZE = { width: 800, height: 450 }
const HEAT_FLOOR = 0.15
const SHAPES_PER_SERIES = 6

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
const f1 = (n: number): string => String(Math.round(n * 10) / 10)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

interface Ctx {
  W: number
  H: number
  t: ChartTheme
  locale: string
  full: (n: number | null | undefined) => string
  axis: (n: number) => string
}

function makeCtx(o: SvgOptions): Ctx {
  const locale = o.locale || 'en-US'
  const full = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  return {
    W: o.width || FIGURE_SIZE.width,
    H: o.height || FIGURE_SIZE.height,
    t: o.theme || EXPORT_THEME,
    locale,
    full: (n) => (n == null || !Number.isFinite(n) ? '—' : full.format(n)),
    axis: (n) => compact.format(n),
  }
}

interface TextOpts {
  size?: number
  fill?: string
  anchor?: 'start' | 'middle' | 'end'
  weight?: number
  rotate?: number
  baseline?: 'middle' | 'hanging' | 'auto'
}
function text(c: Ctx, x: number, y: number, s: string, o: TextOpts = {}): string {
  const rot = o.rotate ? ` transform="rotate(${o.rotate} ${f1(x)} ${f1(y)})"` : ''
  return (
    `<text x="${f1(x)}" y="${f1(y)}" font-size="${o.size ?? 12}" fill="${o.fill ?? c.t.muted}" text-anchor="${o.anchor ?? 'start'}"` +
    `${o.weight ? ` font-weight="${o.weight}"` : ''}${o.baseline ? ` dominant-baseline="${o.baseline}"` : ''}${rot}>${esc(s)}</text>`
  )
}

function open(c: Ctx, title: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.W} ${c.H}" width="${c.W}" height="${c.H}" role="img" font-family="${c.t.font}, sans-serif">` +
    `<title>${esc(title)}</title><rect width="${c.W}" height="${c.H}" fill="${c.t.bg}"/>`
  )
}

// title block: returns the markup and the y where the plot may start
function heading(c: Ctx, block: ChartLike): { svg: string; top: number } {
  const title = block.title ? clip(String(block.title), Math.floor((c.W - 40) / 9.5)) : ''
  return title ? { svg: text(c, 20, 30, title, { size: 18, fill: c.t.text, weight: 700 }), top: 48 } : { svg: '', top: 16 }
}

function legend(c: Ctx, names: string[], colors: string[], x: number, y: number): string {
  let out = ''
  let cx = x
  names.forEach((n, i) => {
    const label = clip(n, 22)
    out += `<rect x="${f1(cx)}" y="${f1(y - 9)}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/>` + text(c, cx + 15, y, label, { size: 12 })
    cx += 15 + label.length * 6.6 + 18
  })
  return out
}

function seriesColors(c: Ctx, count: number, kind: string): string[] {
  // two series on a bar/line/area chart are prior vs current: neutral, then primary
  if (count === 2 && (kind === 'bar' || kind === 'line' || kind === 'area')) return [c.t.neutral, c.t.series[0] as string]
  return Array.from({ length: count }, (_, i) => c.t.series[i % c.t.series.length] as string)
}

function niceScale(min: number, max: number, ticks = 5): { lo: number; hi: number; step: number } {
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)
  const span = hi - lo || 1
  const raw = span / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) as number) * mag
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step }
}

const valueSeries = (block: ChartLike): Series[] => (Array.isArray(block.series) ? (block.series as Series[]).filter((s) => Array.isArray(s?.data)) : [])

// ---- bar / line / area / histogram ---------------------------------------------

function cartesian(c: Ctx, block: ChartLike, kind: 'bar' | 'line' | 'area' | 'histogram'): string {
  const series = valueSeries(block)
  const labels = series[0]?.data.map((d) => d.label) ?? []
  if (!series.length || !labels.length) return ''
  const colors = seriesColors(c, series.length, kind)
  const { svg: head, top } = heading(c, block)
  const showLegend = series.length > 1
  const horizontal = kind === 'bar' && labels.length > 6
  const values = series.flatMap((s) => s.data.map((d) => d.value).filter((v): v is number => v != null))
  const sc = niceScale(Math.min(...values, 0), Math.max(...values, 0))
  let out = head
  const legendY = top + 4
  if (showLegend) out += legend(c, series.map((s) => s.name), colors, 20, legendY + 8)
  const plotTop = top + (showLegend ? 26 : 8)

  if (horizontal) {
    const labelW = Math.min(170, Math.max(...labels.map((l) => clip(l, 26).length)) * 6.6 + 14)
    const L = 20 + labelW
    const R = c.W - 40
    const B = c.H - 30
    const bandH = (B - plotTop) / labels.length
    const x = (v: number) => L + ((v - sc.lo) / (sc.hi - sc.lo || 1)) * (R - L)
    for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step) {
      out += `<line x1="${f1(x(v))}" y1="${plotTop}" x2="${f1(x(v))}" y2="${B}" stroke="${c.t.border}"/>` + text(c, x(v), B + 16, c.axis(v), { size: 11, anchor: 'middle', fill: c.t.faint })
    }
    const barH = Math.min(26, (bandH * 0.72) / series.length)
    labels.forEach((label, i) => {
      const y0 = plotTop + i * bandH + (bandH - barH * series.length) / 2
      out += text(c, L - 8, y0 + (barH * series.length) / 2 + 4, clip(label, 26), { size: 12, anchor: 'end' })
      series.forEach((s, si) => {
        const v = s.data[i]?.value
        if (v == null) return
        const x1 = x(Math.min(0, v))
        out += `<rect x="${f1(x1)}" y="${f1(y0 + si * barH)}" width="${f1(Math.max(1, Math.abs(x(v) - x(0))))}" height="${f1(barH - 2)}" rx="3" fill="${colors[si]}"/>`
        if (bandH >= 16) out += text(c, Math.max(x(v), x(0)) + 5, y0 + si * barH + barH / 2 + 3, c.full(v), { size: 11, fill: c.t.text })
      })
    })
    return out + '</svg>'
  }

  const L = 56
  const R = c.W - 20
  const rotate = labels.length > 8
  const B = c.H - (rotate ? 62 : 38)
  const y = (v: number) => B - ((v - sc.lo) / (sc.hi - sc.lo || 1)) * (B - plotTop)
  for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step) {
    out += `<line x1="${L}" y1="${f1(y(v))}" x2="${R}" y2="${f1(y(v))}" stroke="${c.t.border}"/>` + text(c, L - 8, y(v) + 4, c.axis(v), { size: 11, anchor: 'end', fill: c.t.faint })
  }
  const n = labels.length
  const band = (R - L) / n
  const every = Math.max(1, Math.ceil(n / 12))
  const lx = (i: number) => L + band * (i + 0.5)
  labels.forEach((label, i) => {
    if (i % every) return
    out += rotate
      ? text(c, lx(i), B + 14, clip(label, 14), { size: 11, anchor: 'end', rotate: -35, fill: c.t.faint })
      : text(c, lx(i), B + 18, clip(label, Math.max(4, Math.floor(band / 6.5))), { size: 11, anchor: 'middle', fill: c.t.faint })
  })
  if (kind === 'line' || kind === 'area') {
    series.forEach((s, si) => {
      const pts = s.data.map((d, i) => (d.value == null ? null : ([lx(i), y(d.value)] as [number, number])))
      const segs: [number, number][][] = [[]]
      for (const p of pts) p ? segs[segs.length - 1]!.push(p) : segs.push([])
      for (const seg of segs.filter((g) => g.length)) {
        const path = seg.map(([px, py], i) => `${i ? 'L' : 'M'}${f1(px)} ${f1(py)}`).join('')
        if (kind === 'area') out += `<path d="${path}L${f1(seg[seg.length - 1]![0])} ${f1(y(0))}L${f1(seg[0]![0])} ${f1(y(0))}Z" fill="${colors[si]}" fill-opacity="0.22"/>`
        out += `<path d="${path}" fill="none" stroke="${colors[si]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
        if (n <= 24) for (const [px, py] of seg) out += `<circle cx="${f1(px)}" cy="${f1(py)}" r="3.5" fill="${colors[si]}"/>`
      }
    })
  } else {
    const gap = kind === 'histogram' ? 1 : band * 0.2
    const barW = (band - gap) / series.length
    series.forEach((s, si) => {
      s.data.forEach((d, i) => {
        if (d.value == null) return
        const x0 = L + band * i + gap / 2 + si * barW
        const top0 = Math.min(y(d.value), y(0))
        out += `<rect x="${f1(x0)}" y="${f1(top0)}" width="${f1(Math.max(1, barW - (kind === 'histogram' ? 0 : 2)))}" height="${f1(Math.max(1, Math.abs(y(0) - y(d.value))))}" rx="${kind === 'histogram' ? 2 : 4}" fill="${colors[si]}"/>`
        if (kind !== 'histogram' && n <= 10 && series.length === 1) out += text(c, x0 + barW / 2, top0 - 5, c.full(d.value), { size: 11, anchor: 'middle', fill: c.t.text })
      })
    })
  }
  return out + `<line x1="${L}" y1="${f1(y(0))}" x2="${R}" y2="${f1(y(0))}" stroke="${c.t.faint}"/></svg>`
}

// ---- pie / donut -----------------------------------------------------------------

function pie(c: Ctx, block: ChartLike, donut: boolean): string {
  const series = valueSeries(block)
  const { items, total } = shares(series[0]?.data ?? [])
  if (!items.length) return ''
  const { svg: head, top } = heading(c, block)
  const colors = items.map((_, i) => c.t.series[i % c.t.series.length] as string)
  const cx = c.W * 0.34
  const cy = top + (c.H - top - 10) / 2
  const r = Math.min(c.W * 0.28, (c.H - top - 24) / 2)
  const ri = donut ? r * 0.58 : 0
  let out = head
  let a0 = -Math.PI / 2
  const pt = (rad: number, a: number): string => `${f1(cx + rad * Math.cos(a))} ${f1(cy + rad * Math.sin(a))}`
  items.forEach((it, i) => {
    const sweep = (it.value / total) * Math.PI * 2
    const a1 = a0 + Math.min(sweep, Math.PI * 2 - 0.0001)
    const large = sweep > Math.PI ? 1 : 0
    const d = donut
      ? `M${pt(r, a0)}A${f1(r)} ${f1(r)} 0 ${large} 1 ${pt(r, a1)}L${pt(ri, a1)}A${f1(ri)} ${f1(ri)} 0 ${large} 0 ${pt(ri, a0)}Z`
      : `M${f1(cx)} ${f1(cy)}L${pt(r, a0)}A${f1(r)} ${f1(r)} 0 ${large} 1 ${pt(r, a1)}Z`
    out += `<path d="${d}" fill="${colors[i]}" stroke="${c.t.bg}" stroke-width="2"/>`
    a0 += sweep
  })
  if (donut) {
    out += text(c, cx, cy - 2, c.axis(total), { size: 24, anchor: 'middle', fill: c.t.text, weight: 700 })
    out += text(c, cx, cy + 18, clip(series[0]?.name ?? '', 18), { size: 12, anchor: 'middle' })
  }
  // legend: a swatch, the name and the share of each slice
  const lx = c.W * 0.68
  const rowH = Math.min(30, (c.H - top - 20) / items.length)
  const ly = cy - (rowH * items.length) / 2 + rowH / 2
  items.forEach((it, i) => {
    const y = ly + i * rowH
    out += `<rect x="${f1(lx)}" y="${f1(y - 6)}" width="12" height="12" rx="3" fill="${colors[i]}"/>`
    out += text(c, lx + 20, y + 4, clip(it.label, 18), { size: 13, fill: c.t.text })
    out += text(c, c.W - 24, y + 4, `${it.pct}%`, { size: 13, anchor: 'end', weight: 600, fill: c.t.text })
  })
  return out + '</svg>'
}

// ---- scatter ---------------------------------------------------------------------

function scatter(c: Ctx, block: ChartLike): string {
  const series = (Array.isArray(block.series) ? (block.series as Series<{ x: number; y: number }>[]) : []).filter((s) => Array.isArray(s?.data))
  const pts = series.flatMap((s) => s.data)
  if (!pts.length) return ''
  const colors = seriesColors(c, series.length, 'scatter')
  const { svg: head, top } = heading(c, block)
  const showLegend = series.length > 1
  const L = 64
  const R = c.W - 24
  const B = c.H - 44
  const plotTop = top + (showLegend ? 26 : 8)
  const xs = niceScale(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)))
  const ys = niceScale(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)))
  const x = (v: number) => L + ((v - xs.lo) / (xs.hi - xs.lo || 1)) * (R - L)
  const y = (v: number) => B - ((v - ys.lo) / (ys.hi - ys.lo || 1)) * (B - plotTop)
  let out = head + (showLegend ? legend(c, series.map((s) => s.name), colors, 20, top + 12) : '')
  for (let v = ys.lo; v <= ys.hi + ys.step / 2; v += ys.step) out += `<line x1="${L}" y1="${f1(y(v))}" x2="${R}" y2="${f1(y(v))}" stroke="${c.t.border}"/>` + text(c, L - 8, y(v) + 4, c.axis(v), { size: 11, anchor: 'end', fill: c.t.faint })
  for (let v = xs.lo; v <= xs.hi + xs.step / 2; v += xs.step) out += text(c, x(v), B + 16, c.axis(v), { size: 11, anchor: 'middle', fill: c.t.faint })
  if (block.xLabel) out += text(c, (L + R) / 2, c.H - 8, clip(block.xLabel, 40), { size: 12, anchor: 'middle' })
  if (block.yLabel) out += text(c, 14, (plotTop + B) / 2, clip(block.yLabel, 40), { size: 12, anchor: 'middle', rotate: -90 })
  series.forEach((s, si) => {
    for (const p of s.data) {
      const px = f1(x(p.x))
      const py = f1(y(p.y))
      out +=
        si % SHAPES_PER_SERIES === 1
          ? `<rect x="${f1(x(p.x) - 4)}" y="${f1(y(p.y) - 4)}" width="8" height="8" fill="${colors[si]}" fill-opacity="0.8"/>`
          : `<circle cx="${px}" cy="${py}" r="4.5" fill="${colors[si]}" fill-opacity="0.8"/>`
    }
  })
  return out + '</svg>'
}

// ---- heatmap ---------------------------------------------------------------------

function heatmap(c: Ctx, block: ChartLike): string {
  const m = pivotMatrix(valueSeries(block))
  if (!m.rowLabels.length || !m.colLabels.length) return ''
  const { svg: head, top } = heading(c, block)
  const labelW = Math.min(150, Math.max(...m.rowLabels.map((l) => clip(l, 22).length)) * 6.8 + 16)
  const L = 20 + labelW
  const headH = 24
  const legendH = 34
  const cellW = (c.W - L - 20) / m.colLabels.length
  const cellH = Math.min(34, (c.H - top - headH - legendH - 8) / m.rowLabels.length)
  const span = m.max != null && m.min != null && m.max > m.min ? m.max - m.min : 1
  let out = head
  m.colLabels.forEach((col, ci) => (out += text(c, L + ci * cellW + cellW / 2, top + 16, clip(col, Math.max(4, Math.floor(cellW / 6.5))), { size: 11, anchor: 'middle' })))
  m.rowLabels.forEach((label, r) => {
    const y = top + headH + r * cellH
    out += text(c, L - 8, y + cellH / 2 + 4, clip(label, 22), { size: 11, anchor: 'end' })
    m.cells[r]!.forEach((v, ci) => {
      const x = L + ci * cellW
      if (v == null) {
        out += `<rect x="${f1(x + 1)}" y="${f1(y + 1)}" width="${f1(cellW - 2)}" height="${f1(cellH - 2)}" rx="3" fill="none" stroke="${c.t.border}" stroke-dasharray="3 3"/>` + text(c, x + cellW / 2, y + cellH / 2 + 4, '—', { size: 11, anchor: 'middle', fill: c.t.faint })
        return
      }
      const fill = heatColor(c.t.heatLow, c.t.heatHigh, HEAT_FLOOR + (1 - HEAT_FLOOR) * ((v - (m.min ?? 0)) / span))
      out += `<rect x="${f1(x + 1)}" y="${f1(y + 1)}" width="${f1(cellW - 2)}" height="${f1(cellH - 2)}" rx="3" fill="${fill}"/>`
      if (cellW >= 38) out += text(c, x + cellW / 2, y + cellH / 2 + 4, c.full(v), { size: 11, anchor: 'middle', fill: readableOn(fill, [c.t.text, c.t.bg]) })
    })
  })
  return out + rampLegend(c, c.H - 22, m.min, m.max) + '</svg>'
}

// the low → high ramp under a heatmap or a map
function rampLegend(c: Ctx, y: number, min: number | null, max: number | null): string {
  const w = 220
  const x0 = (c.W - w) / 2
  let out = ''
  for (let i = 0; i < 5; i++) out += `<rect x="${f1(x0 + (i * w) / 5)}" y="${y - 10}" width="${f1(w / 5)}" height="10" fill="${heatColor(c.t.heatLow, c.t.heatHigh, HEAT_FLOOR + ((1 - HEAT_FLOOR) * i) / 4)}"/>`
  return out + text(c, x0 - 8, y - 1, c.full(min), { size: 11, anchor: 'end' }) + text(c, x0 + w + 8, y - 1, c.full(max), { size: 11 })
}

// ---- map (choropleth) ------------------------------------------------------------

function choropleth(c: Ctx, block: ChartLike, set: GeoSet | null): string {
  const geo = set ?? getGeoSet(block.geo)
  const data = valueSeries(block)[0]?.data ?? []
  if (!geo || !data.length) return ''
  const idx = geoIndex(geo)
  const byRegion = new Map<string, number>()
  for (const d of data) {
    const id = idx.get(d.label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''))
    if (id && d.value != null) byRegion.set(id, d.value)
  }
  const nums = [...byRegion.values()]
  const min = nums.length ? Math.min(...nums) : null
  const max = nums.length ? Math.max(...nums) : null
  const span = min != null && max != null && max > min ? max - min : 1
  const { svg: head, top } = heading(c, block)
  const legendH = 30
  const availH = c.H - top - legendH - 6
  const scale = Math.min(availH / geo.viewBox[1], (c.W - 40) / geo.viewBox[0])
  const ox = (c.W - geo.viewBox[0] * scale) / 2
  const mapH = geo.viewBox[1] * scale
  // the map sits in the middle of the free height and the ramp right under it
  const oy = top + Math.max(0, (availH - mapH) / 2)
  let out = head + `<g transform="translate(${f1(ox)} ${f1(oy)}) scale(${scale.toFixed(4)})">`
  const sw = (0.8 / scale).toFixed(2)
  for (const r of geo.regions) {
    const v = byRegion.get(r.id)
    const fill = v == null ? c.t.empty : heatColor(c.t.heatLow, c.t.heatHigh, HEAT_FLOOR + (1 - HEAT_FLOOR) * ((v - (min ?? 0)) / span))
    out += `<path d="${r.d}" fill="${fill}" stroke="${c.t.bg}" stroke-width="${sw}"/>`
  }
  out += '</g>'
  return out + rampLegend(c, Math.min(c.H - 8, oy + mapH + 24), min, max) + '</svg>'
}

/**
 * The SVG of a chart block, or null when the block is not a figure (a pivot is
 * a table) or has nothing drawable.
 */
export function chartSvg(block: ChartLike, opts: SvgOptions = {}): string | null {
  const c = makeCtx(opts)
  const body = (() => {
    switch (block.chartType) {
      case 'bar':
      case 'line':
      case 'area':
      case 'histogram':
        return cartesian(c, block, block.chartType)
      case 'pie':
        return pie(c, block, false)
      case 'donut':
        return pie(c, block, true)
      case 'scatter':
        return scatter(c, block)
      case 'heatmap':
        return heatmap(c, block)
      case 'map':
        return choropleth(c, block, opts.geoSet ?? null)
      default:
        return ''
    }
  })()
  if (!body) return null
  return open(c, String(block.title || block.chartType || 'chart')) + body
}
