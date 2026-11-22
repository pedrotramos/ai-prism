import { useCallback, useEffect, useId, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { ghostBtn } from '../projects/ui.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import { browserTimeZone, errorKey, formatInstant } from './agentsLogic.ts'
import type { AgentRunRow } from './agentsLogic.ts'

// The runs of one agent, newest first, each linked to the chat it wrote (a manual or a scheduled run both create one).
const PAGE = 20

interface Props {
  agentId: string
  agentName: string
  onOpenChat: (sessionId: string) => void
  onClose: () => void
}

export default function AgentRunHistory({ agentId, agentName, onOpenChat, onClose }: Props) {
  const { t, locale } = useI18n()
  const titleId = useId()
  const [runs, setRuns] = useState<AgentRunRow[]>([])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tz = browserTimeZone()

  const load = useCallback(
    async (before?: string) => {
      setLoading(true)
      setError(null)
      try {
        const r = await agentsApi.runs(agentId, { limit: PAGE, ...(before ? { before } : {}) })
        setRuns((prev) => (before ? [...prev, ...r.runs] : r.runs))
        setMore(r.runs.length === PAGE)
      } catch (e) {
        setError(e instanceof AgentsApiError ? e.code : 'internal_error')
      } finally {
        setLoading(false)
      }
    },
    [agentId]
  )
  useEffect(() => {
    void load()
  }, [load])

  return (
    <section aria-labelledby={titleId} className="mt-3 rounded-card border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="flex-1 min-w-0 text-body font-semibold text-[var(--text)]">
          {t('agents.history.forAgent', { name: agentName })}
        </h3>
        <button type="button" className={ghostBtn} onClick={() => void load()} disabled={loading}>
          {t('agents.history.refresh')}
        </button>
        <button type="button" className={ghostBtn} onClick={onClose}>
          {t('agents.history.close')}
        </button>
      </div>
      {error && (
        <p className="text-label text-[var(--danger)]">
          {t(errorKey(error))}
        </p>
      )}
      {loading && runs.length === 0 ? (
        <div role="status" aria-label={t('agents.history.loading')} aria-busy="true">
          <Skeleton className="h-10 w-full" rounded="rounded-control" />
        </div>
      ) : runs.length === 0 && !error ? (
        <p className="text-label text-[var(--muted)]">{t('agents.history.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.id} className="rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2 space-y-0.5">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-body text-[var(--text)]">
                <span className="font-semibold">{t(`agents.runStatus.${r.status}`)}</span>
                <span className="text-[var(--muted)]">{t(`agents.trigger.${r.trigger}`)}</span>
                <span className="text-label text-[var(--muted)]">{formatInstant(r.startedAt || r.slotAt, tz, locale)}</span>
              </p>
              {r.errorCode && <p className="text-label text-[var(--muted)]">{t(errorKey(r.errorCode))}</p>}
              <p className="flex flex-wrap items-center gap-x-3 text-label text-[var(--muted)]">
                {r.costUsd !== null && <span>{t('agents.history.cost', { cost: `$${r.costUsd.toFixed(4)}` })}</span>}
                {r.unpriced && <span>{t('agents.history.unpriced')}</span>}
                {r.toolNames.length > 0 && <span>{t('agents.history.tools', { tools: r.toolNames.join(', ') })}</span>}
              </p>
              {r.sessionId ? (
                <a
                  href={`#/chat/${encodeURIComponent(r.sessionId)}`}
                  onClick={(e) => {
                    e.preventDefault()
                    onOpenChat(r.sessionId as string)
                  }}
                  className="inline-flex items-center gap-1 min-h-11 md:min-h-8 text-label font-semibold text-[var(--accent-text)] underline underline-offset-2"
                >
                  <Icon.ChevronRight size={14} aria-hidden /> {t('agents.history.openChat')}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {more && (
        <button type="button" className={ghostBtn} disabled={loading} onClick={() => void load(runs[runs.length - 1]?.id)}>
          {t('agents.history.more')}
        </button>
      )}
    </section>
  )
}
