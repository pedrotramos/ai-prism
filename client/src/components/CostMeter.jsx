import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useI18n } from '../lib/i18n.tsx'
import { getJSON } from '../api.ts'
import { fmtCost } from './CostBadge.jsx'

// Fired by surfaces that spend outside a chat turn (studio AI edits) so the
// meter refreshes without polling. See notifyUsageChanged().
const USAGE_EVENT = 'prism-usage-changed'
export function notifyUsageChanged() {
  window.dispatchEvent(new Event(USAGE_EVENT))
}

// the ledger kinds, in the order the breakdown lists them
const KINDS = ['chat', 'tweak', 'image', 'media', 'intent', 'title', 'embedding', 'asset_label']

// $0 reads better as "$0.00" than "<$0.01" on a meter that hasn't run yet
const money = (v) => (v > 0 ? fmtCost(v) : '$0.00')

// Taxímetro: what the user has spent this month and what the open conversation
// cost so far, at list price (server/usage.js ledger). Refreshes when a turn
// ends (`streaming` true→false), when the conversation changes, when a studio
// edit lands (USAGE_EVENT) and when the window regains focus. `onSummary` hands
// the latest summary to the parent and `onSummaryError` reports a failed load.
// Spending caps are not enforced here: use the workspace's native budgets.
//
// `compact` (the chat column squeezed beside a studio): no labels, only the
// icon and ONE figure — the month; the rest stays in the popover. Below `sm`
// (phones) only the icon shows; the figures are in its accessible name and
// the popover. `closeKey`: the popover closes when it changes (route or
// conversation change), so it never lingers over a screen it no longer
// describes.
export default function CostMeter({ sessionId, streaming, compact = false, closeKey, onSummary, onSummaryError }) {
  const { t, locale } = useI18n()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const triggerRef = useRef(null)
  const panelId = useId()
  const wasStreaming = useRef(streaming)

  useEffect(() => {
    setOpen(false)
  }, [closeKey, sessionId])

  const load = useCallback(async () => {
    try {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const d = await getJSON(`/api/usage/summary${q}`)
      setData(d)
      onSummary?.(d)
    } catch {
      // the meter is informational — never surface its failures
      onSummaryError?.()
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (wasStreaming.current && !streaming) load()
    wasStreaming.current = streaming
  }, [streaming, load])

  useEffect(() => {
    const onFocus = () => load()
    window.addEventListener(USAGE_EVENT, load)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener(USAGE_EVENT, load)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false)
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // read-only dialog: focus the panel itself so its figures are read next
    requestAnimationFrame(() => document.getElementById(panelId)?.focus())
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!data) return null
  const month = data.month || {}
  const session = data.session
  const approx = month.estimated || session?.estimated ? '≈' : ''
  // in the billing month's own time zone — in the browser's, a UTC reset at
  // 00:00 on the 1st would read as the last day of the month in the Americas
  const resets = new Date(month.resetsAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: month.timezone || 'UTC' })
  const kinds = session ? KINDS.filter((k) => session.byKind?.[k]) : []

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t('meter.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`flex items-center justify-center shrink-0 whitespace-nowrap min-h-9 min-w-9 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:min-h-11 rounded-card border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] py-1.5 text-label tabular-nums transition duration-fast px-2 ${
          compact ? 'sm:gap-1.5' : 'sm:gap-2 sm:px-2.5'
        }`}
      >
        <Icon.Gauge size={15} className={streaming ? 'text-[var(--accent)] animate-pulse' : 'text-[var(--muted)]'} />
        {/* phones see only the icon: its name carries the figure */}
        <span className="sr-only sm:hidden">{t('meter.triggerLabel', { month: `${approx}${money(month.usd)}` })}</span>
        {session && !compact && (
          <span className={compact ? '' : 'hidden sm:inline'}>
            {!compact && <span className="text-[var(--faint)]">{t('meter.session')} </span>}
            {approx}
            {money(session.usd)}
          </span>
        )}
        {session && !compact && <span className="hidden sm:inline text-[var(--faint)]">·</span>}
        <span className="hidden sm:inline">
          {!compact && <span className="text-[var(--faint)]">{t('meter.month')} </span>}
          {approx}
          {money(month.usd)}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label={t('meter.monthLabel')}
          className="absolute right-0 z-dropdown mt-2 w-[min(300px,calc(100vw-1rem))] rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-overlay p-4 space-y-3 text-body"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[var(--muted)]">{t('meter.monthLabel')}</span>
            <span className="text-title font-semibold tabular-nums">
              {approx}
              {money(month.usd)}
            </span>
          </div>
          <div className="text-caption text-[var(--faint)] -mt-2">{t('meter.resets', { date: resets })}</div>

          {session && (
            <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
              <div className="flex items-baseline justify-between">
                <span className="text-[var(--muted)]">{t('meter.sessionLabel')}</span>
                <span className="font-semibold tabular-nums">
                  {approx}
                  {money(session.usd)}
                </span>
              </div>
              {kinds.map((k) => (
                <div key={k} className="flex justify-between text-label text-[var(--muted)]">
                  <span>
                    {t(`meter.kind.${k}`)}
                    <span className="text-[var(--faint)]"> · {session.byKind[k].calls}×</span>
                  </span>
                  <span className="tabular-nums">{money(session.byKind[k].usd)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-[var(--border)] pt-3 space-y-1 text-caption leading-relaxed text-[var(--faint)]">
            <p>{t('meter.disclaimer')}</p>
            {approx && <p>{t('meter.estimatedNote')}</p>}
            {(month.unpriced || session?.unpriced) && <p>{t('meter.unpricedNote')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
