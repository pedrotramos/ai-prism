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

// Taxímetro: what the user has spent this month and what the open conversation
// cost so far, at list price (server/usage.js ledger). Refreshes when a turn
// ends (`streaming` true→false), when the conversation changes, when a studio
// edit lands (USAGE_EVENT) and when the window regains focus.
export default function CostMeter({ sessionId, streaming }) {
  const { t, locale } = useI18n()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const wasStreaming = useRef(streaming)

  const load = useCallback(async () => {
    try {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      setData(await getJSON(`/api/usage/summary${q}`))
    } catch {
      // the meter is informational — never surface its failures
    }
  }, [sessionId])

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
  const approx = month.estimated || session?.estimated ? '≈' : ''
  // in the billing month's own time zone — in the browser's, a UTC reset at
  // 00:00 on the 1st would read as the last day of the month in the Americas
  const resets = new Date(month.resetsAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: month.timezone || 'UTC' })
  const kinds = session ? KINDS.filter((k) => session.byKind?.[k]) : []

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t('meter.title')}
        className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-2.5 py-1.5 text-xs tabular-nums transition"
      >
        <Icon.Gauge size={15} className={streaming ? 'text-[var(--accent)] animate-pulse' : 'text-[var(--muted)]'} />
        {session && (
          <span className="hidden sm:inline">
            <span className="text-[var(--faint)]">{t('meter.session')} </span>
            {approx}
            {money(session.usd)}
          </span>
        )}
        {session && <span className="hidden sm:inline text-[var(--faint)]">·</span>}
        <span>
          <span className="text-[var(--faint)]">{t('meter.month')} </span>
          {approx}
          {money(month.usd)}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[300px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-4 space-y-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-[var(--muted)]">{t('meter.monthLabel')}</span>
            <span className="text-lg font-semibold tabular-nums">
              {approx}
              {money(month.usd)}
            </span>
          </div>
          <div className="text-[11px] text-[var(--faint)] -mt-2">{t('meter.resets', { date: resets })}</div>

          {session && (
            <div className="border-t border-[var(--border)] pt-3 space-y-1.5">
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
