import { useId, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import { useModalDialog } from '../../lib/useModalDialog.js'
import { projectsApi } from './projectsApi.js'
import { FailureNotice, ghostBtn, iconBtn } from './ui.jsx'

/** "Move to project": puts one of the caller's own (non-temporary) chats into a project she belongs to. */
export default function MoveToProjectDialog({ session, projects, onClose, onMoved }) {
  const t = useT()
  const ref = useRef(null)
  const titleId = useId()
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  useModalDialog(ref, { onClose })

  const move = async (p) => {
    setBusyId(p.id)
    setError(null)
    try {
      await projectsApi.attach(p.id, session.id)
      await onMoved(p)
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-modal grid place-items-center bg-black/50 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-modal space-y-3">
        <div className="flex items-start gap-2">
          <h2 id={titleId} className="flex-1 text-body font-semibold text-[var(--text)]">
            {t('projects.move.title', { title: session.title })}
          </h2>
          <button type="button" onClick={onClose} className={iconBtn} aria-label={t('common.close')} title={t('common.close')}>
            <Icon.Close size={16} />
          </button>
        </div>
        <p className="text-label text-[var(--muted)]">{t('projects.move.hint')}</p>
        <FailureNotice error={error} ctx="attach" onDismiss={() => setError(null)} />
        {projects.length === 0 ? (
          <p className="text-body text-[var(--muted)]">{t('projects.move.none')}</p>
        ) : (
          <ul className="space-y-1 max-h-72 overflow-y-auto">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" disabled={busyId != null} onClick={() => move(p)} className={`${ghostBtn} w-full justify-start`}>
                  <Icon.Folder size={15} className="shrink-0 text-[var(--muted)]" />
                  <span className="truncate">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
