import { useId, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import Skeleton from '../Skeleton.jsx'
import { useT } from '../../lib/i18n.jsx'
import { projectsApi } from './projectsApi.js'
import { FailureNotice, RoleBadge, inputCls, primaryBtn, ghostBtn } from './ui.jsx'

// #/projects: the caller's projects, and where a new one is made. The page is
// the app's <main> (it replaces the chat column, like History).
export default function ProjectsPage({ list, onOpen, onNewChat, onBack, onOpenMenu }) {
  const t = useT()
  const titleId = useId()
  const nameId = useId()
  const nameRef = useRef(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const max = list.limits?.nameMaxChars

  const create = async (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError({ status: 400, code: 'invalid_name' })
      nameRef.current?.focus()
      return
    }
    setCreating(true)
    setError(null)
    try {
      const r = await projectsApi.create({ name: trimmed })
      setName('')
      await list.reload()
      onOpen(r.project.id)
    } catch (err) {
      setError(err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <main aria-labelledby={titleId} className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      <header className="shrink-0 min-h-14 flex items-center gap-2 px-2 md:px-5 border-b border-[var(--border)]">
        <button type="button" onClick={onOpenMenu} className="md:hidden grid place-items-center min-w-11 min-h-11 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)]" aria-label={t('shell.openMenu')} title={t('shell.openMenu')}>
          <Icon.Menu size={20} />
        </button>
        <button type="button" onClick={onBack} className={`${ghostBtn} border-transparent bg-transparent`}>
          <Icon.ChevronLeft size={16} /> {t('projects.backToChat')}
        </button>
      </header>
      <div className="w-full max-w-3xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 id={titleId} className="text-heading font-bold text-[var(--text)]">
            {t('projects.title')}
          </h1>
          <p className="text-body text-[var(--muted)]">{t('projects.intro')}</p>
          <p className="text-label text-[var(--muted)] mt-1">{t('projects.retention')}</p>
        </div>

        <form onSubmit={create} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2" noValidate>
          <label htmlFor={nameId} className="block text-label font-semibold text-[var(--text)]">
            {t('projects.new.label')}
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              ref={nameRef}
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={max || undefined}
              placeholder={t('projects.new.placeholder')}
              className={inputCls}
              autoComplete="off"
            />
            <button type="submit" disabled={creating} className={`${primaryBtn} shrink-0`}>
              <Icon.Plus size={16} /> {creating ? t('projects.new.creating') : t('projects.new.create')}
            </button>
          </div>
          <FailureNotice error={error} ctx="create" onDismiss={() => setError(null)} />
        </form>

        {list.loading ? (
          <div role="status" aria-label={t('projects.loading')} aria-busy="true" className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" rounded="rounded-card" />
            ))}
          </div>
        ) : list.error ? (
          <FailureNotice error={list.error} ctx="list" onRetry={list.reload} />
        ) : list.projects.length === 0 ? (
          <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center">
            <p className="text-body font-medium text-[var(--text)]">{t('projects.empty')}</p>
            <p className="mt-1 text-label text-[var(--muted)]">{t('projects.emptyHint')}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {list.projects.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] pr-2">
                <button type="button" onClick={() => onOpen(p.id)} className="flex-1 min-w-0 min-h-16 flex items-center gap-3 px-4 py-3 text-left rounded-card hover:bg-[var(--surface-2)] transition-colors duration-fast">
                  <Icon.Folder size={18} className="shrink-0 text-[var(--muted)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold text-[var(--text)] truncate">{p.name}</span>
                    {p.description && <span className="block text-label text-[var(--muted)] truncate">{p.description}</span>}
                  </span>
                  <RoleBadge role={p.role} />
                </button>
                <button type="button" onClick={() => onNewChat(p.id)} className={ghostBtn} aria-label={t('projects.newChatIn', { name: p.name })}>
                  <Icon.Plus size={14} /> <span className="hidden sm:inline">{t('projects.newChat')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
