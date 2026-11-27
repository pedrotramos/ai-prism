import { useEffect, useId, useMemo, useState } from 'react'
import { heatCell, heatmapPalette } from './blockData.ts'
import type { ChartBlockData } from './blockData.ts'
import { formatChartValue } from '../../../../shared/chartValue.js'
import { geoIndex, geoKey } from '../../../../shared/geoTypes.ts'
import type { GeoSet } from '../../../../shared/geoTypes.ts'
import type { TFn } from '../../lib/tFn.ts'

type TokenReader = (name: string) => string

// the lowest value still reads as a shade, never as an unpainted region
const HEAT_FLOOR = 0.15
const LEGEND_H = 30

// One request per geo set for the whole page: the chat can hold many maps.
const geoSets = new Map<string, Promise<GeoSet | null>>()
function loadGeoSet(id: string): Promise<GeoSet | null> {
  let p = geoSets.get(id)
  if (!p) {
    p = fetch(`/api/geo/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<GeoSet>) : null))
      .catch(() => null)
    // a failure is not remembered: the next render may succeed
    void p.then((set) => set ?? geoSets.delete(id))
    geoSets.set(id, p)
  }
  return p
}

function useGeoSet(id: string | undefined): GeoSet | null | 'loading' {
  const [state, setState] = useState<GeoSet | null | 'loading'>('loading')
  useEffect(() => {
    let live = true
    setState('loading')
    if (!id) setState(null)
    else void loadGeoSet(id).then((set) => live && setState(set))
    return () => {
      live = false
    }
  }, [id])
  return state
}

// Choropleth: the regions of the geo set are SVG paths in one viewBox (the same
// shapes the server draws into slides and documents), shaded along the heatmap
// ramp by value; a region with no value stays on the empty surface. Marked
// data-chart-surface so the card's PNG export finds it.
export default function MapChart({ block, read, locale, t }: { block: ChartBlockData; read: TokenReader | null; locale: string; t: TFn }) {
  const geo = useGeoSet(block.geo)
  const gradId = useId().replace(/:/g, '')
  const palette = read ? heatmapPalette({ read }) : null
  const data = block.series?.[0]?.data
  const { byRegion, min, max } = useMemo(() => {
    const byRegion = new Map<string, number>()
    if (geo && geo !== 'loading') {
      const idx = geoIndex(geo)
      for (const d of data || []) {
        const id = idx.get(geoKey(d.label))
        if (id && d.value != null) byRegion.set(id, d.value)
      }
    }
    const nums = [...byRegion.values()]
    return { byRegion, min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null }
  }, [geo, data])

  if (geo === 'loading') return <div className="h-64 flex items-center justify-center text-label text-muted">{t('chart.mapLoading')}</div>
  if (!geo) return <div className="h-64 flex items-center justify-center text-label text-muted">{t('chart.mapUnavailable')}</div>

  const [w, h] = geo.viewBox
  const span = min != null && max != null && max > min ? max - min : 1
  const tone = (v: number) => (palette ? heatCell(palette, HEAT_FLOOR + (1 - HEAT_FLOOR) * ((v - (min ?? 0)) / span)).fill : 'var(--info)')
  const legendW = Math.min(240, w * 0.6)
  return (
    <svg data-chart-surface viewBox={`0 0 ${w} ${h + LEGEND_H}`} width="100%" role="presentation" className="block max-h-96">
      {geo.regions.map((r) => {
        const v = byRegion.get(r.id)
        return (
          <path key={r.id} data-region={r.id} d={r.d} fill={v == null ? 'var(--surface-3)' : tone(v)} stroke="var(--surface-2)" strokeWidth={Math.max(0.5, w / 1200)} className="hover:opacity-80">
            <title>{v == null ? `${r.name}: ${t('chart.mapNoValue')}` : `${r.name}: ${formatChartValue(v, locale)}`}</title>
          </path>
        )
      })}
      {palette && max != null && (
        <g transform={`translate(${(w - legendW) / 2}, ${h + 12})`} fontSize={Math.max(10, w / 70)}>
          <defs>
            <linearGradient id={gradId}>
              <stop offset="0" stopColor={heatCell(palette, HEAT_FLOOR).fill} />
              <stop offset="1" stopColor={palette.high} />
            </linearGradient>
          </defs>
          <text x="-8" y="9" textAnchor="end" fill="var(--muted)">{`${t('chart.legendLow')} ${formatChartValue(min, locale)}`}</text>
          <rect x="0" y="0" width={legendW} height="10" rx="2" fill={`url(#${gradId})`} />
          <text x={legendW + 8} y="9" fill="var(--muted)">{`${t('chart.legendHigh')} ${formatChartValue(max, locale)}`}</text>
        </g>
      )}
    </svg>
  )
}
