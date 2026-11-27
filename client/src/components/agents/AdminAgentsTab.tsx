import { useCallback, useEffect, useId, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { Field, SaveStatus, Switch } from '../SettingsControls.tsx'
import { dangerBtn, ghostBtn, inputCls, primaryBtn } from '../projects/ui.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import { browserTimeZone, chipKey, diffDefinitions, errorKey, formatInstant } from './agentsLogic.ts'
import type { AdminAgentRow, AdminVersionRow, AgentDefinition, AgentSettings } from './agentsLogic.ts'
import { diffVersions } from '../../../../shared/agentVersionDiff.ts'
import { shareName, versionChipKey, versionContent } from './agentsLogic.ts'
import VersionDiffView from './VersionDiff.tsx'

// Settings → Agents (admins, only while agents are on): the approval queue and the agents setting.
// What an admin approves is exactly the version on screen: approve sends the hash the server computed for it
// (`currentHash`), so an edit made meanwhile is refused as `stale` instead of being approved unseen.

// The last approved definition of each agent this browser has seen, so a re-submitted agent can be shown as a
// diff. The server clears the approved snapshot when the owner edits, so this is the only earlier version there is.
const lastApproved = new Map<string, AgentDefinition>()
const ORDER: Record<string, number> = { pending: 0, approved: 1, draft: 2, rejected: 3, revoked: 4 }

interface Props {
  open?: boolean
  onSettingsChanged?: () => void
}

export default function AdminAgentsTab({ open = true, onSettingsChanged }: Props) {
  const { t } = useI18n()
  const titleId = useId()
  const [rows, setRows] = useState<AdminAgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await agentsApi.admin.list()
      // remember each approved version (a pending row is diffed against the one seen before it was edited)
      for (const a of r.agents) if (a.status === 'approved') lastApproved.set(a.id, a.definition)
      setRows([...r.agents].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name)))
      setError(null)
    } catch (e) {
      setError(e instanceof AgentsApiError ? e.code : 'internal_error')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const replace = (row: AdminAgentRow) => {
    if (row.status === 'approved') lastApproved.set(row.id, row.definition)
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...row, toolIdentities: row.toolIdentities ?? r.toolIdentities } : r)))
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby={titleId} className="space-y-3">
        <div>
          <h3 id={titleId} className="text-title font-semibold text-[var(--text)]">
            {t('agents.admin.title')}
          </h3>
          <p className="text-label text-[var(--muted)] mt-0.5">{t('agents.admin.intro')}</p>
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-control border border-[var(--border)] bg-[var(--danger-soft)] px-3 py-2.5">
            <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" aria-hidden />
            <p className="min-w-0 flex-1 text-body text-[var(--text)]">{t(errorKey(error))}</p>
            <button type="button" className={ghostBtn} onClick={() => void load()}>
              {t('agents.retry')}
            </button>
          </div>
        )}
        {loading && rows.length === 0 ? (
          <div role="status" aria-label={t('agents.admin.loading')} aria-busy="true" className="space-y-2">
            <Skeleton className="h-24 w-full" rounded="rounded-card" />
          </div>
        ) : rows.length === 0 && !error ? (
          <p className="text-body text-[var(--muted)]">{t('agents.admin.empty')}</p>
        ) : (
          rows.map((r) => <ReviewCard key={r.id} row={r} onChanged={replace} onStale={() => void load()} />)
        )}
      </section>
      <VersionsSection open={open} />
      <SettingsCard open={open} onChanged={onSettingsChanged} />
    </div>
  )
}

// Versions: each saved version of an agent is approved on its own, for sharing. The current version of an agent that is itself
// waiting is decided on that agent's card above (one decision covers both), so it is not listed twice here.
function VersionsSection({ open }: { open: boolean }) {
  const { t } = useI18n()
  const titleId = useId()
  const [rows, setRows] = useState<AdminVersionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await agentsApi.admin.versions()
      setRows(r.versions.filter((v) => (v.status === 'pending' || v.status === 'approved') && !(v.isHead && v.agentStatus === 'pending')))
      setError(null)
    } catch (e) {
      setError(e instanceof AgentsApiError ? e.code : 'internal_error')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const ordered = [...rows].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt))
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div>
        <h3 id={titleId} className="text-title font-semibold text-[var(--text)]">
          {t('agents.admin.versions.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('agents.admin.versions.intro')}</p>
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-control border border-[var(--border)] bg-[var(--danger-soft)] px-3 py-2.5">
          <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" aria-hidden />
          <p className="min-w-0 flex-1 text-body text-[var(--text)]">{t(errorKey(error))}</p>
          <button type="button" className={ghostBtn} onClick={() => void load()}>
            {t('agents.retry')}
          </button>
        </div>
      )}
      {loading && rows.length === 0 ? (
        <div role="status" aria-label={t('agents.admin.loading')} aria-busy="true">
          <Skeleton className="h-24 w-full" rounded="rounded-card" />
        </div>
      ) : ordered.length === 0 && !error ? (
        <p className="text-body text-[var(--muted)]">{t('agents.admin.versions.empty')}</p>
      ) : (
        ordered.map((v) => <VersionReviewCard key={`${v.agentId}:${v.version}`} row={v} onChanged={(r) => setRows((prev) => prev.map((x) => (x.agentId === r.agentId && x.version === r.version ? { ...x, ...r, toolIdentities: r.toolIdentities ?? x.toolIdentities } : x)).filter((x) => x.status === 'pending' || x.status === 'approved'))} onStale={() => void load()} />)
      )}
    </section>
  )
}

function VersionReviewCard({ row, onChanged, onStale }: { row: AdminVersionRow; onChanged: (r: AdminVersionRow) => void; onStale: () => void }) {
  const { t } = useI18n()
  const titleId = useId()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const d = row.definition
  const diff = row.previous ? diffVersions({ name: row.previous.name, description: row.previous.description, definition: row.previous.definition as unknown as Record<string, unknown> }, versionContent(row)) : null
  const audience = row.shares.map((s) => shareName(s, t('agents.share.appName')))

  const run = async (fn: () => Promise<AdminVersionRow>) => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await fn())
    } catch (e) {
      const code = e instanceof AgentsApiError ? e.code : 'internal_error'
      setError(code)
      if (code === 'stale' || code === 'not_found' || code === 'agent_pending') onStale()
    } finally {
      setBusy(false)
    }
  }
  const reject = () => {
    if (!reason.trim()) return setError('reason_required')
    void run(() => agentsApi.admin.rejectVersion(row.agentId, row.version, reason.trim()))
  }

  return (
    <article aria-labelledby={titleId} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={titleId} className="min-w-0 flex-1 text-body font-semibold text-[var(--text)] truncate">
          {t('agents.admin.versions.label', { name: row.name, n: row.version })}
        </h4>
        <span className="inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">{t(versionChipKey(row))}</span>
      </div>
      <p className="text-label text-[var(--muted)]">{t('agents.admin.owner', { owner: row.ownerEmail })}</p>
      <p className="text-label text-[var(--muted)]">{audience.length ? t('agents.admin.versions.sharedWith', { list: audience.join(', ') }) : t('agents.admin.versions.notShared')}</p>

      <dl className="space-y-1.5 text-body">
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.prompt')}</dt>
          <dd className="whitespace-pre-wrap text-[var(--text)]">{d.prompt}</dd>
        </div>
        {d.instructions && (
          <div>
            <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.instructions')}</dt>
            <dd className="whitespace-pre-wrap text-[var(--text)]">{d.instructions}</dd>
          </div>
        )}
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.model')}</dt>
          <dd className="text-[var(--text)]">{d.model}</dd>
        </div>
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.tools')}</dt>
          <dd>
            {row.toolIdentities.length === 0 ? (
              <span className="text-[var(--muted)]">{t('agents.admin.noTools')}</span>
            ) : (
              <ul className="space-y-0.5">
                {row.toolIdentities.map((ti) => (
                  <li key={ti.tool} className="text-label text-[var(--text)]">
                    {t(ti.readsWorkspaceData ? 'agents.admin.toolReadsData' : 'agents.admin.toolRuns', { tool: ti.tool })}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <p className="flex items-start gap-1.5 text-label text-[var(--muted)]">
        <Icon.Shield size={14} className="shrink-0 mt-0.5" aria-hidden /> {t('agents.admin.versions.sharingNote')}
      </p>

      {row.status === 'pending' && (
        <div className="rounded-control bg-[var(--surface-2)] px-3 py-2 space-y-1">
          <p className="text-label font-semibold text-[var(--text)]">{row.previous ? t('agents.admin.versions.since', { n: row.previous.version }) : t('agents.admin.diff.title')}</p>
          {!diff ? <p className="text-label text-[var(--muted)]">{t('agents.admin.versions.noPrevious')}</p> : diff.isEmpty ? <p className="text-label text-[var(--muted)]">{t('agents.admin.diff.same')}</p> : <VersionDiffView diff={diff} />}
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-label text-[var(--danger)]">
          <Icon.AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden /> {t(errorKey(error))}
        </p>
      )}

      {row.status === 'pending' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run(() => agentsApi.admin.approveVersion(row.agentId, row.version, row.currentHash))}>
              {t('agents.admin.approve')}
            </button>
          </div>
          <div className="space-y-2">
            <Field label={t('agents.admin.reason')} hint={t('agents.admin.reasonHint')}>
              {(p) => <input {...p} className={inputCls} value={reason} maxLength={500} autoComplete="off" onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <button type="button" className={dangerBtn} disabled={busy} onClick={reject}>
              {t('agents.admin.reject')}
            </button>
          </div>
        </div>
      )}
      {row.status === 'approved' && (
        <div className="space-y-2">
          <Field label={t('agents.admin.reason')}>
            {(p) => <input {...p} className={inputCls} value={reason} maxLength={500} autoComplete="off" onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <button type="button" className={dangerBtn} disabled={busy} onClick={() => void run(() => agentsApi.admin.revokeVersion(row.agentId, row.version, reason.trim() || undefined))}>
            {t('agents.admin.revoke')}
          </button>
        </div>
      )}
    </article>
  )
}

function ReviewCard({ row, onChanged, onStale }: { row: AdminAgentRow; onChanged: (r: AdminAgentRow) => void; onStale: () => void }) {
  const { t, locale } = useI18n()
  const titleId = useId()
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tz = browserTimeZone()
  const d = row.definition
  const prev = lastApproved.get(row.id) ?? null
  const changes = row.status === 'pending' ? diffDefinitions(prev, d) : []

  const run = async (fn: () => Promise<AdminAgentRow>) => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await fn())
    } catch (e) {
      const code = e instanceof AgentsApiError ? e.code : 'internal_error'
      setError(code)
      if (code === 'stale' || code === 'not_found') onStale()
    } finally {
      setBusy(false)
    }
  }
  const reject = () => {
    if (!reason.trim()) return setError('reason_required')
    void run(() => agentsApi.admin.reject(row.id, reason.trim()))
  }
  const approve = () => {
    const n = days.trim() === '' ? undefined : Number(days)
    void run(() => agentsApi.admin.approve(row.id, { expectedHash: row.currentHash, ...(n !== undefined ? { days: n } : {}) }))
  }
  const sched = d.schedule
    ? `${t(`agents.schedule.${d.schedule.freq}`)} · ${String(d.schedule.hour ?? 0).padStart(2, '0')}:${String(d.schedule.minute).padStart(2, '0')} · ${d.schedule.tz}`
    : t('agents.schedule.none')

  return (
    <article aria-labelledby={titleId} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={titleId} className="min-w-0 flex-1 text-body font-semibold text-[var(--text)] truncate">
          {row.name}
        </h4>
        <span className="inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">{t(chipKey(row))}</span>
      </div>
      <p className="text-label text-[var(--muted)]">
        {t('agents.admin.owner', { owner: row.ownerEmail })}
        {row.status === 'approved' && row.approvalExpiresAt ? ` · ${t('agents.admin.expiresAt', { when: formatInstant(row.approvalExpiresAt, tz, locale) })}` : ''}
      </p>

      <dl className="space-y-1.5 text-body">
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.prompt')}</dt>
          <dd className="whitespace-pre-wrap text-[var(--text)]">{d.prompt}</dd>
        </div>
        {d.instructions && (
          <div>
            <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.instructions')}</dt>
            <dd className="whitespace-pre-wrap text-[var(--text)]">{d.instructions}</dd>
          </div>
        )}
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.model')}</dt>
          <dd className="text-[var(--text)]">{d.model}</dd>
        </div>
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.reasoningEffort')}</dt>
          <dd className="text-[var(--text)]">{t(`agents.effort.${d.reasoningEffort ?? 'default'}`)}</dd>
        </div>
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.lang')}</dt>
          <dd className="text-[var(--text)]">{t(`agents.lang.${d.lang}`)}</dd>
        </div>
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.schedule')}</dt>
          <dd className="text-[var(--text)]">{sched}</dd>
        </div>
        <div>
          <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.tools')}</dt>
          <dd>
            {row.toolIdentities.length === 0 ? (
              <span className="text-[var(--muted)]">{t('agents.admin.noTools')}</span>
            ) : (
              <ul className="space-y-0.5">
                {row.toolIdentities.map((ti) => (
                  <li key={ti.tool} className="text-label text-[var(--text)]">
                    {t(ti.readsWorkspaceData ? 'agents.admin.toolReadsData' : 'agents.admin.toolRuns', { tool: ti.tool })}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <p className="flex items-start gap-1.5 text-label text-[var(--muted)]">
        <Icon.Shield size={14} className="shrink-0 mt-0.5" aria-hidden /> {t('agents.admin.identity')}
      </p>

      {row.status === 'pending' && (
        <div className="rounded-control bg-[var(--surface-2)] px-3 py-2 space-y-1">
          <p className="text-label font-semibold text-[var(--text)]">{t('agents.admin.diff.title')}</p>
          {!prev ? (
            <p className="text-label text-[var(--muted)]">{t('agents.admin.diff.none')}</p>
          ) : changes.length === 0 ? (
            <p className="text-label text-[var(--muted)]">{t('agents.admin.diff.same')}</p>
          ) : (
            <ul className="space-y-1">
              {changes.map((c) => (
                <li key={c.field} className="text-label text-[var(--text)]">
                  <span className="font-semibold">{t(`agents.field.${c.field === 'reasoningEffort' ? 'reasoningEffort' : c.field}`)}</span>
                  {c.field === 'tools' ? (
                    <>
                      {c.added && c.added.length > 0 && <span className="block">{t('agents.admin.diff.added', { items: c.added.join(', ') })}</span>}
                      {c.removed && c.removed.length > 0 && <span className="block">{t('agents.admin.diff.removed', { items: c.removed.join(', ') })}</span>}
                    </>
                  ) : (
                    <>
                      <span className="block text-[var(--muted)]">
                        {t('agents.admin.diff.before')}: {typeof c.before === 'string' ? c.before : JSON.stringify(c.before)}
                      </span>
                      <span className="block">
                        {t('agents.admin.diff.after')}: {typeof c.after === 'string' ? c.after : JSON.stringify(c.after)}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-label text-[var(--danger)]">
          <Icon.AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden /> {t(errorKey(error))}
        </p>
      )}

      {row.status === 'pending' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Field label={t('agents.admin.approveDays')}>
              {(p) => <input {...p} type="number" inputMode="numeric" min={1} max={365} className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} />}
            </Field>
            <button type="button" className={primaryBtn} disabled={busy} onClick={approve}>
              {t('agents.admin.approve')}
            </button>
          </div>
          <div className="space-y-2">
            <Field label={t('agents.admin.reason')} hint={t('agents.admin.reasonHint')}>
              {(p) => <input {...p} className={inputCls} value={reason} maxLength={500} autoComplete="off" onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <button type="button" className={dangerBtn} disabled={busy} onClick={reject}>
              {t('agents.admin.reject')}
            </button>
          </div>
        </div>
      )}
      {row.status === 'approved' && (
        <div className="space-y-2">
          <Field label={t('agents.admin.reason')}>
            {(p) => <input {...p} className={inputCls} value={reason} maxLength={500} autoComplete="off" onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <button type="button" className={dangerBtn} disabled={busy} onClick={() => void run(() => agentsApi.admin.revoke(row.id, reason.trim() || undefined))}>
            {t('agents.admin.revoke')}
          </button>
        </div>
      )}
    </article>
  )
}

function SettingsCard({ open, onChanged }: { open: boolean; onChanged?: (() => void) | undefined }) {
  const { t } = useI18n()
  const titleId = useId()
  const enabledId = useId()
  const [s, setS] = useState<AgentSettings | null>(null)
  const [cost, setCost] = useState('')
  const [days, setDays] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void agentsApi.admin
      .settings()
      .then((v) => {
        setS(v)
        setCost(String(v.maxRunCostUsd))
        setDays(String(v.approvalDays))
      })
      .catch((e) => setError(e instanceof AgentsApiError ? e.code : 'internal_error'))
  }, [open])

  const save = async (patch: Partial<Pick<AgentSettings, 'enabled' | 'maxRunCostUsd' | 'approvalDays'>>) => {
    setState('saving')
    setError(null)
    try {
      const v = await agentsApi.admin.saveSettings(patch)
      setS(v)
      setCost(String(v.maxRunCostUsd))
      setDays(String(v.approvalDays))
      setState('saved')
      onChanged?.()
    } catch (e) {
      setError(e instanceof AgentsApiError ? e.code : 'internal_error')
      setState('error')
    }
  }
  const r = s?.ranges

  return (
    <section aria-labelledby={titleId} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <h3 id={titleId} className="text-title font-semibold text-[var(--text)]">
        {t('agents.admin.settings.title')}
      </h3>
      {s && (
        <>
          <div className="flex items-start gap-3">
            <Switch checked={s.enabled} labelledBy={enabledId} onChange={(v) => void save({ enabled: v })} />
            <div>
              <p id={enabledId} className="text-body font-medium text-[var(--text)]">
                {t('agents.admin.settings.enabled')}
              </p>
              <p className="text-caption text-[var(--muted)]">{t('agents.admin.settings.enabledHint')}</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('agents.admin.settings.maxRunCostUsd')} hint={r ? t('agents.admin.settings.range', { min: r.maxRunCostUsd[0], max: r.maxRunCostUsd[1] }) : undefined}>
              {(p) => <input {...p} type="number" inputMode="decimal" step="0.05" className={inputCls} value={cost} onChange={(e) => setCost(e.target.value)} />}
            </Field>
            <Field label={t('agents.admin.settings.approvalDays')} hint={r ? t('agents.admin.settings.range', { min: r.approvalDays[0], max: r.approvalDays[1] }) : undefined}>
              {(p) => <input {...p} type="number" inputMode="numeric" className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} />}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primaryBtn} disabled={state === 'saving'} onClick={() => void save({ maxRunCostUsd: Number(cost), approvalDays: Number(days) })}>
              {state === 'saving' ? t('agents.admin.settings.saving') : t('agents.admin.settings.save')}
            </button>
            <SaveStatus state={state} error={error ? t(errorKey(error)) : undefined} />
          </div>
        </>
      )}
      {!s && error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {t(errorKey(error))}
        </p>
      )}
    </section>
  )
}
