import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useT } from '../../lib/i18n.tsx'
import type { TFn } from '../../lib/tFn.ts'
import { projectsApi } from './projectsApi.ts'
import { can } from './projectsLogic.ts'
import type { ApiFailure, ChatRow, FilesContext, Member, Project, ProjectFile, ProjectLimits } from './projectsLogic.ts'
import { ConfirmDialog, FailureNotice, RoleBadge, inputCls, primaryBtn, ghostBtn, dangerBtn } from './ui.tsx'
import InstructionsSection from './InstructionsSection.tsx'
import FilesSection from './FilesSection.tsx'
import MembersSection from './MembersSection.tsx'
import ChatsSection from './ChatsSection.tsx'

// #/projects/:id. One page, one region per concern (Instructions, Files, Members,
// Chats), each with the controls its role can use and a read-only view otherwise.
// Every section reports a refusal with the next step; a 403/404 also reloads the
// project, because the likeliest cause is that the caller's role changed.
interface ProjectData {
  project: Project | null
  members: Member[]
  files: ProjectFile[]
  context: FilesContext | null
  sessions: ChatRow[]
}

interface ProjectDetailProps {
  projectId: string | number
  email?: string | null
  limits?: ProjectLimits | null
  onBack: () => void
  onChanged?: () => unknown
  onOpenChat(id: string | number): void
  onNewChat(projectId: string | number): void
  onOpenMenu: () => void
}

export default function ProjectDetail({ projectId, email, limits, onBack, onChanged, onOpenChat, onNewChat, onOpenMenu }: ProjectDetailProps) {
  const t: TFn = useT()
  const titleId = useId()
  const [data, setData] = useState<ProjectData>({ project: null, members: [], files: [], context: null, sessions: [] })
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<ApiFailure | null>(null)
  // a failed files read is an error, not an empty project
  const [filesError, setFilesError] = useState<ApiFailure | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState<ApiFailure | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<ApiFailure | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
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
      setFatal(p.reason as ApiFailure)
      setLoading(false)
      return
    }
    setFatal(null)
    setFilesError(f.status === 'rejected' ? (f.reason as ApiFailure) : null)
    setData((d) => ({
      project: (p.value.project || p.value) as Project,
      members: m.status === 'fulfilled' ? m.value.members : d.members,
      files: f.status === 'fulfilled' ? f.value.files : d.files,
      context: f.status === 'fulfilled' ? f.value.context || null : d.context,
      sessions: s.status === 'fulfilled' ? (s.value.sessions as ChatRow[]) : d.sessions, // the server always sends the list
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

  // `project` is null only while loading or after a fatal error; both return early before it is read
  const { project, members, files, context, sessions } = data as ProjectData & { project: Project }
  const role = project?.role || null

  // a refusal usually means the role changed under the page: look again
  const onRefused = (err: ApiFailure | null | undefined) => {
    if (err?.status === 403 || err?.status === 404) refresh()
  }

  const saveName = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const name = nameDraft.trim()
    if (!name) return setNameError({ status: 400, code: 'invalid_name' })
    if (name === project.name) return setRenaming(false)
    try {
      const r = await projectsApi.update(projectId, { name })
      setData((d) => ({ ...d, project: r.project || ({ ...d.project, name } as Project) }))
      setNameError(null)
      setRenaming(false)
      onChanged?.()
    } catch (err) {
      setNameError(err as ApiFailure)
      onRefused(err as ApiFailure)
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
      setDeleteError(err as ApiFailure)
      onRefused(err as ApiFailure)
    } finally {
      setDeleting(false)
    }
  }

  const shell = (children: React.ReactNode) => (
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
            <h1 id={titleId} className="text-heading font-bold text-[var(--text)] min-w-0 truncate" title={project.name as string}>
              {project.name}
            </h1>
            <RoleBadge role={role} />
            {can(role, 'edit') && (
              <button type="button" onClick={() => (setNameDraft(project.name as string), setRenaming(true))} className={ghostBtn}>
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

      <InstructionsSection {...common} project={project} onSaved={(p) => setData((d) => ({ ...d, project: { ...d.project, ...p } as Project }))} />
      <FilesSection {...common} files={files} context={context} loadError={filesError} onReload={refresh} />
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
