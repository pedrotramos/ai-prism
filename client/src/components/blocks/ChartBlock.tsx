import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  Label,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import * as Icon from '../Icons.tsx'
import { downloadChartAsPng } from '../../chartExport.ts'
import { useT, useI18n } from '../../lib/i18n.tsx'
import type { TFn } from '../../lib/tFn.ts'
import TableBlock from './TableBlock.tsx'
import PivotBlock from './PivotBlock.tsx'
import MapChart from './MapChart.tsx'
import { chartToTable, seriesPalette, heatmapPalette, heatCell } from './blockData.ts'
import type { ChartBlockData, ChartSeries } from './blockData.ts'
import { CHART_KINDS, pivotMatrix, formatChartValue, shares } from '../../../../shared/chartValue.js'
import type { Series } from '../../../../shared/chartValue.js'

type TokenReader = (name: string) => string

// The sanitizer guarantees value points for matrix kinds (pivot / heatmap).
const asValueSeries = (series: ChartSeries[]): Series[] => series as Series[]

// Bumps when the theme changes (data-theme / class on <html>), so the palette
// is re-read from the tokens of the new theme.
function useThemeVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const mo = new MutationObserver(() => setV((x) => x + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => mo.disconnect()
  }, [])
  return v
}

// Token reader bound to the chart card, refreshed when the theme changes, so
// series colours (seriesPalette) and heatmap fills (heatmapPalette) are
// resolved to concrete values before paint and the PNG export paints the same
// colours. Until resolved it reads nothing and the fallbacks below apply.
function useTokenReader(ref: RefObject<HTMLElement | null>): TokenReader | null {
  const theme = useThemeVersion()
  const [reader, setReader] = useState<TokenReader | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const cs = getComputedStyle(ref.current)
    setReader(() => (n: string) => cs.getPropertyValue(n))
  }, [ref, theme])
  return reader
}

function useSeriesColors(read: TokenReader | null, chartType: string, count: number): (i: number) => string {
  const colors = useMemo(() => (read ? seriesPalette({ chartType, count, read }) : []), [read, chartType, count])
  return (i: number) => colors[i] || 'var(--info)'
}

// Tooltip/cursor themed to match the app instead of Recharts' default
// white-on-white box and the oversized light-grey hover bar behind bars.
interface TooltipEntry {
  color?: string
  name?: string
  value?: unknown
}

// Recharts clones the element it is given and injects active/payload/label.
function ChartTooltip({ active, payload, label, locale }: { active?: boolean; payload?: TooltipEntry[]; label?: ReactNode; locale?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-control border border-border bg-surface px-3 py-2 shadow-overlay text-label max-w-56">
      {label != null && <div className="font-semibold text-fg mb-1 truncate">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <svg width="8" height="8" className="shrink-0" aria-hidden>
            <circle cx="4" cy="4" r="4" fill={p.color} />
          </svg>
          <span className="text-muted truncate">{p.name}:</span>
          <span className="font-semibold text-fg ml-auto tabular-nums">
            {typeof p.value === 'number' ? p.value.toLocaleString(locale) : (p.value as ReactNode)}
          </span>
        </div>
      ))}
    </div>
  )
}

const CURSOR_FILL = { fill: 'var(--border)', opacity: 0.4 }
const CURSOR_LINE = { stroke: 'var(--faint)', strokeDasharray: '4 4' }

function toRows(series: ChartSeries[]): Record<string, string | number | null | undefined>[] {
  // Recharts wants one row per label with a key per series: [{label, s0, s1, ...}]
  const labels = series[0]?.data.map((d) => d.label) || []
  return labels.map((label, i) => {
    const row: Record<string, string | number | null | undefined> = { label }
    series.forEach((s, si) => {
      row[`s${si}`] = s.data[i]?.value ?? null
    })
    return row
  })
}

// Scatter groups differ by shape as well as colour, so they stay apart for
// colour-blind readers and in greyscale print.
const SCATTER_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross', 'star'] as const

// Recharts spreads the datum's own fields (our `label`) onto the label props
// at runtime, but its PieLabelRenderProps type does not declare them.
const pieLabel = (props: unknown): string | undefined => (props as { label?: string }).label

// A donut slice names its share in the muted text colour (the slice colour is for the slice);
// the thin ones leave it to the legend and tooltip.
const DONUT_CY = 0.46
const donutLabel = (props: unknown) => {
  const p = props as { x?: number; y?: number; textAnchor?: 'start' | 'middle' | 'end'; percent?: number }
  const pct = Math.round((p.percent || 0) * 100)
  return pct >= 4 ? (
    <text x={p.x} y={p.y} textAnchor={p.textAnchor} dominantBaseline="central" fontSize="12" fill="var(--muted)" className="tabular-nums">
      {`${pct}%`}
    </text>
  ) : (
    <g />
  )
}

// The total in the hole of a donut (a Recharts <Label content>): inside the chart's own SVG, so
// the PNG export carries it. The label's viewBox is the plot area; the Pie sits at 50% x DONUT_CY of it.
function DonutCentre({ viewBox, total, caption }: { viewBox?: { x?: number; y?: number; width?: number; height?: number }; total: string; caption: string }) {
  const { x = 0, y = 0, width = 0, height = 0 } = viewBox || {}
  const cx = x + width / 2
  const cy = y + height * DONUT_CY
  return (
    <g className="tabular-nums">
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize="20" fontWeight="600" fill="var(--text)">
        {total}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="11" fill="var(--muted)">
        {caption}
      </text>
    </g>
  )
}

const LEGEND_TEXT = { fontSize: 12 }

const HEAT_ROW_H = 28
const HEAT_LABEL_W = 120
const HEAT_HEAD_H = 24
const HEAT_LEGEND_H = 30
const HEAT_W = 640
// the lowest value still reads as a shade, never as the empty card
const HEAT_FLOOR = 0.15

// Heatmap: an SVG grid (one rect per row x column) shaded along a two-token
// ramp, the value printed in each cell, an empty combination left unpainted
// with a dashed outline, and a low→high legend. data-chart-surface marks it
// for the PNG export.
function Heatmap({ block, read, locale, t }: { block: ChartBlockData; read: TokenReader | null; locale: string; t: TFn }) {
  const m = pivotMatrix(asValueSeries(block.series || []))
  const palette = read ? heatmapPalette({ read }) : null
  const cols = m.colLabels.length || 1
  const cellW = (HEAT_W - HEAT_LABEL_W) / cols
  const height = HEAT_HEAD_H + m.rowLabels.length * HEAT_ROW_H + HEAT_LEGEND_H
  const span = m.max != null && m.min != null && m.max > m.min ? m.max - m.min : 1
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  const gradId = useId().replace(/:/g, '')
  return (
    <svg data-chart-surface viewBox={`0 0 ${HEAT_W} ${height}`} width="100%" role="presentation" className="block">
      {m.colLabels.map((c, ci) => (
        <text key={ci} x={HEAT_LABEL_W + ci * cellW + cellW / 2} y={HEAT_HEAD_H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
          {clip(c, Math.max(4, Math.floor(cellW / 7)))}
        </text>
      ))}
      {m.rowLabels.map((label, r) => {
        const y = HEAT_HEAD_H + r * HEAT_ROW_H
        return (
          <g key={r}>
            <text x={HEAT_LABEL_W - 8} y={y + HEAT_ROW_H / 2 + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {clip(label, 18)}
            </text>
            {m.cells[r]!.map((v, ci) => {
              const x = HEAT_LABEL_W + ci * cellW
              if (v == null) {
                return (
                  <g key={ci}>
                    <rect data-heat-cell data-empty="true" x={x + 1} y={y + 1} width={cellW - 2} height={HEAT_ROW_H - 2} rx="3" fill="none" stroke="var(--border)" strokeDasharray="3 3" />
                    <text x={x + cellW / 2} y={y + HEAT_ROW_H / 2 + 4} textAnchor="middle" fontSize="11" fill="var(--faint)">
                      —
                    </text>
                  </g>
                )
              }
              const cell = palette ? heatCell(palette, HEAT_FLOOR + (1 - HEAT_FLOOR) * ((v - (m.min ?? 0)) / span)) : { fill: 'var(--info)', text: 'var(--text)', chip: null }
              const label = formatChartValue(v, locale)
              const chipW = Math.min(cellW - 6, label.length * 6.5 + 8)
              return (
                <g key={ci}>
                  <rect data-heat-cell data-empty="false" x={x + 1} y={y + 1} width={cellW - 2} height={HEAT_ROW_H - 2} rx="3" fill={cell.fill}>
                    <title>{`${m.rowLabels[r]} × ${m.colLabels[ci]}: ${label}`}</title>
                  </rect>
                  {cellW >= 36 && (
                    <>
                      {cell.chip && <rect x={x + (cellW - chipW) / 2} y={y + 6} width={chipW} height={HEAT_ROW_H - 12} rx="3" fill={cell.chip} />}
                      <text x={x + cellW / 2} y={y + HEAT_ROW_H / 2 + 4} textAnchor="middle" fontSize="11" fill={cell.text} className="tabular-nums">
                        {label}
                      </text>
                    </>
                  )}
                </g>
              )
            })}
          </g>
        )
      })}
      {palette && (
        <g transform={`translate(${HEAT_LABEL_W}, ${height - HEAT_LEGEND_H + 10})`}>
          <defs>
            <linearGradient id={gradId}>
              <stop offset="0" stopColor={heatCell(palette, HEAT_FLOOR).fill} />
              <stop offset="1" stopColor={palette.high} />
            </linearGradient>
          </defs>
          <text x="0" y="9" fontSize="11" fill="var(--muted)">
            {`${t('chart.legendLow')} ${formatChartValue(m.min, locale)}`}
          </text>
          <rect x="110" y="0" width="160" height="10" rx="2" fill={`url(#${gradId})`} />
          <text x="280" y="9" fontSize="11" fill="var(--muted)">
            {`${t('chart.legendHigh')} ${formatChartValue(m.max, locale)}`}
          </text>
        </g>
      )}
    </svg>
  )
}

const TABLE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9 4v16" />
  </svg>
)

export default function ChartBlock({ block, onUseInSlides }: { block: ChartBlockData; onUseInSlides?: ((block: ChartBlockData) => void) | undefined }) {
  const t: TFn = useT()
  const { locale } = useI18n()
  const { chartType = 'bar', title, series = [], caption } = block
  const rows = toRows(series)
  const containerRef = useRef<HTMLDivElement>(null)
  const dataId = useId()
  const [showData, setShowData] = useState(false)
  const read = useTokenReader(containerRef)
  const isMatrix = chartType === 'pivot' || chartType === 'heatmap'
  const count = chartType === 'pie' || chartType === 'donut' ? rows.length : series.length
  const donut = chartType === 'donut' ? shares(asValueSeries(series)[0]?.data ?? []) : null
  const color = useSeriesColors(read, chartType, count)
  // the text alternative: kind, title, series and how many categories/points
  const typeLabel = t(`chart.type.${(CHART_KINDS as readonly string[]).includes(chartType) ? chartType : 'bar'}`)
  const matrix = isMatrix ? pivotMatrix(asValueSeries(series)) : null
  const ariaLabel = isMatrix
    ? t('chart.ariaLabelMatrix', {
        type: typeLabel,
        title: title || t('chart.untitled'),
        rows: matrix!.rowLabels.length,
        cols: matrix!.colLabels.length,
        min: formatChartValue(matrix!.min, locale),
        max: formatChartValue(matrix!.max, locale),
      })
    : chartType === 'scatter'
      ? t('chart.ariaLabelPoints', {
          type: typeLabel,
          title: title || t('chart.untitled'),
          series: series.map((s, i) => s.name || `${i + 1}`).join(', '),
          count: series.reduce((a, s) => a + (s.data?.length || 0), 0),
        })
      : t('chart.ariaLabel', {
          type: typeLabel,
          title: title || t('chart.untitled'),
          series: series.map((s, i) => s.name || `${i + 1}`).join(', '),
          count: rows.length,
        })
  const tick = { fontSize: 11, fill: 'var(--faint)' }
  const tooltip = <Tooltip content={<ChartTooltip locale={locale} />} />

  return (
    <div ref={containerRef} data-block="chart" data-chart-type={chartType} className="rounded-card border border-border bg-surface-2 p-4 my-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        {title && <div className="text-body font-semibold min-w-0">{title}</div>}
        {chartType !== 'pivot' && <div className="ml-auto shrink-0 flex items-center gap-1">
          {onUseInSlides && (
            <button
              type="button"
              onClick={() => onUseInSlides(block)}
              title={t('chart.useInSlides')}
              className="tap-target inline-flex items-center gap-1.5 rounded-control px-2 text-label text-muted hover:bg-surface-3 hover:text-fg transition-colors duration-fast"
            >
              <Icon.Presentation size={14} />
              <span className="max-sm:sr-only">{t('chart.useInSlides')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowData((v) => !v)}
            aria-expanded={showData}
            aria-controls={dataId}
            className="tap-target inline-flex items-center gap-1.5 rounded-control px-2 text-label text-muted hover:bg-surface-3 hover:text-fg transition-colors duration-fast"
          >
            {TABLE_ICON}
            <span>{t('chart.viewData')}</span>
          </button>
          <button
            type="button"
            onClick={() => downloadChartAsPng(containerRef.current, title)}
            aria-label={t('chart.exportPng')}
            title={t('chart.exportPng')}
            className="tap-target inline-flex items-center justify-center rounded-control text-faint hover:bg-surface-3 hover:text-fg transition-colors duration-fast"
          >
            <Icon.Download size={15} />
          </button>
        </div>}
      </div>
      {chartType === 'pivot' ? (
        <PivotBlock block={block} />
      ) : chartType === 'heatmap' ? (
        <div role="img" aria-label={ariaLabel} className="w-full">
          <Heatmap block={block} read={read} locale={locale} t={t} />
        </div>
      ) : chartType === 'map' ? (
        <div role="img" aria-label={ariaLabel} className="w-full">
          <MapChart block={block} read={read} locale={locale} t={t} />
        </div>
      ) : (
      <div role="img" aria-label={ariaLabel} className="w-full h-64">
        <ResponsiveContainer>
          {chartType === 'scatter' ? (
            <ScatterChart accessibilityLayer={false} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" dataKey="x" name={block.xLabel || 'x'} tick={tick} label={block.xLabel ? { value: block.xLabel, position: 'insideBottom', offset: -8, fontSize: 11, fill: 'var(--muted)' } : undefined} />
              <YAxis type="number" dataKey="y" name={block.yLabel || 'y'} tick={tick} label={block.yLabel ? { value: block.yLabel, angle: -90, position: 'insideLeft', fontSize: 11, fill: 'var(--muted)' } : undefined} />
              <Tooltip content={<ChartTooltip locale={locale} />} cursor={CURSOR_LINE} />
              {series.length > 1 && <Legend verticalAlign="top" height={24} iconSize={9} itemSorter={null} wrapperStyle={LEGEND_TEXT} />}
              {series.map((s, i) => (
                <Scatter key={i} name={s.name} data={s.data} fill={color(i)} shape={SCATTER_SHAPES[i % SCATTER_SHAPES.length]} legendType={SCATTER_SHAPES[i % SCATTER_SHAPES.length]} isAnimationActive={false} />
              ))}
            </ScatterChart>
          ) : chartType === 'histogram' ? (
            <BarChart data={rows} accessibilityLayer={false} barCategoryGap={1}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={tick} interval={0} angle={rows.length > 6 ? -30 : 0} textAnchor={rows.length > 6 ? 'end' : 'middle'} height={rows.length > 6 ? 50 : 30} />
              <YAxis tick={tick} allowDecimals={false} />
              <Tooltip content={<ChartTooltip locale={locale} />} cursor={CURSOR_FILL} />
              <Bar dataKey="s0" name={series[0]?.name} fill={color(0)} radius={[2, 2, 0, 0]} />
            </BarChart>
          ) : chartType === 'donut' ? (
            <PieChart accessibilityLayer={false} margin={{ top: 20, right: 16, bottom: 0, left: 16 }}>
              <Pie data={rows} dataKey="s0" nameKey="label" cx="50%" cy={`${DONUT_CY * 100}%`} innerRadius={54} outerRadius={84} paddingAngle={1} label={donutLabel} labelLine={false} isAnimationActive={false}>
                {rows.map((_, i) => (
                  <Cell key={i} fill={color(i)} stroke="var(--surface-2)" />
                ))}
                <Label position="center" content={(p) => <DonutCentre viewBox={(p as { viewBox?: { x?: number; y?: number; width?: number; height?: number } }).viewBox} total={formatChartValue(donut?.total ?? 0, locale)} caption={series[0]?.name || t('chart.total')} />} />
              </Pie>
              {tooltip}
              <Legend verticalAlign="bottom" height={28} iconSize={9} wrapperStyle={LEGEND_TEXT} formatter={(v: string) => <span className="text-muted">{v}</span>} />
            </PieChart>
          ) : chartType === 'pie' ? (
            <PieChart accessibilityLayer={false}>
              <Pie data={rows} dataKey="s0" nameKey="label" cx="50%" cy="50%" outerRadius={90} label={pieLabel}>
                {rows.map((_, i) => (
                  <Cell key={i} fill={color(i)} />
                ))}
              </Pie>
              {tooltip}
            </PieChart>
          ) : chartType === 'line' ? (
            <LineChart data={rows} accessibilityLayer={false}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={tick} />
              <YAxis tick={tick} />
              <Tooltip content={<ChartTooltip locale={locale} />} cursor={CURSOR_LINE} />
              {series.length > 1 && <Legend />}
              {series.map((s, i) => (
                <Line key={i} type="monotone" dataKey={`s${i}`} name={s.name} stroke={color(i)} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          ) : chartType === 'area' ? (
            <AreaChart data={rows} accessibilityLayer={false}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={tick} />
              <YAxis tick={tick} />
              <Tooltip content={<ChartTooltip locale={locale} />} cursor={CURSOR_LINE} />
              {series.length > 1 && <Legend />}
              {series.map((s, i) => (
                <Area key={i} type="monotone" dataKey={`s${i}`} name={s.name} stroke={color(i)} fill={color(i)} fillOpacity={0.25} />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={rows} accessibilityLayer={false}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={tick} interval={0} angle={rows.length > 6 ? -30 : 0} textAnchor={rows.length > 6 ? 'end' : 'middle'} height={rows.length > 6 ? 50 : 30} />
              <YAxis tick={tick} />
              <Tooltip content={<ChartTooltip locale={locale} />} cursor={CURSOR_FILL} />
              {series.length > 1 && <Legend />}
              {series.map((s, i) => (
                <Bar key={i} dataKey={`s${i}`} name={s.name} fill={color(i)} radius={[6, 6, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      )}
      {showData && chartType !== 'pivot' && (
        <div id={dataId} className="mt-3">
          <TableBlock embedded block={chartToTable(block, t('chart.category'))} />
        </div>
      )}
      {caption && <div className="text-label text-muted mt-2">{caption}</div>}
    </div>
  )
}
