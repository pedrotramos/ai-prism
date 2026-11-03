import { useCallback, useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { getJSON } from '../api.js'
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

// bar/ring/text tone per budget state (server/budgets.js budgetState)
const TONE = {
  ok: { bar: 'bg-[var(--accent)]', stroke: 'var(--accent)', text: '' },
  warn: { bar: 'bg-amber-400', stroke: '#fbbf24', text: 'text-amber-400' },
  exceeded: { bar: 'bg-red-500', stroke: '#ef4444', text: 'text-red-400' },
}

// Budget consumed as a small progress ring, drawn where the meter's gauge
// icon sits: the track is the full circle, the arc covers `pct`% clockwise
// from 12 o'clock (capped at a full ring when over budget).
function BudgetRing({ pct, color, pulse, size = 16, stroke = 2.5 }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`shrink-0 -rotate-90 ${pulse ? 'animate-pulse' : ''}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap={p > 0 && p < 100 ? 'round' : 'butt'}
        strokeDasharray={`${(p / 100) * c} ${c}`}
        style={{ transition: 'stroke-dasharray 0.4s ease' }}
      />
    </svg>
  )
}

// One toast per month per threshold (warning %, 100%) — remembered in
// localStorage so a reload or a second tab doesn't nag again. With the month
// hidden by the admin, the warning (which tells a percentage) is skipped; the
// "over budget" one carries no figure and still shows.
function toastOnce(month, budget, display, t, onNotify) {
  if (!budget || budget.state === 'ok' || !onNotify) return
  if (budget.state === 'warn' && display?.month === 'hidden') return
  const key = `prism-budget-toast:${month.start}:${budget.state}`
  if (localStorage.getItem(key)) return
  localStorage.setItem(key, '1')
  onNotify(
    budget.state === 'exceeded'
      ? t(budget.enforcement === 'block' ? 'meter.budget.toastBlocked' : 'meter.budget.toastExceeded')
      : t('meter.budget.toastWarn', { pct: Math.round(budget.pct) })
  )
}

// Taxímetro: what the user has spent this month and what the open conversation
// cost so far, at list price (server/usage.js ledger), plus the monthly budget
// when an admin configured one. Refreshes when a turn ends (`streaming`
// true→false), when the conversation changes, when a studio edit lands
// (USAGE_EVENT) and when the window regains focus. `onSummary` hands the latest
// summary to the parent (the composer's over-budget notice; what the admin lets
// users see), `onSummaryError` reports a failed load; `onNotify` shows the
// threshold toasts.
//
// The admin decides what shows (server/budgets.js meterView — the server already
// strips what's hidden): `display.session` (this conversation's cost) and
// `display.month` — 'usd', 'pct' (of the budget, no dollars) or 'hidden'.
export default function CostMeter({ sessionId, streaming, onSummary, onSummaryError, onNotify }) {
  const { t, locale } = useI18n()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const wasStreaming = useRef(streaming)

  const load = useCallback(async () => {
    try {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const d = await getJSON(`/api/usage/summary${q}`)
      setData(d)
      onSummary?.(d)
      toastOnce(d.month, d.budget, d.display, t, onNotify)
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
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!data) return null
  const month = data.month || {}
  const session = data.session
  const display = data.display || { session: true, month: 'usd' }
  const showMonth = display.month !== 'hidden'
  const inUsd = display.month === 'usd'
  // nothing the admin lets this user see right now → no meter at all (the
  // summary still loads: the composer's blocked notice depends on it)
  if (!showMonth && !session) return null
  const approx = month.estimated || session?.estimated ? '≈' : ''
  // in the billing month's own time zone — in the browser's, a UTC reset at
  // 00:00 on the 1st would read as the last day of the month in the Americas
  const resets = new Date(month.resetsAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: month.timezone || 'UTC' })
  const kinds = session ? KINDS.filter((k) => session.byKind?.[k]) : []
  const budget = data.budget
  const tone = TONE[budget?.state] || TONE.ok
  const budgetSource = !budget?.source
    ? ''
    : budget.source.kind === 'default'
      ? t('meter.budget.sourceDefault')
      : budget.source.kind === 'user'
        ? t('meter.budget.sourceUser')
        : t('meter.budget.sourceGroup', { group: budget.source.principal })

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={
          budget?.pct != null && showMonth
            ? `${t('meter.title')} — ${t('meter.budget.usedPct', { pct: Math.round(budget.pct) })}`
            : t('meter.title')
        }
        className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-2.5 py-1.5 text-xs tabular-nums transition"
      >
        {/* with a budget in view, the gauge icon gives way to the consumption ring */}
        {showMonth && budget?.pct != null ? (
          <BudgetRing pct={budget.pct} color={tone.stroke} pulse={streaming} />
        ) : (
          <Icon.Gauge size={15} className={streaming ? 'text-[var(--accent)] animate-pulse' : 'text-[var(--muted)]'} />
        )}
        {session && (
          <span className="hidden sm:inline">
            <span className="text-[var(--faint)]">{t('meter.session')} </span>
            {approx}
            {money(session.usd)}
          </span>
        )}
        {session && showMonth && <span className="hidden sm:inline text-[var(--faint)]">·</span>}
        {showMonth && (
          <span>
            <span className="text-[var(--faint)]">{t('meter.month')} </span>
            <span className={tone.text}>
              {inUsd ? (
                <>
                  {approx}
                  {money(month.usd)}
                </>
              ) : (
                `${Math.round(budget?.pct ?? 0)}%`
              )}
            </span>
            {budget && inUsd && <span className="text-[var(--faint)]"> / {money(budget.limitUsd)}</span>}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[300px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-4 space-y-3 text-sm">
          {showMonth && (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-[var(--muted)]">{t(inUsd ? 'meter.monthLabel' : 'meter.monthPctLabel')}</span>
                <span className="text-lg font-semibold tabular-nums">
                  {inUsd ? (
                    <>
                      {approx}
                      {money(month.usd)}
                    </>
                  ) : (
                    `${Math.round(budget?.pct ?? 0)}%`
                  )}
                </span>
              </div>
              <div className="text-[11px] text-[var(--faint)] -mt-2">{t('meter.resets', { date: resets })}</div>
            </>
          )}

          {budget && showMonth && (
            <div className="space-y-1.5">
              <div className="h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                <div className={`h-full ${tone.bar}`} style={{ width: `${Math.min(100, budget.pct)}%` }} />
              </div>
              <div className="flex justify-between text-xs">
                <span className={tone.text || 'text-[var(--muted)]'}>
                  {inUsd
                    ? t('meter.budget.used', { pct: Math.round(budget.pct), limit: money(budget.limitUsd) })
                    : t('meter.budget.usedPct', { pct: Math.round(budget.pct) })}
                </span>
                {inUsd && (
                  <span className="text-[var(--muted)] tabular-nums">{t('meter.budget.left', { amount: money(budget.remainingUsd) })}</span>
                )}
              </div>
              <div className="text-[11px] text-[var(--faint)] leading-relaxed">
                {budgetSource} ·{' '}
                {t(budget.enforcement === 'block' ? 'meter.budget.modeBlock' : 'meter.budget.modeWarn')}
              </div>
              {budget.state === 'exceeded' && (
                <div className={`text-[11px] leading-relaxed ${tone.text}`}>
                  {t(budget.enforcement === 'block' ? 'meter.budget.blocked' : 'meter.budget.over', { date: resets })}
                </div>
              )}
            </div>
          )}

          {session && (
            <div className={`space-y-1.5 ${showMonth ? 'border-t border-[var(--border)] pt-3' : ''}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-[var(--muted)]">{t('meter.sessionLabel')}</span>
                <span className="font-semibold tabular-nums">
                  {approx}
                  {money(session.usd)}
                </span>
              </div>
              {kinds.map((k) => (
                <div key={k} className="flex justify-between text-xs text-[var(--muted)]">
                  <span>
                    {t(`meter.kind.${k}`)}
                    <span className="text-[var(--faint)]"> · {session.byKind[k].calls}×</span>
                  </span>
                  <span className="tabular-nums">{money(session.byKind[k].usd)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-[var(--border)] pt-3 space-y-1 text-[11px] leading-relaxed text-[var(--faint)]">
            <p>{t('meter.disclaimer')}</p>
            {approx && <p>{t('meter.estimatedNote')}</p>}
            {(month.unpriced || session?.unpriced) && <p>{t('meter.unpricedNote')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
