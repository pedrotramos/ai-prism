import { useCallback, useEffect, useId, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { ghostBtn, primaryBtn } from '../projects/ui.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import { errorKey } from './agentsLogic.ts'
import type { AgentLimits, AgentRow, SharedAgent } from './agentsLogic.ts'

// "Shared with you": the newest approved version of each agent other people shared with the caller. Read-only by design: the
// recipient reads the approved version, may try it in a chat (her own identity) or copy it into her own agents as a draft that
// needs its own approval. Nothing here runs the owner's agent.

interface Props {
  limits: AgentLimits | null
  agentCount: number
  /** bump to re-read the list (the page moved) */
  reloadKey?: number
  onCreated: (row: AgentRow) => void
  onTryInChat: (draft: { instructions: string; prompt: string }) => void
}

export default function SharedAgentsSection({ limits, agentCount, reloadKey = 0, onCreated, onTryInChat }: Props) {
  const { t } = useI18n()
  const titleId = useId()
  const [agents, setAgents] = useState<SharedAgent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setAgents((await agentsApi.sharedWithMe()).agents)
      setError(null)
    } catch (e) {
      setError(e instanceof AgentsApiError ? e.code : 'internal_error')
      setAgents((cur) => cur ?? [])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const copy = async (a: SharedAgent) => {
    setBusy(a.agentId)
    setError(null)
    setNote(null)
    try {
      const row = await agentsApi.duplicate(a.agentId, { version: a.version, name: t('agents.versions.copyName', { name: a.name }).slice(0, limits?.nameMax ?? 80) })
      onCreated(row)
      setNote(t('agents.versions.duplicate.done', { name: row.name }))
    } catch (e) {
      setError(e instanceof AgentsApiError ? e.code : 'internal_error')
    } finally {
      setBusy(null)
    }
  }

  // nothing shared and nothing wrong: the section stays out of the way until somebody shares something
  if (agents !== null && agents.length === 0 && !error) return null
  const atLimit = !!limits && agentCount >= limits.agentsPerOwner

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div>
        <h2 id={titleId} className="text-title font-semibold text-[var(--text)]">
          {t('agents.shared.title')}
        </h2>
        <p className="text-label text-[var(--muted)]">{t('agents.shared.intro')}</p>
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
      {agents === null ? (
        <Skeleton className="h-16 w-full" rounded="rounded-card" />
      ) : (
        <ul aria-label={t('agents.shared.list.label')} className="space-y-3">
          {agents.map((a) => {
            const shown = open === a.agentId
            return (
              <li key={a.agentId} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 text-body font-semibold text-[var(--text)] truncate">{a.name}</h3>
                  <span className="inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">{t('agents.versions.chip.approved')}</span>
                </div>
                <p className="text-label text-[var(--muted)]">{t('agents.shared.by', { owner: a.ownerEmail, n: a.version })}</p>
                {a.description && <p className="text-label text-[var(--muted)]">{a.description}</p>}
                {shown && (
                  <dl className="space-y-1.5 text-label">
                    <div>
                      <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.prompt')}</dt>
                      <dd className="whitespace-pre-wrap text-[var(--text)]">{a.definition.prompt}</dd>
                    </div>
                    {a.definition.instructions && (
                      <div>
                        <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.instructions')}</dt>
                        <dd className="whitespace-pre-wrap text-[var(--text)]">{a.definition.instructions}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.tools')}</dt>
                      <dd className="text-[var(--text)]">{a.definition.tools.length ? a.definition.tools.join(', ') : t('agents.versions.diff.empty')}</dd>
                    </div>
                  </dl>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" className={ghostBtn} aria-expanded={shown} onClick={() => setOpen(shown ? null : a.agentId)}>
                    {t(shown ? 'agents.shared.hide' : 'agents.shared.show')}
                  </button>
                  <button type="button" className={ghostBtn} onClick={() => onTryInChat({ instructions: a.definition.instructions, prompt: a.definition.prompt })}>
                    {t('agents.shared.tryInChat')}
                  </button>
                  <button type="button" className={primaryBtn} disabled={busy === a.agentId || atLimit} onClick={() => void copy(a)}>
                    <Icon.Copy size={14} aria-hidden /> {t('agents.shared.duplicate')}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {atLimit && limits && <p className="text-label text-[var(--muted)]">{t('agents.limitReached', { max: limits.agentsPerOwner })}</p>}
    </section>
  )
}
