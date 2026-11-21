import { useEffect, useId, useMemo, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import Skeleton from '../Skeleton.jsx'
import ChartBlock from '../blocks/ChartBlock.jsx'
import WebSearchCostTile from './WebSearchCostTile.jsx'
import { useI18n } from '../../lib/i18n.tsx'
import {
  BREAKDOWNS,
  PERIOD_PRESETS,
  COLUMNS,
  LABEL_COLUMN,
  MONEY_COLUMNS,
  NUMBER_COLUMNS,
  KNOWN_PRODUCTS,
  presetPeriod,
  presetOf,
  validPeriod,
  intlLocale,
  periodLabel,
  formatUsd,
  formatNumber,
  toCsv,
  csvFilename,
  costsQuery,
  errorState,
} from './costsData.js'

// Admin Costs page (#/costs): billed cost of this AI Prism installation from
// the Databricks system tables (GET /api/costs, run with the admin's own
// token), by resource / model / person / tag, for a period, with CSV export.
// It replaces the chat column, so it is the page's <main>. A non-admin who
// opens the link gets "admins only" (the server answers 403); an admin
// without SELECT on the system tables gets a no-access explanation, not an
// error.

const CHART_TOP = 10

async function fetchJson(url, signal) {
  const r = await fetch(url, { signal })
  let body = {}
  try {
    body = await r.json()
  } catch {
    // an HTML error page from a proxy: keep the status only
  }
  return { ok: r.ok, status: r.status, body }
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const control =
  'min-h-11 rounded-control bg-[var(--surface-2)] border border-[var(--border)] px-2.5 text-body focus:border-[var(--accent)]'

function StatePanel({ icon, title, hint, role, children }) {
  const IconCmp = icon
  return (
    <div role={role} className="mx-auto my-8 max-w-lg rounded-card border border-dashed border-[var(--border)] px-6 py-8 text-center">
      {IconCmp && <IconCmp size={22} className="mx-auto mb-3 text-[var(--muted)]" />}
      <h2 className="text-title font-semibold text-[var(--text)]">{title}</h2>
      <p className="mt-2 text-body text-[var(--muted)]">{hint}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

function LoadingRows({ label }) {
  return (
    <div role="status" aria-live="polite" className="py-4 space-y-3">
      <p className="text-label text-[var(--muted)]">{label}</p>
      <Skeleton className="h-40 w-full" rounded="rounded-card" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}

export default function CostsPage({ onBack }) {
  const { t, locale } = useI18n()
  const loc = intlLocale(locale)
  const titleId = useId()
  const fromId = useId()
  const toId = useId()
  const tagId = useId()
  const tabBase = useId()
  const tabRefs = useRef({})

  const [meta, setMeta] = useState(null)
  const [metaDenied, setMetaDenied] = useState(false)
  const [by, setBy] = useState('resource')
  const [period, setPeriod] = useState(() => presetPeriod(30))
  const [draft, setDraft] = useState(period)
  const [tagKey, setTagKey] = useState('')
  const [reload, setReload] = useState(0)
  const [load, setLoad] = useState({ state: 'loading', data: null })

  useEffect(() => {
    const ctrl = new AbortController()
    fetchJson('/api/costs/meta', ctrl.signal)
      .then((r) => {
        if (r.ok) {
          setMeta(r.body)
          setTagKey((k) => k || r.body.tagKeys?.[0] || '')
        } else if (r.status === 403) setMetaDenied(true)
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoad({ state: 'loading', data: null })
    fetchJson(`/api/costs?${costsQuery({ by, ...period, tag: tagKey })}`, ctrl.signal)
      .then((r) => {
        if (r.ok) setLoad({ state: 'ok', data: r.body })
        else setLoad({ state: errorState(r.status, r.body?.code), data: null })
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') setLoad({ state: 'error', data: null })
      })
    return () => ctrl.abort()
  }, [by, period, by === 'tag' ? tagKey : '', reload]) // eslint-disable-line react-hooks/exhaustive-deps

  const preset = presetOf(period)
  const draftValid = validPeriod(draft)
  const changeDraft = (patch) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (validPeriod(next)) setPeriod(next)
  }
  const choosePreset = (days) => {
    const p = presetPeriod(days)
    setDraft(p)
    setPeriod(p)
  }

  const rows = load.state === 'ok' ? load.data?.rows || [] : []
  const columns = COLUMNS[by]
  const labelOf = (r) => {
    const v = r[LABEL_COLUMN[by]]
    if (by === 'tag' && (v === null || v === '')) return t('costs.untagged')
    return v ?? '—'
  }
  const cellText = (col, r) => {
    const v = r[col]
    if (MONEY_COLUMNS.has(col)) return formatUsd(v, loc)
    if (NUMBER_COLUMNS.has(col)) return formatNumber(v, loc)
    if (col === 'product') return KNOWN_PRODUCTS.includes(v) ? t(`costs.product.${v}`) : v ?? '—'
    if (col === LABEL_COLUMN[by]) return labelOf(r)
    return v ?? '—'
  }

  const chartBlock = useMemo(() => {
    const top = rows.filter((r) => (r.usd || 0) > 0).slice(0, CHART_TOP)
    if (!top.length) return null
    return {
      type: 'chart',
      chartType: 'bar',
      title: t('costs.chartTitle', { n: top.length }),
      series: [{ name: 'USD', data: top.map((r) => ({ label: String(labelOf(r)), value: r.usd })) }],
    }
  }, [rows, by, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const onTabKey = (e, i) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    let next = null
    if (step) next = BREAKDOWNS[(i + step + BREAKDOWNS.length) % BREAKDOWNS.length]
    else if (e.key === 'Home') next = BREAKDOWNS[0]
    else if (e.key === 'End') next = BREAKDOWNS[BREAKDOWNS.length - 1]
    if (!next) return
    e.preventDefault()
    setBy(next)
    tabRefs.current[next]?.focus()
  }

  const notAdmin = metaDenied || load.state === 'notAdmin'
  const totals = load.state === 'ok' ? load.data?.totals : null
  const periodText = periodLabel(period, loc)

  return (
    <main aria-labelledby={titleId} className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <header className="shrink-0 flex items-center gap-2 px-3 md:px-6 h-14 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="w-11 h-11 -ml-1 grid place-items-center rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-[var(--text)] transition-colors duration-fast"
          aria-label={t('costs.back')}
          title={t('costs.back')}
        >
          <Icon.ChevronLeft size={20} />
        </button>
        <h1 id={titleId} className="font-bold text-title flex items-center gap-2">
          <Icon.Gauge size={18} /> {t('costs.title')}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl w-full mx-auto px-4 md:px-6 py-5 flex flex-col gap-5">
          {notAdmin ? (
            <StatePanel icon={Icon.Shield} title={t('costs.notAdmin.title')} hint={t('costs.notAdmin.hint')} />
          ) : (
            <>
              <div>
                <p className="text-body text-[var(--muted)]">{t('costs.subtitle')}</p>
                <p className="mt-1 text-label text-[var(--faint)]">{t('costs.lag')}</p>
              </div>

              <fieldset className="flex flex-wrap items-end gap-3 min-w-0">
                <legend className="text-label font-semibold text-[var(--muted)] mb-1.5">{t('costs.period')}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {PERIOD_PRESETS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => choosePreset(d)}
                      aria-pressed={preset === d}
                      className={`min-h-11 rounded-control border px-3 text-label font-medium transition-colors duration-fast ${
                        preset === d
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]'
                          : 'border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                      }`}
                    >
                      {t(`costs.last${d}`)}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={fromId} className="text-caption text-[var(--muted)]">
                      {t('costs.from')}
                    </label>
                    <input
                      id={fromId}
                      type="date"
                      value={draft.from}
                      max={draft.to || undefined}
                      onChange={(e) => changeDraft({ from: e.target.value })}
                      aria-invalid={!draftValid || undefined}
                      className={control}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={toId} className="text-caption text-[var(--muted)]">
                      {t('costs.to')}
                    </label>
                    <input
                      id={toId}
                      type="date"
                      value={draft.to}
                      min={draft.from || undefined}
                      onChange={(e) => changeDraft({ to: e.target.value })}
                      aria-invalid={!draftValid || undefined}
                      className={control}
                    />
                  </div>
                </div>
                {(!draftValid || load.state === 'badPeriod') && (
                  <p role="status" className="basis-full text-label text-[var(--danger)]">
                    {t('costs.badPeriod')}
                  </p>
                )}
              </fieldset>

              <section aria-label={t('costs.total')} className="flex flex-wrap gap-3">
                <div className="min-w-44 rounded-card border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                  <div className="text-label text-[var(--muted)]">{t('costs.total')}</div>
                  <div data-testid="costs-total" className="mt-1 text-heading font-bold tabular-nums">
                    {totals ? formatUsd(totals.usd, loc) : '—'}
                  </div>
                  <div data-testid="costs-period" className="mt-0.5 text-caption text-[var(--faint)] tabular-nums">
                    {periodText}
                  </div>
                </div>
                <div className="min-w-32 rounded-card border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
                  <div className="text-label text-[var(--muted)]">{t('costs.totalDbus')}</div>
                  <div className="mt-1 text-heading font-bold tabular-nums">{totals ? formatNumber(totals.dbus, loc) : '—'}</div>
                </div>
              </section>

              {/* after the admin check (meta) answered: a non-admin never asks the ledger endpoint */}
              {meta && <WebSearchCostTile period={period} />}

              <div>
                <div role="tablist" aria-label={t('costs.breakdownLabel')} className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
                  {BREAKDOWNS.map((b, i) => (
                    <button
                      key={b}
                      ref={(el) => (tabRefs.current[b] = el)}
                      type="button"
                      role="tab"
                      id={`${tabBase}-tab-${b}`}
                      aria-selected={by === b}
                      aria-controls={`${tabBase}-panel`}
                      tabIndex={by === b ? 0 : -1}
                      onClick={() => setBy(b)}
                      onKeyDown={(e) => onTabKey(e, i)}
                      className={`shrink-0 min-h-11 px-3 -mb-px border-b-2 text-body font-medium transition-colors duration-fast ${
                        by === b
                          ? 'border-[var(--accent)] text-[var(--text)]'
                          : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      {t(`costs.by.${b}`)}
                    </button>
                  ))}
                </div>

                <div role="tabpanel" id={`${tabBase}-panel`} aria-labelledby={`${tabBase}-tab-${by}`} className="pt-4 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    {by === 'tag' && (
                      <div className="flex items-center gap-2">
                        <label htmlFor={tagId} className="text-label text-[var(--muted)]">
                          {t('costs.tagKey')}
                        </label>
                        <select id={tagId} value={tagKey} onChange={(e) => setTagKey(e.target.value)} className={control}>
                          {(meta?.tagKeys || (tagKey ? [tagKey] : [])).map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={!rows.length}
                      onClick={() => download(csvFilename(by, period), toCsv(columns, rows))}
                      className="ml-auto min-h-11 inline-flex items-center gap-1.5 rounded-control border border-[var(--border)] px-3.5 text-body font-medium hover:bg-[var(--surface-2)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-fast"
                    >
                      <Icon.Download size={15} /> {t('costs.export')}
                    </button>
                  </div>
                  <p className="text-label text-[var(--muted)]">{t(`costs.note.${by}`)}</p>

                  {load.state === 'loading' ? (
                    <LoadingRows label={t('costs.loading')} />
                  ) : load.state === 'noAccess' ? (
                    <StatePanel icon={Icon.Shield} title={t('costs.noAccess.title')} hint={t('costs.noAccess.hint')} />
                  ) : load.state === 'noWarehouse' ? (
                    <StatePanel icon={Icon.Database} title={t('costs.noWarehouse.title')} hint={t('costs.noWarehouse.hint')} />
                  ) : load.state === 'badPeriod' ? null : load.state === 'error' ? (
                    <StatePanel icon={Icon.AlertTriangle} role="alert" title={t('costs.error.title')} hint={t('costs.error.hint')}>
                      <button
                        type="button"
                        onClick={() => setReload((n) => n + 1)}
                        className="min-h-11 inline-flex items-center gap-1.5 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] px-3.5 text-body font-semibold hover:brightness-110 transition duration-fast"
                      >
                        <Icon.Regenerate size={15} /> {t('costs.retry')}
                      </button>
                    </StatePanel>
                  ) : rows.length === 0 ? (
                    <StatePanel title={t('costs.empty.title')} hint={t('costs.empty.hint')} />
                  ) : (
                    <>
                      {chartBlock && <ChartBlock block={chartBlock} />}
                      <div
                        role="region"
                        tabIndex={0}
                        aria-label={t('costs.tableCaption', { view: t(`costs.by.${by}`), period: periodText })}
                        className="overflow-x-auto rounded-card border border-[var(--border)]"
                      >
                        <table className="w-full text-body">
                          <caption className="sr-only">{t('costs.tableCaption', { view: t(`costs.by.${by}`), period: periodText })}</caption>
                          <thead className="bg-[var(--surface-2)] text-label text-[var(--muted)]">
                            <tr>
                              {columns.map((c) => (
                                <th
                                  key={c}
                                  scope="col"
                                  className={`px-3 py-2 font-semibold whitespace-nowrap ${MONEY_COLUMNS.has(c) || NUMBER_COLUMNS.has(c) ? 'text-right' : 'text-left'}`}
                                >
                                  {t(`costs.col.${c}`)}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border)]">
                            {rows.map((r, i) => (
                              <tr key={i}>
                                {columns.map((c) => (
                                  <td
                                    key={c}
                                    className={`px-3 py-2 ${MONEY_COLUMNS.has(c) || NUMBER_COLUMNS.has(c) ? 'text-right tabular-nums whitespace-nowrap' : 'text-left break-all'}`}
                                  >
                                    {cellText(c, r)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
