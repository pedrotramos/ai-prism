import { useEffect, useId, useMemo, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import ChartBlock from '../blocks/ChartBlock.tsx'
import { putJSON } from '../../api.ts'
import { useI18n } from '../../lib/i18n.jsx'
import { formatNumber, formatUsd, intlLocale, periodLabel } from './costsData.js'
import { dailyChartBlock, fillDays, parsePriceInput, priceEditorRows, shortHash, tileState, toolErrorState, toolUsageQuery } from './toolUsageData.js'

// The web-search cost tile of the Costs page (admin only). It reads the app's own
// usage ledger (GET /api/admin/usage/tools: counts and money per day, provider and
// user hash), so it fetches on its own, follows the page's period and works without
// a SQL warehouse. Below it, the price editor of the fixed-cost rows
// (PUT /api/admin/tool-prices/:key): a price applies to future calls only.

const field =
  'min-h-11 w-32 rounded-control bg-[var(--surface-2)] border border-[var(--border)] px-2.5 text-body tabular-nums focus:border-[var(--accent)]'

function Stat({ label, value, testId }) {
  return (
    <div className="min-w-32 rounded-card border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-label text-[var(--muted)]">{label}</div>
      <div data-testid={testId} className="mt-1 text-heading font-bold tabular-nums">
        {value}
      </div>
    </div>
  )
}

function Table({ caption, columns, rows, numeric }) {
  return (
    <div role="region" tabIndex={0} aria-label={caption} className="overflow-x-auto rounded-card border border-[var(--border)]">
      <table className="w-full text-body">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-[var(--surface-2)] text-label text-[var(--muted)]">
          <tr>
            {columns.map((c, i) => (
              <th key={c} scope="col" className={`px-3 py-2 font-semibold whitespace-nowrap ${numeric.has(i) ? 'text-right' : 'text-left'}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-[var(--border)]">
              {r.map((cell, i) => (
                <td key={i} className={`px-3 py-2 ${numeric.has(i) ? 'text-right tabular-nums' : 'text-left'}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PriceRow({ row, name, loc, onSaved }) {
  const { t } = useI18n()
  const id = useId()
  const [text, setText] = useState(row.override == null ? '' : String(row.override))
  const [state, setState] = useState('idle') // idle | saving | saved | invalid | failed
  useEffect(() => setText(row.override == null ? '' : String(row.override)), [row.override])

  async function save(e) {
    e.preventDefault()
    const p = parsePriceInput(text)
    if (!p.ok) return setState('invalid')
    setState('saving')
    try {
      await putJSON(`/api/admin/tool-prices/${encodeURIComponent(row.key)}`, { per1kUsd: p.value })
      setState('saved')
      onSaved()
    } catch {
      setState('failed')
    }
  }

  const shown = row.provider ? row.effective : row.override
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2" data-testid={`price-row-${row.key}`}>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-caption text-[var(--muted)]">
          {name}
        </label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setState('idle')
          }}
          aria-label={t('costs.web.price.label', { name })}
          aria-invalid={state === 'invalid' || undefined}
          placeholder={shown == null ? t('costs.web.price.none') : String(shown)}
          className={field}
        />
      </div>
      <button
        type="submit"
        disabled={state === 'saving'}
        className="min-h-11 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] px-3.5 text-body font-semibold hover:brightness-110 disabled:opacity-60 transition duration-fast"
      >
        {t('costs.web.price.save')}
      </button>
      <span role="status" className={`text-label ${state === 'invalid' || state === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}>
        {state === 'saved' && t('costs.web.price.saved')}
        {state === 'invalid' && t('costs.web.price.invalid')}
        {state === 'failed' && t('costs.web.price.failed')}
        {state === 'idle' && row.provider && (row.effective == null ? t('costs.web.price.none') : t('costs.web.price.inEffect', { usd: formatUsd(row.effective, loc) }))}
      </span>
    </form>
  )
}

export default function WebSearchCostTile({ period }) {
  const { t, locale } = useI18n()
  const loc = intlLocale(locale)
  const titleId = useId()
  const periodKey = `${period.from}|${period.to}`
  // every answer is tagged with the period it belongs to (`key`)
  const [load, setLoad] = useState({ state: 'loading', data: null, key: periodKey })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    // a reload of the SAME period (a saved price) keeps its numbers; another period starts empty
    setLoad((l) => ({ state: 'loading', data: l.key === periodKey ? l.data : null, key: periodKey }))
    fetch(`/api/admin/usage/tools?${toolUsageQuery(period)}`, { signal: ctrl.signal })
      .then(async (r) => {
        let body = {}
        try {
          body = await r.json()
        } catch {
          // an HTML error page from a proxy: keep the status only
        }
        if (ctrl.signal.aborted) return
        setLoad(r.ok ? { state: 'ok', data: body, key: periodKey } : { state: toolErrorState(r.status, body.code), data: null, key: periodKey })
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') setLoad({ state: 'error', data: null, key: periodKey })
      })
    return () => ctrl.abort()
  }, [period.from, period.to, reload])

  // The render before the effect of a period change still holds the previous period's
  // answer: an answer of another period is never shown (loading until its own arrives).
  const current = load.key === periodKey
  const state = current ? load.state : 'loading'
  // while a reload of the same period runs (a saved price) the last answer stays on screen
  const data = current && (state === 'ok' || state === 'loading') ? load.data : null
  const kind = tileState(data?.totals)
  const periodText = periodLabel(period, loc)
  const chart = useMemo(
    () => (data && data.totals.calls ? dailyChartBlock(fillDays(data.byDay, period), { title: t('costs.web.daily'), seriesLabel: t('costs.web.series') }) : null),
    [data, period.from, period.to, t] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const rows = data ? priceEditorRows(data) : []
  const unpricedEstimate = data ? data.byProvider.reduce((a, p) => a + (p.estimatedUnpricedUsd ?? 0), 0) : 0
  const estimable = data ? data.byProvider.some((p) => p.unpricedCalls > 0 && p.estimatedUnpricedUsd != null) : false

  return (
    <section aria-labelledby={titleId} data-testid="web-search-tile" className="rounded-card border border-[var(--border)] p-4 flex flex-col gap-4">
      <div>
        <h2 id={titleId} className="text-title font-semibold flex items-center gap-2">
          <Icon.Search size={16} /> {t('costs.web.title')}
        </h2>
        <p className="mt-1 text-label text-[var(--muted)]">{t('costs.web.subtitle')}</p>
      </div>

      {state === 'loading' && !data ? (
        <div role="status" aria-live="polite" className="space-y-3">
          <p className="text-label text-[var(--muted)]">{t('costs.web.loading')}</p>
          <Skeleton className="h-16 w-full" rounded="rounded-card" />
        </div>
      ) : state === 'error' || state === 'notAdmin' || state === 'badPeriod' ? (
        <div role="alert" className="rounded-card border border-dashed border-[var(--border)] px-4 py-5 text-center">
          <Icon.AlertTriangle size={20} className="mx-auto mb-2 text-[var(--muted)]" />
          <p className="font-semibold">{t('costs.web.error.title')}</p>
          <p className="mt-1 text-body text-[var(--muted)]">{t('costs.web.error.hint')}</p>
          <button
            type="button"
            onClick={() => setReload((n) => n + 1)}
            className="mt-3 min-h-11 inline-flex items-center gap-1.5 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] px-3.5 text-body font-semibold hover:brightness-110 transition duration-fast"
          >
            <Icon.Regenerate size={15} /> {t('costs.retry')}
          </button>
        </div>
      ) : data ? (
        <>
          {kind === 'empty' ? (
            <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-5 text-center">
              <p className="font-semibold">{t('costs.web.empty.title')}</p>
              <p className="mt-1 text-body text-[var(--muted)]">{t('costs.web.empty.hint')}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-3">
                <Stat label={t('costs.web.calls')} value={formatNumber(data.totals.calls, loc)} testId="web-search-calls" />
                <Stat label={t('costs.web.cost')} value={formatUsd(data.totals.costUsd, loc)} testId="web-search-cost" />
                <Stat label={t('costs.web.unpriced')} value={formatNumber(data.totals.unpricedCalls, loc)} testId="web-search-unpriced" />
              </div>
              <p className="text-caption text-[var(--faint)] tabular-nums">{periodText}</p>
              {kind === 'unpriced' && (
                <p data-testid="web-search-unpriced-note" className="text-label text-[var(--muted)]">
                  {estimable
                    ? t('costs.web.unpricedEstimate', { n: formatNumber(data.totals.unpricedCalls, loc), usd: formatUsd(unpricedEstimate, loc) })
                    : t('costs.web.unpricedNoPrice', { n: formatNumber(data.totals.unpricedCalls, loc) })}
                </p>
              )}
              {chart && <ChartBlock block={chart} />}
              <div>
                <h3 className="mb-2 text-label font-semibold text-[var(--muted)]">{t('costs.web.byProvider')}</h3>
                <Table
                  caption={t('costs.web.tableCaption', { view: t('costs.web.byProvider'), period: periodText })}
                  columns={[t('costs.web.col.provider'), t('costs.web.col.calls'), t('costs.web.col.unpriced'), t('costs.web.col.cost'), t('costs.web.col.price')]}
                  numeric={new Set([1, 2, 3, 4])}
                  rows={data.byProvider.map((p) => [
                    p.provider,
                    formatNumber(p.calls, loc),
                    formatNumber(p.unpricedCalls, loc),
                    formatUsd(p.costUsd, loc),
                    p.pricePer1k == null ? '—' : formatUsd(p.pricePer1k, loc),
                  ])}
                />
              </div>
              {data.topUsers.length > 0 && (
                <div>
                  <h3 className="text-label font-semibold text-[var(--muted)]">{t('costs.web.topUsers')}</h3>
                  <p className="mb-2 text-caption text-[var(--faint)]">{t('costs.web.topUsersHint')}</p>
                  <Table
                    caption={t('costs.web.tableCaption', { view: t('costs.web.topUsers'), period: periodText })}
                    columns={[t('costs.web.col.user'), t('costs.web.col.calls'), t('costs.web.col.cost')]}
                    numeric={new Set([1, 2])}
                    rows={data.topUsers.map((u) => [<code key={u.userHash}>{shortHash(u.userHash)}</code>, formatNumber(u.calls, loc), formatUsd(u.costUsd, loc)])}
                  />
                </div>
              )}
            </>
          )}

          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="text-label font-semibold text-[var(--muted)]">{t('costs.web.price.title')}</h3>
            <p className="mb-3 text-caption text-[var(--faint)]">{t('costs.web.price.hint')}</p>
            <div className="flex flex-col gap-3">
              {rows.map((r) => (
                <PriceRow key={r.key} row={r} name={r.provider || t('costs.web.price.all')} loc={loc} onSaved={() => setReload((n) => n + 1)} />
              ))}
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}
