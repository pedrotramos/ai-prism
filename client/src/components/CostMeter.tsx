import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useI18n } from '../lib/i18n.tsx'
import { getJSON } from '../api.ts'
import { fmtCost } from './CostBadge.tsx'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

// Fired by surfaces that spend outside a chat turn (studio AI edits) so the
// meter refreshes without polling. See notifyUsageChanged().
const USAGE_EVENT = 'prism-usage-changed'
export function notifyUsageChanged() {
  window.dispatchEvent(new Event(USAGE_EVENT))
}

/**
 * This month's spend for the sidebar card (Q6-A: everyone sees their own).
 * Same source as the cost pill (GET /api/usage/summary, month only). It
 * refreshes when a turn ends, when a studio edit lands and when the window
 * regains focus. A failed load keeps the last figure and never surfaces.
 */
export function useMonthSpend(streaming?: boolean): { amountUsd: number; loading: boolean; estimated: boolean } | null {
  const [state, setState] = useState<{ amountUsd: number; estimated: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    try {
      const d = await getJSON<UsageSummary>('/api/usage/summary')
      setState({ amountUsd: d.month?.usd ?? 0, estimated: !!d.month?.estimated })
    } catch {
      // informational only
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
    window.addEventListener(USAGE_EVENT, load)
    window.addEventListener('focus', load)
    return () => {
      window.removeEventListener(USAGE_EVENT, load)
      window.removeEventListener('focus', load)
    }
  }, [load])
  const was = useRef(streaming)
  useEffect(() => {
    if (was.current && !streaming) load()
    was.current = streaming
  }, [streaming, load])
  // never fetched and failed: nothing to show
  if (!state) return loading ? { amountUsd: 0, estimated: false, loading: true } : null
  return { ...state, loading: false }
}

// the ledger kinds, in the order the breakdown lists them
const KINDS = ['chat', 'tweak', 'image', 'media', 'intent', 'title', 'embedding', 'asset_label']

// $0 reads better as "$0.00" than "<$0.01" on a meter that hasn't run yet
const money = (v?: number) => (v !== undefined && v > 0 ? fmtCost(v) : '$0.00')

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
interface KindUsage {
  calls: number
  usd: number
}

interface UsageBucket {
  usd: number
  estimated?: boolean
  unpriced?: boolean
}

interface UsageSummary {
  month?: Partial<UsageBucket> & { resetsAt?: string; timezone?: string }
  session?: (UsageBucket & { byKind: Record<string, KindUsage> }) | null
}

interface CostMeterProps {
  sessionId?: number | string | null
  streaming?: boolean
  compact?: boolean
  closeKey?: unknown
  onSummary?: (summary: UsageSummary) => void
  onSummaryError?: () => void
}

export default function CostMeter({ sessionId, streaming, compact = false, closeKey, onSummary, onSummaryError }: CostMeterProps) {
  const { t, locale } = useI18n() as { t: Translate; locale: string }
  const [data, setData] = useState<UsageSummary | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const wasStreaming = useRef(streaming)

  useEffect(() => {
    setOpen(false)
  }, [closeKey, sessionId])

  const load = useCallback(async () => {
    try {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const d = await getJSON<UsageSummary>(`/api/usage/summary${q}`)
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
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
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
  const month: NonNullable<UsageSummary['month']> = data.month || {}
  const session = data.session
  const approx = month.estimated || session?.estimated ? '≈' : ''
  // in the billing month's own time zone — in the browser's, a UTC reset at
  // 00:00 on the 1st would read as the last day of the month in the Americas
  // (resetsAt is always present in the summary; `as string` only satisfies the type)
  const resets = new Date(month.resetsAt as string).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: month.timezone || 'UTC' })
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
        className={`flex items-center justify-center shrink-0 whitespace-nowrap min-h-9 min-w-9 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:min-h-11 rounded-control border border-[var(--border)] bg-[var(--raised)] hover:bg-[var(--surface-2)] py-1 text-label text-[var(--muted)] tabular-nums transition duration-fast px-2 ${
          compact ? 'sm:gap-1.5' : 'sm:gap-1.5 sm:px-2.5'
        }`}
      >
        {/* phones see only the icon (its name carries the figure); from `sm` up the figure replaces it, except while a turn runs */}
        <Icon.Gauge size={15} className={streaming ? 'text-[var(--accent)] animate-pulse' : 'sm:hidden'} />
        <span className="sr-only sm:hidden">{t('meter.triggerLabel', { month: `${approx}${money(month.usd)}` })}</span>
        {/* the open chat's spend, as the mockup's pill; before a chat exists, the month */}
        <span className="hidden sm:inline font-medium text-[var(--text)]">
          {approx}
          {money(session && !compact ? session.usd : month.usd)}
        </span>
        <span className="hidden sm:inline text-[var(--faint)]">{session && !compact ? t('meter.thisChat') : t('meter.month')}</span>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label={t('meter.monthLabel')}
          className="absolute right-0 z-dropdown mt-2 w-[min(300px,calc(100vw-1rem))] rounded-card border border-[var(--border)] bg-[var(--raised)] shadow-overlay p-4 space-y-3 text-body"
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
                    <span className="text-[var(--faint)]"> · {session.byKind[k]!.calls}×</span>
                  </span>
                  <span className="tabular-nums">{money(session.byKind[k]!.usd)}</span>
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
