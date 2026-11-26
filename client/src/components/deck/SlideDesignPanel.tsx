import { useMemo } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { Switch } from '../SettingsControls.tsx'
import { marginsToPadding, readSlideRoot, sameColor } from './slideDesign.ts'
import type { SlideMargins, Swatch } from './slideDesign.ts'

export interface GridSettings {
  on: boolean
  columns: number
  gutter: number
}

interface SlideDesignPanelProps {
  index: number
  html: string
  swatches: Swatch[]
  /** writes a style patch onto the slide root through the editor's edit op (undo, Save and export carry it) */
  onSlideStyle: (style: Record<string, string | null>) => void
  grid: GridSettings
  onGrid: (next: GridSettings) => void
}

const inputCls = 'min-w-0 w-full text-label rounded-control bg-[var(--surface)] border border-[var(--border)] px-1.5 py-1 focus-visible:border-[var(--accent)]'
const MARGIN_SIDES = ['top', 'right', 'bottom', 'left'] as const

// Shown in the right Design panel while nothing is selected: the slide-level
// controls (background from the active DS, margins, editor-only grid).
export default function SlideDesignPanel({ index, html, swatches, onSlideStyle, grid, onGrid }: SlideDesignPanelProps) {
  const t = useT()
  const root = useMemo(() => readSlideRoot(html), [html])
  const setMargin = (side: keyof SlideMargins, raw: string) => {
    const v = Math.max(0, Math.round(Number(raw) || 0))
    onSlideStyle({ padding: marginsToPadding({ ...root.margins, [side]: v }) })
  }
  const sideLabel = (side: keyof SlideMargins) => t(`deckStudio.htmlEdit.margin${side[0]!.toUpperCase()}${side.slice(1)}`)
  const head = 'text-caption font-semibold uppercase tracking-wide text-[var(--faint)]'

  return (
    <div className="space-y-4 pb-3 mb-3 border-b border-[var(--border)]" data-slide-design>
      <h4 className="text-label font-semibold">{t('deckStudio.htmlEdit.slideTitle', { n: index + 1 })}</h4>

      <section className="space-y-1.5" aria-label={t('deckStudio.htmlEdit.slideBg')}>
        <h5 className={head}>{t('deckStudio.htmlEdit.slideBg')}</h5>
        {swatches.length ? (
          <div className="flex flex-wrap gap-1.5">
            {swatches.map((sw) => {
              const active = sameColor(root.background, sw.value)
              return (
                <button
                  key={sw.value}
                  type="button"
                  aria-label={sw.label}
                  title={`${sw.label} ${sw.value}`}
                  aria-pressed={active}
                  onClick={() => onSlideStyle({ background: sw.value })}
                  className={`h-6 w-6 rounded-full border ${active ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]' : 'border-[var(--border)]'}`}
                >
                  <svg viewBox="0 0 1 1" className="h-full w-full rounded-full" aria-hidden>
                    <rect width="1" height="1" fill={sw.value} />
                  </svg>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="text-caption text-[var(--faint)]">{t('deckStudio.htmlEdit.slideBgNone')}</p>
        )}
        <button type="button" onClick={() => onSlideStyle({ background: null })} className="text-caption text-[var(--faint)] hover:text-[var(--text)]">
          {t('deckStudio.htmlEdit.slideBgReset')}
        </button>
      </section>

      <section className="space-y-1.5" aria-label={t('deckStudio.htmlEdit.slideMargins')}>
        <h5 className={head}>{t('deckStudio.htmlEdit.slideMargins')}</h5>
        <div className="grid grid-cols-4 gap-1">
          {MARGIN_SIDES.map((side) => (
            <label key={side} className="flex flex-col items-center gap-0.5 text-caption text-[var(--faint)]">
              <span className="truncate max-w-full">{sideLabel(side)}</span>
              <input type="number" min={0} value={root.margins[side]} onChange={(e) => setMargin(side, e.target.value)} className={inputCls} />
            </label>
          ))}
        </div>
        <p className="text-caption text-[var(--faint)]">{t('deckStudio.htmlEdit.slideMarginsHint')}</p>
      </section>

      <section className="space-y-1.5" aria-label={t('deckStudio.htmlEdit.grid')}>
        <div className="flex items-center justify-between">
          <h5 className={head}>{t('deckStudio.htmlEdit.grid')}</h5>
          <Switch checked={grid.on} onChange={(on: boolean) => onGrid({ ...grid, on })} label={t('deckStudio.htmlEdit.grid')} />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex flex-col gap-0.5 text-caption text-[var(--faint)]">
            {t('deckStudio.htmlEdit.gridColumns')}
            <input type="number" min={1} max={24} value={grid.columns} onChange={(e) => onGrid({ ...grid, columns: Math.min(24, Math.max(1, Math.round(Number(e.target.value) || 1))) })} className={inputCls} />
          </label>
          <label className="flex flex-col gap-0.5 text-caption text-[var(--faint)]">
            {t('deckStudio.htmlEdit.gridGutter')}
            <input type="number" min={0} value={grid.gutter} onChange={(e) => onGrid({ ...grid, gutter: Math.max(0, Math.round(Number(e.target.value) || 0)) })} className={inputCls} />
          </label>
        </div>
        <p className="text-caption text-[var(--faint)]">{t('deckStudio.htmlEdit.gridHint')}</p>
      </section>
    </div>
  )
}
