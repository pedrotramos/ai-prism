import { useState, useRef, useEffect, useId, useMemo } from 'react'
import * as Icon from './Icons.jsx'
import Skeleton from './Skeleton.jsx'
import { useT } from '../lib/i18n.jsx'
import { modelBlurb } from '../lib/modelBlurb.js'
import { effortLevelsOf, useReasoningEffort, setReasoningEffort } from '../lib/reasoningEffort.js'
import { splitCatalog, filterModels, groupByProvider, visionBadgeMode, showsVisionBadge } from '../app/modelGroups.js'

const PROVIDER_DOT = {
  Anthropic: '#D97757',
  OpenAI: '#10A37F',
  'OpenAI (OSS)': '#10A37F',
  Google: '#4285F4',
  Meta: '#0668E1',
  Alibaba: '#FF6A00',
  'Zhipu AI': '#3859FF',
}
const dot = (provider) => PROVIDER_DOT[provider] || 'var(--faint)'

// The header's model picker. Three recommended models are pinned (Hick: most
// people pick from a short list); the rest sit under "More models", grouped by
// provider, with a search box. The image badge appears only on the minority, so
// it tells the user something. Popover: Escape and an outside click close it,
// focus returns to the trigger, arrow keys move between models.
export default function ModelPicker({ models, value, onChange, disabled }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const panelId = useId()
  const effortName = useId()
  const effort = useReasoningEffort()
  const current = models.find((m) => m.id === value) || models[0]
  const { recommended, more } = useMemo(() => splitCatalog(models), [models])
  const badgeMode = useMemo(() => visionBadgeMode(models), [models])
  const moreCount = models.length - recommended.length
  const effortLevels = effortLevelsOf(current)
  const currentIsMore = !!current && !recommended.some((m) => m.id === current.id)

  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && close(false)
    const onKey = (e) => e.key === 'Escape' && close()
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
    requestAnimationFrame(() => panelRef.current?.querySelector('[aria-pressed="true"]')?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // While /api/models is still loading, `models` is empty and there's no
  // `current`. Render a shimmer placeholder with the same footprint as the
  // button instead of nothing — otherwise the picker "pops in" abruptly.
  if (!current) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5" aria-hidden>
        <Skeleton className="w-2 h-2 shrink-0" rounded="rounded-full" />
        <Skeleton className="h-4 w-24" />
        <Icon.ChevronDown size={15} className="text-[var(--faint)] shrink-0 opacity-40" />
      </div>
    )
  }

  const pick = (id) => {
    onChange(id)
    close()
  }

  const onPanelKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...panelRef.current.querySelectorAll('[data-model-item]')]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1
    items[next].focus()
  }

  // a search covers the whole catalog (the pinned three included)
  const searching = !!query.trim()
  const filtered = searching ? groupByProvider(filterModels(models, query)) : more

  const item = (m) => {
    const selected = m.id === value
    const badge = showsVisionBadge(m, badgeMode)
    const blurb = modelBlurb(m, t)
    return (
      <button
        type="button"
        key={m.id}
        data-model-item
        aria-pressed={selected}
        onClick={() => pick(m.id)}
        className={`w-full text-left rounded-control px-3 py-2 transition duration-fast flex gap-2.5 items-start ${
          selected ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]'
        }`}
      >
        <span className="mt-1.5 w-2 h-2 rounded-pill shrink-0" style={{ background: dot(m.provider) }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-semibold text-body truncate">{m.label}</span>
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
        {selected && <Icon.Check size={16} className="text-[var(--accent)] mt-1 shrink-0" />}
      </button>
    )
  }

  const groupLabel = 'px-3 pt-2 pb-1 text-caption font-semibold text-[var(--muted)]'

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('modelPicker.trigger', { name: current.label })}
        className="flex items-center gap-2 max-w-full min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-card border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-3 py-1.5 text-body font-medium transition duration-fast disabled:bg-disabled disabled:text-disabled-text"
      >
        <span className="w-2 h-2 rounded-pill shrink-0" style={{ background: dot(current.provider) }} />
        <span className="truncate">{current.label}</span>
        <Icon.ChevronDown size={15} className="text-[var(--muted)] shrink-0" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('modelPicker.heading')}
          onKeyDown={onPanelKey}
          className="fixed left-2 right-2 top-14 md:absolute md:left-0 md:right-auto md:top-auto md:mt-2 md:w-[340px] z-dropdown max-h-[70vh] overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-overlay p-1.5"
        >
          <div className="px-3 pt-1.5 pb-1 text-label font-semibold text-[var(--text)]">{t('modelPicker.heading')}</div>
          {effortLevels.length > 0 && (
            // only for a model the catalog says takes it (probed); a native radio
            // group, so arrows/Tab/Space work without custom key handling
            <fieldset className="mx-1.5 mb-1.5 rounded-control border border-[var(--border)] px-3 py-2" data-testid="effort-control">
              <legend className="px-1 text-caption font-semibold text-[var(--muted)]">{t('modelPicker.effort')}</legend>
              <div className="flex gap-1">
                {['default', ...effortLevels].map((level) => (
                  <label key={level} className="flex-1 min-w-0">
                    <input
                      type="radio"
                      name={effortName}
                      value={level}
                      checked={effort === level || (level === 'default' && !effortLevels.includes(effort))}
                      onChange={() => setReasoningEffort(level)}
                      className="peer sr-only"
                    />
                    <span className="block text-center truncate rounded-control border border-[var(--border)] px-2 min-h-9 [@media(pointer:coarse)]:min-h-11 leading-9 [@media(pointer:coarse)]:leading-[2.75rem] text-label cursor-pointer hover:bg-[var(--surface-2)] peer-checked:bg-[var(--surface-3)] peer-checked:font-semibold peer-checked:border-[var(--accent)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent)]">
                      {t(`modelPicker.effort.${level}`)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-caption text-[var(--muted)]">{t('modelPicker.effortHint')}</p>
            </fieldset>
          )}
          {!searching && moreCount > 0 && <div className={groupLabel}>{t('modelPicker.recommended')}</div>}
          {!searching && recommended.map(item)}

          {moreCount > 0 && (
            <div className="mt-1 border-t border-[var(--border)] pt-1">
              <button
                type="button"
                aria-expanded={showMore}
                onClick={() => setShowMore((v) => !v)}
                className="w-full flex items-center gap-2 rounded-control px-3 min-h-9 text-label font-semibold text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition duration-fast"
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
                      className="w-full min-h-9 rounded-control bg-[var(--surface-2)] border border-[var(--border)] pl-8 pr-3 text-body outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
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
        </div>
      )}
    </div>
  )
}
