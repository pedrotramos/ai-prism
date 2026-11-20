import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import Skeleton from '../Skeleton.jsx'
import { useT } from '../../lib/i18n.jsx'
import { projectsApi } from './projectsApi.js'
import { can } from './projectsLogic.js'
import { ConfirmDialog, FailureNotice, RoleBadge, inputCls, primaryBtn, ghostBtn, dangerBtn } from './ui.jsx'
import InstructionsSection from './InstructionsSection.jsx'
import FilesSection from './FilesSection.jsx'
import MembersSection from './MembersSection.jsx'
import ChatsSection from './ChatsSection.jsx'

// #/projects/:id. One page, one region per concern (Instructions, Files, Members,
// Chats), each with the controls its role can use and a read-only view otherwise.
// Every section reports a refusal with the next step; a 403/404 also reloads the
// project, because the likeliest cause is that the caller's role changed.
export default function ProjectDetail({ projectId, email, limits, onBack, onChanged, onOpenChat, onNewChat, onOpenMenu }) {
  const t = useT()
  const titleId = useId()
  const [data, setData] = useState({ project: null, members: [], files: [], context: null, sessions: [] })
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const renameRef = useRef(null)
  const liveRef = useRef(0)

  const refresh = useCallback(async () => {
    const run = ++liveRef.current
    const [p, m, f, s] = await Promise.allSettled([
      projectsApi.get(projectId),
      projectsApi.members(projectId),
      projectsApi.files(projectId),
      projectsApi.sessions(projectId),
    ])
    if (run !== liveRef.current) return
    if (p.status === 'rejected') {
      setFatal(p.reason)
      setLoading(false)
      return
    }
    setFatal(null)
    setData((d) => ({
      project: p.value.project || p.value,
      members: m.status === 'fulfilled' ? m.value.members : d.members,
      files: f.status === 'fulfilled' ? f.value.files : d.files,
      context: f.status === 'fulfilled' ? f.value.context || null : d.context,
      sessions: s.status === 'fulfilled' ? s.value.sessions : d.sessions,
    }))
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    setLoading(true)
    setData({ project: null, members: [], files: [], context: null, sessions: [] })
    refresh()
    return () => {
      liveRef.current++
    }
  }, [refresh])

  useEffect(() => {
    if (renaming) renameRef.current?.focus()
  }, [renaming])

  const { project, members, files, context, sessions } = data
  const role = project?.role || null

  // a refusal usually means the role changed under the page: look again
  const onRefused = (err) => {
    if (err?.status === 403 || err?.status === 404) refresh()
  }

  const saveName = async (e) => {
    e.preventDefault()
    const name = nameDraft.trim()
    if (!name) return setNameError({ status: 400, code: 'invalid_name' })
    if (name === project.name) return setRenaming(false)
    try {
      const r = await projectsApi.update(projectId, { name })
      setData((d) => ({ ...d, project: r.project || { ...d.project, name } }))
      setNameError(null)
      setRenaming(false)
      onChanged?.()
    } catch (err) {
      setNameError(err)
      onRefused(err)
    }
  }

  const remove = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await projectsApi.remove(projectId)
      setConfirmDelete(false)
      await onChanged?.()
      onBack()
    } catch (err) {
      setDeleteError(err)
      onRefused(err)
    } finally {
      setDeleting(false)
    }
  }

  const shell = (children) => (
    <main aria-labelledby={titleId} className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      <header className="shrink-0 min-h-14 flex items-center gap-2 px-2 md:px-5 border-b border-[var(--border)]">
        <button type="button" onClick={onOpenMenu} className="md:hidden grid place-items-center min-w-11 min-h-11 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)]" aria-label={t('shell.openMenu')} title={t('shell.openMenu')}>
          <Icon.Menu size={20} />
        </button>
        <button type="button" onClick={onBack} className={`${ghostBtn} border-transparent bg-transparent`}>
          <Icon.ChevronLeft size={16} /> {t('projects.backToList')}
        </button>
      </header>
      <div className="w-full max-w-3xl mx-auto px-4 py-6 space-y-4">{children}</div>
    </main>
  )

  if (loading) {
    return shell(
      <div role="status" aria-label={t('projects.loading')} aria-busy="true" className="space-y-3">
        <h1 id={titleId} className="sr-only">
          {t('projects.loading')}
        </h1>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full" rounded="rounded-card" />
        ))}
      </div>
    )
  }

  if (fatal) {
    return shell(
      <>
        <h1 id={titleId} className="sr-only">
          {t('projects.title')}
        </h1>
        <FailureNotice error={fatal} ctx="open" onRetry={fatal.status === 404 ? undefined : refresh} />
        <button type="button" onClick={onBack} className={primaryBtn}>
          {t('projects.backToList')}
        </button>
      </>
    )
  }

  const common = { projectId, role, limits, onRefused, onChanged }
  return shell(
    <>
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <form onSubmit={saveName} className="flex-1 min-w-0 flex flex-wrap items-center gap-2" noValidate>
            <h1 id={titleId} className="sr-only">
              {project.name}
            </h1>
            <input
              ref={renameRef}
              aria-label={t('projects.rename.label')}
              value={nameDraft}
              maxLength={limits?.nameMaxChars || undefined}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setRenaming(false)
                  setNameError(null)
                }
              }}
              className={`${inputCls} flex-1 min-w-[12rem]`}
            />
            <button type="submit" className={primaryBtn}>
              {t('common.save')}
            </button>
            <button type="button" onClick={() => (setRenaming(false), setNameError(null))} className={ghostBtn}>
              {t('common.cancel')}
            </button>
          </form>
        ) : (
          <>
            <h1 id={titleId} className="text-xl font-bold text-[var(--text)] min-w-0 truncate" title={project.name}>
              {project.name}
            </h1>
            <RoleBadge role={role} />
            {can(role, 'edit') && (
              <button type="button" onClick={() => (setNameDraft(project.name), setRenaming(true))} className={ghostBtn}>
                <Icon.Pencil size={14} /> {t('projects.rename.action')}
              </button>
            )}
          </>
        )}
        {can(role, 'delete') && !renaming && (
          <button type="button" onClick={() => (setDeleteError(null), setConfirmDelete(true))} className={`${dangerBtn} ml-auto`}>
            <Icon.Trash size={14} /> {t('projects.delete.action')}
          </button>
        )}
      </div>
      <FailureNotice error={nameError} ctx="edit" onDismiss={() => setNameError(null)} />
      {role === 'view' && <p className="text-label text-[var(--muted)]">{t('projects.viewerNote')}</p>}
      <p className="text-label text-[var(--muted)]">{t('projects.retention')}</p>

      <InstructionsSection {...common} project={project} onSaved={(p) => setData((d) => ({ ...d, project: { ...d.project, ...p } }))} />
      <FilesSection {...common} files={files} context={context} onReload={refresh} />
      <MembersSection {...common} email={email} members={members} onReload={refresh} onLeft={onBack} />
      <ChatsSection {...common} email={email} sessions={sessions} onReload={refresh} onOpenChat={onOpenChat} onNewChat={() => onNewChat(projectId)} />

      {confirmDelete && (
        <ConfirmDialog
          title={t('projects.delete.title', { name: project.name })}
          body={t('projects.delete.body')}
          confirmLabel={deleting ? t('projects.delete.deleting') : t('projects.delete.confirm')}
          busy={deleting}
          error={deleteError}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}
