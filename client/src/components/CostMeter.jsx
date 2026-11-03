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

// bar/border/text tone per budget state (server/budgets.js budgetState)
const TONE = {
  ok: { bar: 'bg-[var(--accent)]', stroke: 'var(--accent)', text: '' },
  warn: { bar: 'bg-amber-400', stroke: '#fbbf24', text: 'text-amber-400' },
  exceeded: { bar: 'bg-red-500', stroke: '#ef4444', text: 'text-red-400' },
}

// The chip's own border doubles as the budget bar: a stroke traced over it,
// clockwise from the top center, covering `pct`% of the perimeter (the plain
// border underneath is the track). Measured with a ResizeObserver so the
// rounded-rect path matches the chip at any width.
const CHIP_RADIUS = 12 // rounded-xl
const STROKE = 1.5
function BudgetBorder({ target, pct, color }) {
  const [size, setSize] = useState(null)
  useEffect(() => {
    const el = target.current
    if (!el) return
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [target])
  if (!size || !(pct > 0)) return null
  const { w, h } = size
  const i = STROKE / 2 // centre the stroke on the 1px border
  const R = Math.min(CHIP_RADIUS, h / 2)
  const r = R - i
  const d = [
    `M ${w / 2} ${i}`,
    `H ${w - R}`,
    `A ${r} ${r} 0 0 1 ${w - i} ${R}`,
    `V ${h - R}`,
    `A ${r} ${r} 0 0 1 ${w - R} ${h - i}`,
    `H ${R}`,
    `A ${r} ${r} 0 0 1 ${i} ${h - R}`,
    `V ${R}`,
    `A ${r} ${r} 0 0 1 ${R} ${i}`,
    'Z',
  ].join(' ')
  const p = Math.min(100, pct)
  return (
    <svg className="absolute inset-0 pointer-events-none overflow-visible" width={w} height={h} aria-hidden="true">
      <path
        d={d}
        pathLength={100}
        fill="none"
        stroke={color}
        strokeWidth={STROKE}
        strokeDasharray={p >= 100 ? undefined : `${p} 100`}
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
  const chipRef = useRef(null)
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
        ref={chipRef}
        onClick={() => setOpen((o) => !o)}
        title={
          budget?.pct != null && showMonth
            ? `${t('meter.title')} — ${t('meter.budget.usedPct', { pct: Math.round(budget.pct) })}`
            : t('meter.title')
        }
        className="relative flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-2.5 py-1.5 text-xs tabular-nums transition"
      >
        <Icon.Gauge size={15} className={streaming ? 'text-[var(--accent)] animate-pulse' : 'text-[var(--muted)]'} />
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
        {/* budget consumed = how much of the chip's border is filled */}
        {showMonth && budget?.pct != null && <BudgetBorder target={chipRef} pct={budget.pct} color={tone.stroke} />}
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
