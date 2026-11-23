import { useCallback, useEffect, useId, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { ConfirmDialog, dangerBtn, ghostBtn, primaryBtn } from '../projects/ui.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import { browserTimeZone, chipKey, errorKey, formatInstant, rowActions } from './agentsLogic.ts'
import type { AgentLimits, AgentRow, ToolOptions } from './agentsLogic.ts'
import AgentEditor from './AgentEditor.tsx'
import AgentRunHistory from './AgentRunHistory.tsx'

// #/agents: the owner's scheduled agents. The page is the app's <main> (it replaces the chat column, like History).
// It is only mounted while GET /api/agents/status says the feature is on (Shell).

interface ModelOption {
  id: string
  label: string
  reasoning?: { levels?: string[]; [k: string]: unknown } | boolean | null
}
interface Props {
  models: ModelOption[]
  defaultModel: string
  uiLang: string
  isAdmin: boolean
  onOpenChat: (sessionId: string) => void
  onTryInChat: (draft: { instructions: string; prompt: string }) => void
  onBack: () => void
  onOpenMenu: () => void
}

type Editing = null | 'new' | AgentRow

export default function AgentsPanel({ models, defaultModel, uiLang, onOpenChat, onTryInChat, onBack, onOpenMenu }: Props) {
  const { t, locale } = useI18n()
  const titleId = useId()
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [limits, setLimits] = useState<AgentLimits | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [queued, setQueued] = useState<Record<string, boolean>>({})
  const [deleting, setDeleting] = useState<AgentRow | null>(null)
  const [tools, setTools] = useState<{ options: ToolOptions | null; failed: boolean }>({ options: null, failed: false })
  const tz = browserTimeZone()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await agentsApi.list()
      setAgents(r.agents)
      setLimits(r.limits)
      setError(null)
    } catch (e) {
      setError(e instanceof AgentsApiError ? e.code : 'internal_error')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    // every owner gets the same list from the server; a failed load offers no tools (fail closed) and says so
    void agentsApi.toolOptions().then((options) => setTools({ options, failed: false }), () => setTools({ options: null, failed: true }))
  }, [load])

  const replace = (row: AgentRow) => setAgents((prev) => prev.map((a) => (a.id === row.id ? row : a)))
  // one action on a row: busy while it runs, its error shown by code, the row replaced by the server's answer
  const act = async (a: AgentRow, fn: () => Promise<AgentRow | void>, after?: () => void) => {
    setBusy(a.id)
    setError(null)
    try {
      const row = await fn()
      if (row) replace(row)
      after?.()
    } catch (e) {
      const code = e instanceof AgentsApiError ? e.code : 'internal_error'
      setError(code)
      // a refusal usually means the row moved (approval expired, deleted elsewhere): show the truth, keep the reason
      if (['not_found', 'conflict', 'bad_state', 'not_approved', 'approval_expired'].includes(code)) void load().then(() => setError(code))
    } finally {
      setBusy(null)
    }
  }

  const atLimit = !!limits && agents.length >= limits.agentsPerOwner
  const now = Date.now()

  return (
    <main aria-labelledby={titleId} className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      <header className="shrink-0 min-h-14 flex items-center gap-2 px-2 md:px-5 border-b border-[var(--border)]">
        <button type="button" onClick={onOpenMenu} className="md:hidden grid place-items-center min-w-11 min-h-11 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)]" aria-label={t('shell.openMenu')} title={t('shell.openMenu')}>
          <Icon.Menu size={20} />
        </button>
        <button type="button" onClick={onBack} className={`${ghostBtn} border-transparent bg-transparent`}>
          <Icon.ChevronLeft size={16} /> {t('agents.back')}
        </button>
      </header>
      <div className="w-full max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 id={titleId} className="text-heading font-bold text-[var(--text)]">
              {t('agents.title')}
            </h1>
            <p className="text-body text-[var(--muted)]">{t('agents.intro')}</p>
            <p className="text-label text-[var(--muted)] mt-1">{t('agents.runsAsNote')}</p>
          </div>
          {!editing && (
            <button type="button" className={`${primaryBtn} shrink-0`} disabled={atLimit || loading} onClick={() => setEditing('new')}>
              <Icon.Plus size={16} /> {t('agents.new')}
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-control border border-[var(--border)] bg-[var(--danger-soft)] px-3 py-2.5">
            <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" aria-hidden />
            <p className="min-w-0 flex-1 text-body text-[var(--text)]">{t(errorKey(error))}</p>
            <button type="button" onClick={() => void load()} className={ghostBtn}>
              {t('agents.retry')}
            </button>
          </div>
        )}
        {atLimit && !editing && limits && <p className="text-label text-[var(--muted)]">{t('agents.limitReached', { max: limits.agentsPerOwner })}</p>}

        {editing ? (
          <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 md:p-5">
            <AgentEditor
              agent={editing === 'new' ? null : editing}
              models={models}
              defaultModel={defaultModel}
              uiLang={uiLang}
              toolOptions={tools.options}
              toolsFailed={tools.failed}
              limits={limits}
              onSaved={(row) => {
                setEditing(null)
                setError(null)
                setAgents((prev) => (prev.some((a) => a.id === row.id) ? prev.map((a) => (a.id === row.id ? row : a)) : [...prev, row]))
              }}
              onCancel={() => setEditing(null)}
              onTryInChat={onTryInChat}
            />
          </div>
        ) : loading && agents.length === 0 ? (
          <div role="status" aria-label={t('agents.loading')} aria-busy="true" className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" rounded="rounded-card" />
            ))}
          </div>
        ) : agents.length === 0 && !error ? (
          <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center">
            <p className="text-body font-medium text-[var(--text)]">{t('agents.empty')}</p>
            <p className="mt-1 text-label text-[var(--muted)]">{t('agents.emptyHint')}</p>
          </div>
        ) : (
          <ul aria-label={t('agents.list.label')} className="space-y-3">
            {agents.map((a) => {
              const can = rowActions(a, now)
              const disabled = busy === a.id
              const name = a.name || t('agents.unnamed')
              const label = (key: string) => t('agents.action.aria', { action: t(key), name })
              return (
                <li key={a.id} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="min-w-0 flex-1 text-body font-semibold text-[var(--text)] truncate">{name}</h2>
                    <span className="inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">{t(chipKey(a))}</span>
                  </div>
                  {a.description && <p className="text-label text-[var(--muted)]">{a.description}</p>}
                  <ul className="text-label text-[var(--muted)] space-y-0.5">
                    {!a.definition.schedule && <li>{t('agents.row.noSchedule')}</li>}
                    {a.enabled && a.nextRunAt && <li>{t('agents.row.nextRun', { when: formatInstant(a.nextRunAt, tz, locale) })}</li>}
                    {a.lastRunAt && <li>{t('agents.row.lastRun', { when: formatInstant(a.lastRunAt, tz, locale) })}</li>}
                    {a.status === 'approved' && a.approvalExpiresAt && (can.run ? <li>{t('agents.row.expires', { when: formatInstant(a.approvalExpiresAt, tz, locale) })}</li> : <li>{t('agents.row.expired')}</li>)}
                    {a.decisionReason && (a.status === 'rejected' || a.status === 'revoked') && <li>{t('agents.row.reason', { reason: a.decisionReason })}</li>}
                    {a.disabledReason && !a.enabled && <li>{t('agents.row.disabledReason', { reason: t(errorKey(a.disabledReason)) })}</li>}
                  </ul>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {can.submit && (
                      <button type="button" className={primaryBtn} disabled={disabled} aria-label={label('agents.action.submit')} onClick={() => void act(a, () => agentsApi.submit(a.id))}>
                        {t('agents.action.submit')}
                      </button>
                    )}
                    {can.enable && (
                      <button type="button" className={primaryBtn} disabled={disabled} aria-label={label('agents.action.enable')} onClick={() => void act(a, () => agentsApi.enable(a.id))}>
                        {t('agents.action.enable')}
                      </button>
                    )}
                    {can.disable && (
                      <button type="button" className={ghostBtn} disabled={disabled} aria-label={label('agents.action.disable')} onClick={() => void act(a, () => agentsApi.disable(a.id))}>
                        {t('agents.action.disable')}
                      </button>
                    )}
                    {can.run && (
                      <button
                        type="button"
                        className={ghostBtn}
                        disabled={disabled}
                        aria-label={label('agents.action.run')}
                        onClick={() => void act(a, async () => void (await agentsApi.run(a.id)), () => setQueued((q) => ({ ...q, [a.id]: true })))}
                      >
                        <Icon.Play size={14} aria-hidden /> {t('agents.action.run')}
                      </button>
                    )}
                    <button type="button" className={ghostBtn} aria-label={label('agents.action.history')} aria-expanded={historyFor === a.id} onClick={() => setHistoryFor(historyFor === a.id ? null : a.id)}>
                      {t('agents.action.history')}
                    </button>
                    <button type="button" className={ghostBtn} disabled={disabled} aria-label={label('agents.action.edit')} onClick={() => setEditing(a)}>
                      <Icon.Pencil size={14} aria-hidden /> {t('agents.action.edit')}
                    </button>
                    <button type="button" className={`${dangerBtn} sm:ml-auto`} disabled={disabled} aria-label={label('agents.action.delete')} onClick={() => setDeleting(a)}>
                      <Icon.Trash size={14} aria-hidden /> {t('agents.action.delete')}
                    </button>
                  </div>
                  {queued[a.id] && (
                    <p role="status" className="text-label text-[var(--success)]">
                      {t('agents.run.queued')}
                    </p>
                  )}
                  {historyFor === a.id && <AgentRunHistory agentId={a.id} agentName={name} onOpenChat={onOpenChat} onClose={() => setHistoryFor(null)} />}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('agents.delete.title', { name: deleting.name })}
          body={t('agents.delete.body')}
          confirmLabel={t('agents.delete.confirm')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting
            setDeleting(null)
            void act(target, async () => {
              await agentsApi.remove(target.id)
              setAgents((prev) => prev.filter((x) => x.id !== target.id))
            })
          }}
        />
      )}
    </main>
  )
}
