import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { Field } from '../SettingsControls.tsx'
import { ConfirmDialog, ghostBtn, iconBtn, inputCls, primaryBtn, selectCls } from '../projects/ui.tsx'
import { diffVersions } from '../../../../shared/agentVersionDiff.ts'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import { browserTimeZone, canSubmitVersion, errorKey, formatInstant, previousVersion, shareName, shareState, versionChipKey, versionContent } from './agentsLogic.ts'
import type { AgentLimits, AgentRow, AgentShare, AgentVersion, ShareKind } from './agentsLogic.ts'
import VersionDiffView from './VersionDiff.tsx'

// The history of one agent: every save as an immutable version, what changed in each, restore (saves an old version again as
// the newest), duplicate, the sharing approval of a version and who it is shared with. Rendered inside the agent's card in
// #/agents. Nothing here decides anything: the server owns the numbers, the approval and who may read a version.
const PAGE = 100

interface Props {
  agent: AgentRow
  limits: AgentLimits | null
  onClose: () => void
  /** the agent after a restore (a new version, maybe a draft again) */
  onAgentChanged: (row: AgentRow) => void
  /** a duplicate: the new draft agent */
  onCreated: (row: AgentRow) => void
}

export default function AgentVersionsPanel({ agent, limits, onClose, onAgentChanged, onCreated }: Props) {
  const { t, locale } = useI18n()
  const titleId = useId()
  const [versions, setVersions] = useState<AgentVersion[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null)
  const tz = browserTimeZone()

  const fail = (e: unknown) => setError(e instanceof AgentsApiError ? e.code : 'internal_error')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await agentsApi.versions(agent.id, { limit: PAGE })
      setVersions(r.versions)
      setHasMore(r.hasMore)
      setError(null)
      setSelected((cur) => (cur !== null && r.versions.some((v) => v.version === cur) ? cur : (r.versions[0]?.version ?? null)))
    } catch (e) {
      fail(e)
    } finally {
      setLoading(false)
    }
  }, [agent.id])
  // reloaded when the agent moves to a newer revision (a save or a restore elsewhere on the page)
  useEffect(() => {
    void load()
  }, [load, agent.revision])

  const loadOlder = async () => {
    const last = versions[versions.length - 1]
    if (!last) return
    setBusy(true)
    try {
      const r = await agentsApi.versions(agent.id, { before: last.version, limit: PAGE })
      setVersions((cur) => [...cur, ...r.versions])
      setHasMore(r.hasMore)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const sel = versions.find((v) => v.version === selected) ?? null
  const prev = sel ? previousVersion(versions, sel, hasMore) : null
  const diff = useMemo(() => (sel && prev ? diffVersions(versionContent(prev), versionContent(sel)) : null), [sel, prev])
  const allShares: AgentShare[] = useMemo(() => versions.flatMap((v) => v.shares), [versions])

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const done = await fn()
      if (done) setNote(done)
    } catch (e) {
      fail(e)
      if (e instanceof AgentsApiError && (e.code === 'conflict' || e.code === 'not_found')) void load()
    } finally {
      setBusy(false)
    }
  }

  const restore = (v: AgentVersion) =>
    run(async () => {
      const before = agent.revision
      const row = await agentsApi.restore(agent.id, v.version)
      onAgentChanged(row) // a new revision reloads the history (the effect above)
      return row.revision === before ? t('agents.versions.restore.same') : t('agents.versions.restore.done', { from: v.version, to: row.revision })
    })
  // an approved or waiting agent whose content would change goes back to draft: say so first (the same rule as saving an edit)
  const restoreNeedsConfirm = (v: AgentVersion) => (agent.status === 'approved' || agent.status === 'pending') && JSON.stringify(v.definition) !== JSON.stringify(agent.definition)

  const duplicate = (v: AgentVersion) =>
    run(async () => {
      const row = await agentsApi.duplicate(agent.id, { version: v.version, name: t('agents.versions.copyName', { name: v.name }).slice(0, limits?.nameMax ?? 80) })
      onCreated(row)
      return t('agents.versions.duplicate.done', { name: row.name })
    })

  const submit = (v: AgentVersion) =>
    run(async () => {
      await agentsApi.submitVersion(agent.id, v.version)
      await load()
      return t('agents.versions.submit.done', { n: v.version })
    })

  return (
    <section aria-labelledby={titleId} className="rounded-control border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-label font-semibold text-[var(--text)]">
            {t('agents.versions.forAgent', { name: agent.name })}
          </h3>
          <p className="text-caption text-[var(--muted)]">{t('agents.versions.intro')}</p>
        </div>
        <button type="button" onClick={onClose} className={ghostBtn}>
          {t('agents.versions.close')}
        </button>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-label text-[var(--danger)]">
          <Icon.AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden /> {t(errorKey(error))}
        </p>
      )}
      {note && (
        <p role="status" className="text-label text-[var(--success)]">
          {note}
        </p>
      )}

      {loading && versions.length === 0 ? (
        <div role="status" aria-label={t('agents.versions.loading')} aria-busy="true" className="space-y-2">
          <Skeleton className="h-10 w-full" rounded="rounded-control" />
          <Skeleton className="h-10 w-full" rounded="rounded-control" />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <ul aria-label={t('agents.versions.list.label')} className="space-y-1 md:max-h-96 md:overflow-y-auto">
            {versions.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  aria-current={v.version === selected ? 'true' : undefined}
                  onClick={() => {
                    setSelected(v.version)
                    setNote(null)
                  }}
                  className={`w-full text-left rounded-control border px-2.5 py-2 min-h-11 transition-colors duration-fast ${v.version === selected ? 'border-[var(--accent)] bg-[var(--surface)]' : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-3)]'}`}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-label font-semibold text-[var(--text)]">{t('agents.versions.versionN', { n: v.version })}</span>
                    {v.isHead && <span className="rounded-badge bg-[var(--accent-soft)] px-1.5 py-0.5 text-caption font-semibold text-[var(--text)]">{t('agents.versions.current')}</span>}
                    <span className="rounded-badge bg-[var(--surface-3)] px-1.5 py-0.5 text-caption font-semibold text-[var(--muted)]">{t(versionChipKey(v))}</span>
                  </span>
                  <span className="block text-caption text-[var(--muted)]">{t('agents.versions.saved', { when: formatInstant(v.createdAt, tz, locale) })}</span>
                  {v.origin && <span className="block text-caption text-[var(--muted)]">{t(`agents.versions.origin.${v.origin.kind}`, { n: v.origin.version })}</span>}
                  {v.shares.length > 0 && <span className="block text-caption text-[var(--muted)]">{t('agents.versions.sharedCount', { n: v.shares.length })}</span>}
                </button>
              </li>
            ))}
            {hasMore && (
              <li>
                <button type="button" className={`${ghostBtn} w-full`} disabled={busy} onClick={() => void loadOlder()}>
                  {t('agents.versions.loadOlder')}
                </button>
              </li>
            )}
          </ul>

          {sel && (
            <div className="min-w-0 space-y-3" aria-label={t('agents.versions.detail.label', { n: sel.version })}>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={ghostBtn}
                  disabled={busy || sel.isHead}
                  onClick={() => (restoreNeedsConfirm(sel) ? setConfirmRestore(sel.version) : void restore(sel))}
                >
                  <Icon.History size={14} aria-hidden /> {t('agents.versions.restore')}
                </button>
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void duplicate(sel)}>
                  <Icon.Copy size={14} aria-hidden /> {t('agents.versions.duplicate')}
                </button>
                {canSubmitVersion(sel) && !(sel.isHead && agent.status === 'pending') && (
                  <button type="button" className={primaryBtn} disabled={busy} onClick={() => void submit(sel)}>
                    {t('agents.versions.submit')}
                  </button>
                )}
              </div>
              {sel.decisionReason && (sel.status === 'rejected' || sel.status === 'revoked') && <p className="text-label text-[var(--muted)]">{t('agents.versions.reason', { reason: sel.decisionReason })}</p>}

              <div className="space-y-1">
                {prev && <p className="text-label font-semibold text-[var(--text)]">{t('agents.versions.diff.title', { n: prev.version })}</p>}
                {prev === null ? (
                  <p className="text-label text-[var(--muted)]">{t('agents.versions.diff.first')}</p>
                ) : prev === undefined ? (
                  <p className="text-label text-[var(--muted)]">{t('agents.versions.diff.needsOlder')}</p>
                ) : diff && diff.isEmpty ? (
                  <p className="text-label text-[var(--muted)]">{t('agents.versions.diff.same', { n: prev.version })}</p>
                ) : (
                  diff && <VersionDiffView diff={diff} />
                )}
              </div>

              <details className="text-label">
                <summary className="cursor-pointer font-semibold text-[var(--text)] min-h-8">{t('agents.versions.preview')}</summary>
                <dl className="mt-1.5 space-y-1.5">
                  <div>
                    <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.prompt')}</dt>
                    <dd className="whitespace-pre-wrap text-[var(--text)]">{sel.definition.prompt}</dd>
                  </div>
                  {sel.definition.instructions && (
                    <div>
                      <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.instructions')}</dt>
                      <dd className="whitespace-pre-wrap text-[var(--text)]">{sel.definition.instructions}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.model')}</dt>
                    <dd className="text-[var(--text)]">{sel.definition.model}</dd>
                  </div>
                  <div>
                    <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.tools')}</dt>
                    <dd className="text-[var(--text)]">{sel.definition.tools.length ? sel.definition.tools.join(', ') : t('agents.versions.diff.empty')}</dd>
                  </div>
                </dl>
              </details>

              <SharingEditor agentId={agent.id} version={sel} versions={versions} allShares={allShares} limits={limits} busy={busy} setBusy={setBusy} onChanged={(msg) => load().then(() => setNote(msg))} onError={fail} />
            </div>
          )}
        </div>
      )}

      {confirmRestore !== null && (
        <ConfirmDialog
          title={t('agents.versions.restore.title', { n: confirmRestore })}
          body={t('agents.versions.restore.body', { n: confirmRestore })}
          confirmLabel={t('agents.versions.restore.confirm')}
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => {
            const v = versions.find((x) => x.version === confirmRestore)
            setConfirmRestore(null)
            if (v) void restore(v)
          }}
        />
      )}
    </section>
  )
}

interface SharingProps {
  agentId: string
  version: AgentVersion
  versions: AgentVersion[]
  allShares: AgentShare[]
  limits: AgentLimits | null
  busy: boolean
  setBusy: (b: boolean) => void
  onChanged: (note: string) => void
  onError: (e: unknown) => void
}

function SharingEditor({ agentId, version, versions, allShares, limits, busy, setBusy, onChanged, onError }: SharingProps) {
  const { t } = useI18n()
  const titleId = useId()
  const [kind, setKind] = useState<ShareKind>('user')
  const [principal, setPrincipal] = useState('')
  const appName = t('agents.share.appName')
  const atLimit = !!limits && allShares.length >= limits.sharesPerAgent

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const p = principal.trim()
    if (kind !== 'app' && !p) return onError(new AgentsApiError(400, 'invalid_principal'))
    setBusy(true)
    try {
      const s = await agentsApi.share(agentId, { version: version.version, kind, ...(kind === 'app' ? {} : { principal: p }) })
      setPrincipal('')
      onChanged(t('agents.share.added', { name: shareName(s, appName) }))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (s: AgentShare) => {
    setBusy(true)
    try {
      await agentsApi.unshare(agentId, s)
      onChanged(t('agents.share.removed', { name: shareName(s, appName) }))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div aria-labelledby={titleId} role="group" className="space-y-2 border-t border-[var(--border)] pt-3">
      <h4 id={titleId} className="text-label font-semibold text-[var(--text)]">
        {t('agents.share.title')}
      </h4>
      <p className="text-caption text-[var(--muted)]">{t('agents.share.hint')}</p>
      {allShares.length === 0 ? (
        <p className="text-label text-[var(--muted)]">{t('agents.share.none')}</p>
      ) : (
        <ul aria-label={t('agents.share.list.label')} className="divide-y divide-[var(--border)]">
          {allShares.map((s) => {
            const live = shareState(s, versions) === 'live'
            const name = shareName(s, appName)
            return (
              <li key={`${s.kind}:${s.principal}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                {s.kind === 'group' ? <Icon.Users size={16} className="shrink-0 text-[var(--muted)]" aria-hidden /> : s.kind === 'app' ? <Icon.Globe2 size={16} className="shrink-0 text-[var(--muted)]" aria-hidden /> : <Icon.User size={16} className="shrink-0 text-[var(--muted)]" aria-hidden />}
                <div className="min-w-0 flex-1 basis-40">
                  <p className="text-label text-[var(--text)] truncate" title={name}>
                    {name}
                  </p>
                  <p className="text-caption text-[var(--muted)]">
                    {t(`agents.share.kind.${s.kind}`)} · {t('agents.share.pinned', { n: s.version })} · {live ? t('agents.share.active') : t('agents.share.waiting', { n: s.version })}
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={() => void remove(s)} className={`${iconBtn} hover:text-[var(--danger)]`} aria-label={t('agents.share.remove', { name })} title={t('agents.share.remove', { name })}>
                  <Icon.Trash size={15} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {version.status !== 'approved' && <p className="text-caption text-[var(--muted)]">{t('agents.share.needApproval')}</p>}
      <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-2">
        <Field label={t('agents.share.kind')}>
          {(p) => (
            <select {...p} className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as ShareKind)}>
              {(['user', 'group', 'app'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`agents.share.kind.${k}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {kind !== 'app' && (
          <Field label={t(`agents.share.principal.${kind}`)} className="min-w-0 flex-1 basis-48">
            {(p) => <input {...p} className={inputCls} value={principal} maxLength={256} autoComplete="off" onChange={(e) => setPrincipal(e.target.value)} />}
          </Field>
        )}
        <button type="submit" className={primaryBtn} disabled={busy || atLimit}>
          {t('agents.share.add', { n: version.version })}
        </button>
      </form>
      {atLimit && limits && <p className="text-caption text-[var(--muted)]">{t('agents.share.limit', { max: limits.sharesPerAgent })}</p>}
    </div>
  )
}
