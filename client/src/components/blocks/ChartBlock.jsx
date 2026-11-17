import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import * as Icon from '../Icons.jsx'
import { downloadChartAsPng } from '../../chartExport.js'
import { useT, useI18n } from '../../lib/i18n.jsx'
import TableBlock from './TableBlock.jsx'
import { chartToTable, seriesPalette } from './blockData.js'

// Bumps when the theme changes (data-theme / class on <html>), so the palette
// is re-read from the tokens of the new theme.
function useThemeVersion() {
  const [v, setV] = useState(0)
  useEffect(() => {
    const mo = new MutationObserver(() => setV((x) => x + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => mo.disconnect()
  }, [])
  return v
}

// Series colours from the theme / design-system tokens (seriesPalette),
// resolved to concrete values before paint so the PNG export paints the
// same colours. Until resolved, the primary token is the fallback.
function useSeriesColors(ref, chartType, count) {
  const theme = useThemeVersion()
  const [colors, setColors] = useState([])
  useLayoutEffect(() => {
    if (!ref.current) return
    const cs = getComputedStyle(ref.current)
    setColors(seriesPalette({ chartType, count, read: (n) => cs.getPropertyValue(n) }))
  }, [ref, chartType, count, theme])
  return (i) => colors[i] || 'var(--info)'
}

// Tooltip/cursor themed to match the app instead of Recharts' default
// white-on-white box and the oversized light-grey hover bar behind bars.
function ChartTooltip({ active, payload, label, locale }) {
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
            {typeof p.value === 'number' ? p.value.toLocaleString(locale) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

const CURSOR_FILL = { fill: 'var(--border)', opacity: 0.4 }
const CURSOR_LINE = { stroke: 'var(--faint)', strokeDasharray: '4 4' }

function toRows(series) {
  // Recharts wants one row per label with a key per series: [{label, s0, s1, ...}]
  const labels = series[0]?.data.map((d) => d.label) || []
  return labels.map((label, i) => {
    const row = { label }
    series.forEach((s, si) => {
      row[`s${si}`] = s.data[i]?.value ?? null
    })
    return row
  })
}

const TABLE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9 4v16" />
  </svg>
)

export default function ChartBlock({ block }) {
  const t = useT()
  const { locale } = useI18n()
  const { chartType = 'bar', title, series = [], caption } = block
  const rows = toRows(series)
  const containerRef = useRef(null)
  const dataId = useId()
  const [showData, setShowData] = useState(false)
  const count = chartType === 'pie' ? rows.length : series.length
  const color = useSeriesColors(containerRef, chartType, count)
  // the text alternative: kind, title, series and how many categories
  const typeLabel = t(`chart.type.${['bar', 'line', 'area', 'pie'].includes(chartType) ? chartType : 'bar'}`)
  const ariaLabel = t('chart.ariaLabel', {
    type: typeLabel,
    title: title || t('chart.untitled'),
    series: series.map((s, i) => s.name || `${i + 1}`).join(', '),
    count: rows.length,
  })
  const tick = { fontSize: 11, fill: 'var(--faint)' }
  const tooltip = <Tooltip content={<ChartTooltip locale={locale} />} />

  return (
    <div ref={containerRef} data-block="chart" className="rounded-card border border-border bg-surface-2 p-4 my-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        {title && <div className="text-body font-semibold min-w-0">{title}</div>}
        <div className="ml-auto shrink-0 flex items-center gap-1">
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
        </div>
      </div>
      <div role="img" aria-label={ariaLabel} className="w-full h-64">
        <ResponsiveContainer>
          {chartType === 'pie' ? (
            <PieChart accessibilityLayer={false}>
              <Pie data={rows} dataKey="s0" nameKey="label" cx="50%" cy="50%" outerRadius={90} label={({ label }) => label}>
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
      {showData && (
        <div id={dataId} className="mt-3">
          <TableBlock embedded block={chartToTable(block, t('chart.category'))} />
        </div>
      )}
      {caption && <div className="text-label text-muted mt-2">{caption}</div>}
    </div>
  )
}
