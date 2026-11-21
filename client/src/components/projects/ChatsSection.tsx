import { useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import type { TFn } from '../../lib/tFn.ts'
import { relativeTime } from '../../lib/date.ts'
import { projectsApi } from './projectsApi.ts'
import { can } from './projectsLogic.ts'
import type { ApiFailure, ChatRow } from './projectsLogic.ts'
import { FailureNotice, Section, primaryBtn, ghostBtn } from './ui.tsx'

interface ChatsSectionProps {
  projectId: string | number
  role: string | null
  email?: string | null
  sessions: ChatRow[]
  onReload: () => Promise<unknown> | void
  onRefused: (err: ApiFailure) => void
  onOpenChat: (id: string | number) => void
  onNewChat: () => void
}

export default function ChatsSection({ projectId, role, email, sessions, onReload, onRefused, onOpenChat, onNewChat }: ChatsSectionProps) {
  const t: TFn = useT()
  const [error, setError] = useState<ApiFailure | null>(null)
  const [busyId, setBusyId] = useState<string | number | null>(null)
  const me = String(email || '').toLowerCase()

  const detach = async (s: ChatRow) => {
    setBusyId(s.id)
    setError(null)
    try {
      await projectsApi.detach(projectId, s.id)
      await onReload()
    } catch (e) {
      setError(e as ApiFailure)
      onRefused(e as ApiFailure)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Section
      title={t('projects.chats.title')}
      hint={t('projects.chats.hint')}
      action={
        can(role, 'attach') && (
          <button type="button" onClick={onNewChat} className={primaryBtn}>
            <Icon.Plus size={14} /> {t('projects.newChat')}
          </button>
        )
      }
    >
      <FailureNotice error={error} ctx="detach" onDismiss={() => setError(null)} />
      {sessions.length === 0 ? (
        <p className="text-body text-[var(--muted)]">{t('projects.chats.empty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {sessions.map((s) => {
            const rt = s.updated_at ? relativeTime(s.updated_at) : null
            const mine = String(s.owner_email || '').toLowerCase() === me
            return (
              <li key={s.id} className="flex items-center gap-2 py-1">
                <button type="button" onClick={() => onOpenChat(s.id)} className="flex-1 min-w-0 min-h-11 flex items-center gap-3 text-left rounded-control hover:bg-[var(--surface-2)] px-2">
                  <Icon.History size={15} className="shrink-0 text-[var(--muted)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body text-[var(--text)] truncate">{s.title}</span>
                    <span className="block text-label text-[var(--muted)] truncate">
                      {mine ? t('projects.chats.you') : s.owner_email}
                      {rt && ` · ${t(rt.key, rt.vars)}`}
                    </span>
                  </span>
                </button>
                {mine && can(role, 'detach') && (
                  <button type="button" disabled={busyId === s.id} onClick={() => detach(s)} className={ghostBtn} aria-label={t('projects.chats.detach', { title: s.title })}>
                    {t('projects.chats.detachShort')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
