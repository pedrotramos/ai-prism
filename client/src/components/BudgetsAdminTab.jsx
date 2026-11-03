import { useEffect, useMemo, useState } from 'react'
import * as Icon from './Icons.jsx'
import Skeleton from './Skeleton.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { getJSON, putJSON, del } from '../api.js'

const usd = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`)

// IANA zones offered in the select; UTC first (the default) since some engines
// leave it out of supportedValuesOf
function timeZones() {
  let list = []
  try {
    list = Intl.supportedValuesOf('timeZone')
  } catch {
    list = ['America/Sao_Paulo', 'America/New_York', 'Europe/London']
  }
  return ['UTC', ...list.filter((z) => z !== 'UTC')]
}

// Admin tab: optional monthly budgets. Settings are saved explicitly (enabling
// requires a default, validated inline and on the server); overrides per user
// or group save on add / on blur. The effective budget of a user is the
// LARGEST override that applies to them; the default covers everyone else.
export default function BudgetsAdminTab({ open }) {
  const { t, locale } = useI18n()
  const [config, setConfig] = useState(null) // { settings, rules, groupCheck }
  const [draft, setDraft] = useState(null) // editable copy of settings
  const [usage, setUsage] = useState(null) // { month, users }
  const [candidates, setCandidates] = useState([])
  const [newRule, setNewRule] = useState({ principal: '', monthlyUsd: '' })
  const [ruleEdits, setRuleEdits] = useState({}) // { 'kind:principal': amount string }
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const zones = useMemo(timeZones, [])

  const errText = (code) => (t(`budgets.error.${code}`) !== `budgets.error.${code}` ? t(`budgets.error.${code}`) : code)

  const load = async () => {
    try {
      const [c, u] = await Promise.all([getJSON('/api/admin/budgets'), getJSON('/api/admin/budgets/usage')])
      setConfig(c)
      setDraft({ ...c.settings, defaultUsd: c.settings.defaultUsd == null ? '' : String(c.settings.defaultUsd) })
      setUsage(u)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    if (!open) return
    load()
    getJSON('/api/admins/candidates')
      .then((r) => setCandidates(r.candidates || []))
      .catch(() => setCandidates([]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!config || !draft) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-72" />
        <Skeleton className="h-32 w-full mt-3" rounded="rounded-xl" />
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
    )
  }

  // same derivation as the admins panel: an exact candidate wins, else "@" → user
  const inferKind = (p) =>
    candidates.find((c) => c.principal.toLowerCase() === p.trim().toLowerCase())?.kind ||
    (p.includes('@') ? 'user' : 'group')

  const dirty =
    draft.enabled !== config.settings.enabled ||
    String(draft.defaultUsd) !== String(config.settings.defaultUsd ?? '') ||
    draft.enforcement !== config.settings.enforcement ||
    Number(draft.warnPct) !== config.settings.warnPct ||
    draft.timezone !== config.settings.timezone
  const needsDefault = draft.enabled && !(Number(draft.defaultUsd) > 0)

  const saveSettings = async () => {
    if (needsDefault) return setError(errText('default_required'))
    setBusy(true)
    try {
      await putJSON('/api/admin/budgets/settings', {
        enabled: draft.enabled,
        defaultUsd: draft.defaultUsd === '' ? null : Number(draft.defaultUsd),
        enforcement: draft.enforcement,
        warnPct: Number(draft.warnPct),
        timezone: draft.timezone,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      await load()
    } catch (e) {
      setError(errText(e.message))
    } finally {
      setBusy(false)
    }
  }

  const putRule = async (kind, principal, monthlyUsd) => {
    setBusy(true)
    try {
      await putJSON('/api/admin/budgets/rules', { kind, principal, monthlyUsd })
      await load()
      return true
    } catch (e) {
      setError(errText(e.message))
      return false
    } finally {
      setBusy(false)
    }
  }

  const addRule = async () => {
    const principal = newRule.principal.trim()
    if (!principal || newRule.monthlyUsd === '') return
    if (await putRule(inferKind(principal), principal, Number(newRule.monthlyUsd))) setNewRule({ principal: '', monthlyUsd: '' })
  }

  const removeRule = async (r) => {
    setBusy(true)
    try {
      await del(`/api/admin/budgets/rules/${r.kind}/${encodeURIComponent(r.principal)}`)
      await load()
    } catch (e) {
      setError(errText(e.message))
    } finally {
      setBusy(false)
    }
  }

  const sourceLabel = (b) =>
    !b ? '—' : b.source.kind === 'default' ? t('budgets.source.default') : b.source.principal
  const resets = usage?.month
    ? new Date(usage.month.resetsAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: usage.month.timezone })
    : ''
  const field =
    'mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-50'

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.Gauge size={16} /> {t('settings.tab.budgets')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5 leading-relaxed">{t('budgets.subtitle')}</p>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* ---- settings ---- */}
      <div className="rounded-xl border border-[var(--border)] p-4 space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
            className="accent-[var(--accent)] w-4 h-4"
          />
          <span className="text-sm font-semibold">{t('budgets.enable')}</span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-[var(--muted)]">{t('budgets.default')}</label>
            <input
              type="number" min="0" step="1" inputMode="decimal"
              value={draft.defaultUsd}
              onChange={(e) => setDraft((d) => ({ ...d, defaultUsd: e.target.value }))}
              placeholder="200"
              className={`${field} ${needsDefault ? 'border-red-400/70' : ''}`}
            />
            <p className={`text-[10.5px] mt-1 leading-relaxed ${needsDefault ? 'text-red-400' : 'text-[var(--faint)]'}`}>
              {needsDefault ? t('budgets.error.default_required') : t('budgets.defaultHint')}
            </p>
          </div>
          <div>
            <label className="text-[11px] text-[var(--muted)]">{t('budgets.timezone')}</label>
            <select value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))} className={field}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <p className="text-[10.5px] mt-1 text-[var(--faint)] leading-relaxed">{t('budgets.timezoneHint')}</p>
          </div>
        </div>

        <div>
          <div className="text-[11px] text-[var(--muted)] mb-1.5">{t('budgets.enforcement')}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {['warn', 'block'].map((mode) => (
              <button
                key={mode}
                onClick={() => setDraft((d) => ({ ...d, enforcement: mode }))}
                className={`text-left rounded-lg border px-3 py-2 transition ${
                  draft.enforcement === mode
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]/40'
                    : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <div className="text-sm font-medium">{t(`budgets.mode.${mode}`)}</div>
                <div className="text-[11px] text-[var(--faint)] leading-relaxed">{t(`budgets.mode.${mode}.hint`)}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="max-w-[220px]">
          <label className="text-[11px] text-[var(--muted)]">{t('budgets.warnPct')}</label>
          <input
            type="number" min="1" max="99" step="1"
            value={draft.warnPct}
            onChange={(e) => setDraft((d) => ({ ...d, warnPct: e.target.value }))}
            className={field}
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-[11px] text-[var(--accent)]">{t('budgets.saved')}</span>}
          <button
            onClick={saveSettings}
            disabled={!dirty || busy || needsDefault}
            className="rounded-lg bg-[var(--accent)] hover:brightness-110 disabled:opacity-40 text-white text-xs font-semibold px-3 py-2 transition"
          >
            {t('budgets.save')}
          </button>
        </div>
      </div>

      {/* ---- overrides ---- */}
      <div className="space-y-2">
        <div>
          <div className="text-sm font-semibold">{t('budgets.rules.title')}</div>
          <p className="text-[11px] text-[var(--muted)] leading-relaxed">{t('budgets.rules.subtitle')}</p>
        </div>
        {config.groupCheck === 'unavailable' && config.rules.some((r) => r.kind === 'group') && (
          <p className="text-[11px] text-amber-400 leading-relaxed">{t('budgets.groupCheckWarning')}</p>
        )}
        {config.rules.length === 0 && <p className="text-xs text-[var(--faint)] py-2">{t('budgets.rules.empty')}</p>}
        {config.rules.map((r) => {
          const key = `${r.kind}:${r.principal}`
          const value = ruleEdits[key] ?? String(r.monthlyUsd)
          return (
            <div key={key} className="flex items-center gap-2 text-xs rounded-lg border border-[var(--border)] px-3 py-1.5">
              {r.kind === 'group' ? (
                <Icon.Users size={13} className="shrink-0 text-[var(--muted)]" />
              ) : (
                <Icon.User size={13} className="shrink-0 text-[var(--muted)]" />
              )}
              <span className="flex-1 truncate font-medium">{r.principal}</span>
              <span className="text-[var(--faint)]">US$</span>
              <input
                type="number" min="0" step="1"
                value={value}
                onChange={(e) => setRuleEdits((m) => ({ ...m, [key]: e.target.value }))}
                onBlur={async () => {
                  if (ruleEdits[key] == null || Number(ruleEdits[key]) === r.monthlyUsd) return
                  await putRule(r.kind, r.principal, Number(ruleEdits[key]))
                  setRuleEdits((m) => ({ ...m, [key]: undefined }))
                }}
                className="w-24 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-right outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => removeRule(r)}
                disabled={busy}
                className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                title={t('budgets.rules.remove')}
              >
                <Icon.Trash size={12} />
              </button>
            </div>
          )
        })}

        <div className="flex items-start gap-2">
          <div className="relative flex-1 min-w-0">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]">
              {newRule.principal.trim() && inferKind(newRule.principal) === 'group' ? <Icon.Users size={13} /> : <Icon.User size={13} />}
            </span>
            <input
              list="budget-principals"
              value={newRule.principal}
              onChange={(e) => setNewRule((n) => ({ ...n, principal: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && addRule()}
              placeholder={t('budgets.rules.principalPlaceholder')}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
            />
            <datalist id="budget-principals">
              {candidates.map((c) => (
                <option key={`${c.kind}:${c.principal}`} value={c.principal}>
                  {c.display || c.principal}
                </option>
              ))}
            </datalist>
          </div>
          <input
            type="number" min="0" step="1"
            value={newRule.monthlyUsd}
            onChange={(e) => setNewRule((n) => ({ ...n, monthlyUsd: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && addRule()}
            placeholder="US$"
            className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={addRule}
            disabled={!newRule.principal.trim() || newRule.monthlyUsd === '' || busy}
            className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 disabled:opacity-40 text-xs font-semibold px-3 py-2"
          >
            {t('budgets.rules.add')}
          </button>
        </div>
      </div>

      {/* ---- month-to-date usage ---- */}
      <div className="space-y-2">
        <div>
          <div className="text-sm font-semibold">{t('budgets.usage.title')}</div>
          <p className="text-[11px] text-[var(--muted)] leading-relaxed">{t('budgets.usage.subtitle', { date: resets })}</p>
        </div>
        {!usage?.users?.length ? (
          <p className="text-xs text-[var(--faint)] py-2">{t('budgets.usage.empty')}</p>
        ) : (
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)] text-[var(--faint)]">
                <tr>
                  <th className="text-left font-medium px-3 py-2">{t('budgets.usage.user')}</th>
                  <th className="text-right font-medium px-3 py-2">{t('budgets.usage.spent')}</th>
                  <th className="text-right font-medium px-3 py-2">{t('budgets.usage.budget')}</th>
                  <th className="text-right font-medium px-3 py-2">%</th>
                </tr>
              </thead>
              <tbody>
                {usage.users.map((u) => {
                  const pct = u.budget?.limitUsd > 0 ? (u.spentUsd / u.budget.limitUsd) * 100 : u.budget ? 100 : null
                  const tone = pct == null ? '' : pct >= 100 ? 'text-red-400' : pct >= Number(config.settings.warnPct) ? 'text-amber-400' : ''
                  return (
                    <tr key={u.email} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2 truncate max-w-[220px]">{u.email}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(u.spentUsd)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {u.budget ? usd(u.budget.limitUsd) : '—'}
                        {u.budget && (
                          <span className="block text-[10px] text-[var(--faint)]">
                            {sourceLabel(u.budget)}
                            {!u.groupsVerified && ` · ${t('budgets.usage.groupsUnverified')}`}
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${tone}`}>{pct == null ? '—' : `${Math.round(pct)}%`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
