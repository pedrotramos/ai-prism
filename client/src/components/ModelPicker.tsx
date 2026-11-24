import { useState, useRef, useEffect, useId, useMemo } from 'react'
import * as Icon from './Icons.tsx'
import Skeleton from './Skeleton.tsx'
import { ProviderMark } from './ProviderMark.tsx'
import { costTier } from './composer/modelCost.ts'
import { useT } from '../lib/i18n.tsx'
import { modelBlurb } from '../lib/modelBlurb.ts'
import { EFFORT_CHOICES, effortLevelsOf, useReasoningEffort, setReasoningEffort } from '../lib/reasoningEffort.ts'

import { splitCatalog, filterModels, groupByProvider, visionBadgeMode, showsVisionBadge } from '../app/modelGroups.ts'

// The composer's model picker (W1-3; it lived in the header before). Three recommended models are pinned (Hick: most
// people pick from a short list); the rest sit under "More models", grouped by
// provider, with a search box. The image badge appears only on the minority, so
// it tells the user something. Popover: Escape and an outside click close it,
// focus returns to the trigger, arrow keys move between models.
// An entry of GET /api/models, as far as the picker reads it.
interface PickerModel {
  id: string
  label: string
  provider: string
  blurb?: string | null
  in?: number | null
  out?: number | null
  vision?: boolean
  reasoning?: { levels?: string[]; [k: string]: unknown } | boolean | null
}

interface ModelPickerProps {
  models: PickerModel[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  /** Which way the popover opens: 'up' from the composer, 'down' elsewhere (default). */
  placement?: 'up' | 'down'
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

// 1-3 bars: the model's relative cost per answer (decorative; the label is the title)
function CostBars({ tier, label }: { tier: 1 | 2 | 3; label: string }) {
  return (
    <span className="shrink-0 inline-flex items-end gap-0.5 h-3" title={label} role="img" aria-label={label}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`w-1 rounded-sm ${i <= tier ? 'bg-fg' : 'bg-border'}`} style={{ height: `${4 + i * 2}px` }} />
      ))}
    </span>
  )
}

// reasoning level as 0-3 bars on the trigger chip
function EffortBars({ level }: { level: number }) {
  return (
    <span className="inline-flex items-end gap-px h-2.5" aria-hidden>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`w-0.5 rounded-sm ${i <= level ? 'bg-accent' : 'bg-border'}`} style={{ height: `${3 + i * 2}px` }} />
      ))}
    </span>
  )
}

export default function ModelPicker({ models, value, onChange, disabled, placement = 'down' }: ModelPickerProps) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const [open, setOpen] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const effortName = useId()
  const effort = useReasoningEffort()
  const current = models.find((m: PickerModel) => m.id === value) || models[0]
  const { recommended, more } = useMemo(() => splitCatalog(models), [models])
  const badgeMode = useMemo(() => visionBadgeMode(models), [models])
  const moreCount = models.length - recommended.length
  const effortLevels = effortLevelsOf(current)
  const effortLevel = effortLevels.includes(effort) ? EFFORT_CHOICES.indexOf(effort) : 0
  const defaultId = models[0]?.id
  const currentIsMore = !!current && !recommended.some((m) => m.id === current.id)

  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }

  // keyboard focus moved to something outside this picker (e.g. its twin): close, so one dialog is open at a time
  const onFocusOut = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (open && next && !ref.current?.contains(next)) close(false)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // opening: the "more" section starts expanded when the current model lives
  // there, and focus moves to the selected model
  useEffect(() => {
    if (!open) return
    setShowMore(currentIsMore)
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // While /api/models is still loading, `models` is empty and there's no
  // `current`. Render a shimmer placeholder with the same footprint as the
  // button instead of nothing — otherwise the picker "pops in" abruptly.
  if (!current) {
    return (
      <div className="flex items-center gap-2 rounded-control px-2.5 py-1.5" aria-hidden>
        <Skeleton className="w-4 h-4 shrink-0" rounded="rounded-full" />
        <Skeleton className="h-4 w-24" />
        <Icon.ChevronDown size={15} className="text-[var(--faint)] shrink-0 opacity-40" />
      </div>
    )
  }

  const pick = (id: string) => {
    onChange(id)
    close()
  }

  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...panelRef.current!.querySelectorAll<HTMLElement>('[data-model-item]')]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1
    items[next]!.focus()
  }

  // a search covers the whole catalog (the pinned three included)
  const searching = !!query.trim()
  const filtered = searching ? groupByProvider(filterModels(models, query)) : more

  const item = (m: PickerModel) => {
    const selected = m.id === value
    const badge = showsVisionBadge(m, badgeMode)
    const blurb = modelBlurb(m, t)
    const tier = costTier(m, models)
    return (
      <button
        type="button"
        key={m.id}
        data-model-item
        aria-pressed={selected}
        onClick={() => pick(m.id)}
        className={`w-full text-left rounded-control px-2 py-2 transition duration-fast flex gap-2.5 items-center ${
          selected ? 'bg-sunk' : 'hover:bg-sunk'
        }`}
      >
        <span className="grid place-items-center w-8 h-8 shrink-0 rounded-control bg-sunk border border-border-soft text-fg">
          <ProviderMark model={m} size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-semibold text-body truncate">{m.label}</span>
            {m.id === defaultId && (
              <span className="shrink-0 text-caption font-medium text-accent-text bg-accent-soft rounded-badge px-1.5">{t('composer.model.default')}</span>
            )}
            {badge && (
              <span
                className="shrink-0 text-caption font-medium text-[var(--muted)] border border-[var(--border)] rounded-badge px-1.5"
                title={badgeMode === 'vision' ? t('modelPicker.visionHint') : t('modelPicker.noVisionHint')}
              >
                {badgeMode === 'vision' ? t('modelPicker.vision') : t('modelPicker.noVision')}
              </span>
            )}
          </span>
          {blurb && <span className="block text-label text-[var(--muted)] mt-0.5">{blurb}</span>}
        </span>
        {tier && <CostBars tier={tier} label={t(`composer.model.cost.${tier}`)} />}
        {selected && <Icon.Check size={16} className="text-[var(--accent)] shrink-0" />}
      </button>
    )
  }

  const groupLabel = 'px-3 pt-2 pb-1 text-caption font-semibold text-[var(--muted)]'

  return (
    <div className="relative min-w-0" ref={ref} onBlur={onFocusOut}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('modelPicker.trigger', { name: current.label })}
        title={current.label}
        className="flex items-center gap-1.5 max-w-full min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-control hover:bg-sunk px-2 py-1 text-label font-medium text-fg transition duration-fast disabled:text-disabled-text"
      >
        <ProviderMark model={current} size={16} className="shrink-0" />
        <span className="truncate">{current.label}</span>
        {effortLevels.length > 0 && (
          <span
            className="hidden [@container(min-width:520px)]:inline-flex items-center gap-1 rounded-badge bg-sunk px-1.5 py-0.5 text-caption text-muted shrink-0"
            title={t('composer.model.reasoningChip', { level: t(`composer.effort.${effortLevel ? EFFORT_CHOICES[effortLevel] : 'auto'}`) })}
          >
            <EffortBars level={effortLevel} />
            {effortLevel > 0 && <span>{t(`modelPicker.effort.${EFFORT_CHOICES[effortLevel]}`)}</span>}
          </span>
        )}
        <Icon.ChevronDown size={14} className="text-[var(--muted)] shrink-0" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('modelPicker.heading')}
          onKeyDown={onPanelKey}
          className={`fixed left-2 right-2 ${placement === 'up' ? 'bottom-28 md:bottom-full md:mb-2 md:right-0 md:left-auto' : 'top-14 md:top-auto md:mt-2 md:left-0 md:right-auto'} md:absolute md:w-[380px] z-dropdown max-h-[70vh] overflow-y-auto rounded-card border border-border bg-raised shadow-overlay p-1.5 animate-fade-in`}
        >
          <div className="px-3 pt-1.5 pb-1 text-label font-semibold text-[var(--text)]">{t('modelPicker.heading')}</div>
          {!searching && moreCount > 0 && <div className={groupLabel}>{t('modelPicker.recommended')}</div>}
          {!searching && recommended.map(item)}

          {moreCount > 0 && (
            <div className="mt-1 border-t border-[var(--border)] pt-1">
              <button
                type="button"
                aria-expanded={showMore}
                onClick={() => setShowMore((v) => !v)}
                className="w-full flex items-center gap-2 rounded-control px-3 min-h-9 text-label font-semibold text-[var(--muted)] hover:text-[var(--text)] hover:bg-sunk transition duration-fast"
              >
                <Icon.ChevronRight size={14} className={`shrink-0 transition-transform duration-fast ${showMore ? 'rotate-90' : ''}`} />
                {t('modelPicker.more', { n: moreCount })}
              </button>
              {showMore && (
                <div className="pt-1">
                  <div className="relative px-1.5 mb-1">
                    <Icon.Search size={13} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--faint)] pointer-events-none" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t('modelPicker.search')}
                      aria-label={t('modelPicker.search')}
                      className="w-full min-h-9 rounded-control bg-sunk border border-[var(--border)] pl-8 pr-3 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                  {filtered.length === 0 && <p className="px-3 py-3 text-label text-[var(--muted)] text-center">{t('modelPicker.noResults', { q: query.trim() })}</p>}
                  {filtered.map((g) => (
                    <div key={g.provider} role="group" aria-label={g.provider}>
                      <div className={groupLabel}>{g.provider}</div>
                      {g.models.map(item)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {effortLevels.length > 0 && (
            // only for a model the catalog says takes it (probed); a native radio
            // group, so arrows/Tab/Space work without custom key handling
            <fieldset className="mx-1.5 mt-2 mb-1 border-t border-border pt-2" data-testid="effort-control">
              <legend className="sr-only">{t('modelPicker.effort')}</legend>
              <div className="flex items-baseline justify-between gap-2 px-1.5 pb-1.5" aria-hidden>
                <span className="text-label font-semibold text-fg">{t('modelPicker.effort')}</span>
              </div>
              <div className="flex gap-0.5 rounded-control bg-sunk p-0.5">
                {EFFORT_CHOICES.map((level) => (
                  <label key={level} className="flex-1 min-w-0">
                    <input
                      type="radio"
                      name={effortName}
                      value={level}
                      checked={effort === level || (level === 'auto' && !effortLevels.includes(effort))}
                      onChange={() => setReasoningEffort(level)}
                      disabled={level !== 'auto' && !effortLevels.includes(level)}
                      className="peer sr-only"
                    />
                    <span className="block text-center truncate rounded-control px-2 min-h-8 [@media(pointer:coarse)]:min-h-11 leading-8 [@media(pointer:coarse)]:leading-[2.75rem] text-label text-muted cursor-pointer hover:text-fg peer-checked:bg-raised peer-checked:text-fg peer-checked:font-semibold peer-checked:shadow-raised peer-disabled:opacity-40 peer-disabled:cursor-not-allowed peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent)]">
                      {level === 'auto' ? t('composer.effort.auto') : t(`modelPicker.effort.${level}`)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 px-1.5 text-caption text-[var(--muted)]">{t('modelPicker.effortHint')}</p>
            </fieldset>
          )}
          <p className="px-3 pb-1.5 pt-1 text-caption text-[var(--muted)]">{t('composer.model.costHint')}</p>
        </div>
      )}
    </div>
  )
}
