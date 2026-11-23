import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { ProviderMark } from '../ProviderMark.tsx'
import { ConfirmDialog, ghostBtn, inputCls, primaryBtn } from '../projects/ui.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import { AGENT_FILTERS, browserTimeZone, chipKey, errorKey, filterAgents, filterCounts, formatInstant } from './agentsLogic.ts'
import type { AgentFilter, AgentLimits, AgentRow, ToolOptions } from './agentsLogic.ts'
import AgentEditor from './AgentEditor.tsx'
import AgentDrawer from './AgentDrawer.tsx'

// #/agents: the owner's scheduled agents. The page is the app's <main> (it replaces the chat column, like History).
// It is only mounted while GET /api/agents/status says the feature is on (Shell).

interface ModelOption {
  id: string
  label: string
  provider?: string | null
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
  const [openId, setOpenId] = useState<string | null>(null) // the agent whose drawer is open
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AgentFilter>('all')
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
  const counts = useMemo(() => filterCounts(agents), [agents])
  const visible = useMemo(() => filterAgents(agents, query, filter), [agents, query, filter])
  const opened = agents.find((a) => a.id === openId) ?? null

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
      <div className="w-full max-w-5xl mx-auto px-4 md:px-8 py-6 md:py-8 space-y-5">
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
          <div className="rounded-card border border-[var(--border)] bg-raised p-4 md:p-5 max-w-3xl">
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
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
                <Icon.Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                <input type="search" aria-label={t('agents.search.label')} placeholder={t('agents.search.placeholder')} value={query} onChange={(e) => setQuery(e.target.value)} className={`${inputCls} pl-9`} />
              </div>
              <div role="group" aria-label={t('agents.filter.label')} className="flex flex-wrap gap-1.5">
                {AGENT_FILTERS.filter((f) => f === 'all' || f === filter || counts[f] > 0).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                    className={`inline-flex items-center gap-1.5 min-h-9 px-3 rounded-pill border text-label font-medium transition-colors duration-fast [@media(hover:none)]:min-h-11 ${
                      filter === f ? 'border-transparent bg-action text-on-action' : 'border-[var(--border)] bg-raised text-[var(--text)] hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    {t(`agents.filter.${f}`)}
                    <span className={filter === f ? 'opacity-80' : 'text-[var(--muted)]'}>{counts[f]}</span>
                  </button>
                ))}
              </div>
            </div>
            {visible.length === 0 ? (
              <div role="status" className="rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center">
                <p className="text-body font-medium text-[var(--text)]">{t('agents.noMatch')}</p>
                <p className="mt-1 text-label text-[var(--muted)]">{t('agents.noMatchHint')}</p>
              </div>
            ) : (
              <ul aria-label={t('agents.list.label')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((a) => {
                  const name = a.name || t('agents.unnamed')
                  const model = models.find((m) => m.id === a.definition.model) ?? { id: a.definition.model, label: a.definition.model }
                  const when = a.enabled && a.nextRunAt ? t('agents.row.nextRun', { when: formatInstant(a.nextRunAt, tz, locale) }) : a.definition.schedule ? null : t('agents.row.noSchedule')
                  return (
                    <li key={a.id} className="flex">
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        onClick={() => setOpenId(a.id)}
                        className="w-full flex flex-col justify-start text-left rounded-card border border-[var(--border)] bg-raised p-4 space-y-2 hover:border-[var(--accent)] hover:shadow-raised transition duration-fast"
                      >
                        <span className="flex items-start gap-3">
                          <span aria-hidden className="grid place-items-center w-9 h-9 shrink-0 rounded-control bg-accent-soft text-[var(--accent-text)]">
                            <Icon.Sparkle size={18} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-body font-semibold text-[var(--text)] truncate">{name}</span>
                            <span className="mt-0.5 inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">{t(chipKey(a))}</span>
                          </span>
                        </span>
                        {a.description && <span className="block text-label text-[var(--muted)] line-clamp-2">{a.description}</span>}
                        <span className="flex items-center gap-2 text-caption text-[var(--muted)]">
                          <ProviderMark model={model} size={14} className="shrink-0" />
                          <span className="min-w-0 truncate">{model.label}</span>
                        </span>
                        {when && <span className="block text-caption text-[var(--muted)] truncate">{when}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
      {opened && (
        <AgentDrawer
          agent={opened}
          models={models}
          toolOptions={tools.options}
          busy={busy === opened.id}
          queued={!!queued[opened.id]}
          historyOpen={historyFor === opened.id}
          tz={tz}
          now={now}
          onClose={() => (setOpenId(null), setHistoryFor(null))}
          onSubmit={() => void act(opened, () => agentsApi.submit(opened.id))}
          onEnable={() => void act(opened, () => agentsApi.enable(opened.id))}
          onDisable={() => void act(opened, () => agentsApi.disable(opened.id))}
          onRun={() => void act(opened, async () => void (await agentsApi.run(opened.id)), () => setQueued((q) => ({ ...q, [opened.id]: true })))}
          onToggleHistory={() => setHistoryFor(historyFor === opened.id ? null : opened.id)}
          onEdit={() => (setOpenId(null), setHistoryFor(null), setEditing(opened))}
          onDelete={() => setDeleting(opened)}
          onOpenChat={(id) => (setOpenId(null), onOpenChat(id))}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('agents.delete.title', { name: deleting.name })}
          body={t('agents.delete.body')}
          confirmLabel={t('agents.delete.confirm')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting
            setDeleting(null)
            setOpenId(null)
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
