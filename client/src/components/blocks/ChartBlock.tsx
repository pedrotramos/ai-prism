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
import BlockFrame from './BlockFrame.tsx'
import BlockSwitch, { tabId } from './BlockSwitch.tsx'
import { chartToTable, chartViews, seriesPalette, heatmapPalette, heatCell } from './blockData.ts'
import type { ChartBlockData, ChartSeries, ChartView } from './blockData.ts'
import { CHART_KINDS, pivotMatrix, formatChartValue } from '../../../../shared/chartValue.js'
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

export default function ChartBlock({ block }: { block: ChartBlockData }) {
  const t: TFn = useT()
  const { locale } = useI18n()
  const { chartType = 'bar', title, series = [], caption } = block
  const rows = toRows(series)
  const containerRef = useRef<HTMLDivElement>(null)
  const uid = useId()
  const panelId = `${uid}-panel`
  const read = useTokenReader(containerRef)
  // The switch only offers views the block's own data fits (chartViews); the
  // block itself is never changed, so switching away and back loses nothing.
  // An unknown kind renders as a bar, as it always has.
  const own: ChartView = (CHART_KINDS as readonly string[]).includes(chartType) ? (chartType as ChartView) : 'bar'
  const views = chartViews(block)
  const [picked, setPicked] = useState<ChartView | null>(null)
  const view: ChartView = picked && views.includes(picked) ? picked : own
  const isMatrix = view === 'pivot' || view === 'heatmap'
  const kind = view === 'table' ? own : view
  const count = kind === 'pie' ? rows.length : series.length
  const color = useSeriesColors(read, kind, count)
  // the text alternative: kind, title, series and how many categories/points
  const typeLabel = t(`chart.type.${(CHART_KINDS as readonly string[]).includes(kind) ? kind : 'bar'}`)
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
    : kind === 'scatter'
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
  // a PNG export needs a drawn surface: not the table view, not the pivot
  const canExport = view !== 'table' && view !== 'pivot'

  const options = views.map((v) => ({
    id: v,
    label: t(`chart.view.${v}`),
    icon: v === 'table' || v === 'pivot' ? TABLE_ICON : undefined,
  }))

  return (
    <BlockFrame
      block="chart"
      attrs={{ 'data-chart-type': own }}
      frameRef={containerRef}
      title={title}
      subtitle={caption}
      actions={
        <div className="ml-auto max-w-full">
          <BlockSwitch label={t('chart.switchLabel')} options={options} value={view} onChange={(v) => setPicked(v as ChartView)} panelId={panelId} idPrefix={uid} />
        </div>
      }
      footer={
        canExport && (
          <button
            type="button"
            onClick={() => downloadChartAsPng(containerRef.current, title)}
            className="tap-target ml-auto inline-flex items-center gap-1.5 rounded-control px-2 text-label text-muted hover:bg-surface-3 hover:text-fg transition-colors duration-fast"
          >
            <Icon.Download size={14} />
            <span>{t('chart.exportPng')}</span>
          </button>
        )
      }
    >
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(uid, view)} className="px-2 pt-1 pb-2">
        {view === 'table' ? (
          <div className="px-2 pb-1">
            <TableBlock embedded block={chartToTable({ ...block, chartType: own }, t('chart.category'))} />
          </div>
        ) : view === 'pivot' ? (
          <div className="px-2 pb-1">
            <PivotBlock block={block} />
          </div>
        ) : view === 'heatmap' ? (
          <div role="img" aria-label={ariaLabel} className="w-full">
            <Heatmap block={block} read={read} locale={locale} t={t} />
          </div>
        ) : (
          <div role="img" aria-label={ariaLabel} className="w-full h-64">
            <ResponsiveContainer>
              {kind === 'scatter' ? (
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
              ) : kind === 'histogram' ? (
                <BarChart data={rows} accessibilityLayer={false} barCategoryGap={1}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={tick} interval={0} angle={rows.length > 6 ? -30 : 0} textAnchor={rows.length > 6 ? 'end' : 'middle'} height={rows.length > 6 ? 50 : 30} />
                  <YAxis tick={tick} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip locale={locale} />} cursor={CURSOR_FILL} />
                  <Bar dataKey="s0" name={series[0]?.name} fill={color(0)} radius={[2, 2, 0, 0]} />
                </BarChart>
              ) : kind === 'pie' ? (
                <PieChart accessibilityLayer={false}>
                  <Pie data={rows} dataKey="s0" nameKey="label" cx="50%" cy="50%" outerRadius={90} label={pieLabel}>
                    {rows.map((_, i) => (
                      <Cell key={i} fill={color(i)} />
                    ))}
                  </Pie>
                  {tooltip}
                </PieChart>
              ) : kind === 'line' ? (
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
              ) : kind === 'area' ? (
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
      </div>
    </BlockFrame>
  )
}
