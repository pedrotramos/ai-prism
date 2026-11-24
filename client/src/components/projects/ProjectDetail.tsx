import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Icon from '../Icons.tsx'
import Skeleton from '../Skeleton.tsx'
import { useT } from '../../lib/i18n.tsx'
import type { TFn } from '../../lib/tFn.ts'
import { projectsApi } from './projectsApi.ts'
import { can } from './projectsLogic.ts'
import type { ApiFailure, ChatRow, FilesContext, Member, Project, ProjectFile, ProjectLimits } from './projectsLogic.ts'
import { ConfirmDialog, FailureNotice, ProjectDot, RoleBadge, inputCls, primaryBtn, ghostBtn, dangerBtn } from './ui.tsx'
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
  const membersRef = useRef<HTMLDivElement>(null)

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

  // "Share project" is the members section: bring it into view and put the cursor on its first control
  const goToMembers = () => {
    const el = membersRef.current
    if (!el) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' })
    const first = el.querySelector<HTMLElement>('[data-share-first]') ?? el.querySelector<HTMLElement>('input, select, button')
    first?.focus({ preventScroll: true })
  }

  const shell = (children: React.ReactNode, crumbName?: string) => (
    <main aria-labelledby={titleId} className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      <header className="shrink-0 min-h-14 flex items-center gap-2 px-2 md:px-5 border-b border-[var(--border)]">
        <button type="button" onClick={onOpenMenu} className="md:hidden grid place-items-center min-w-11 min-h-11 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)]" aria-label={t('shell.openMenu')} title={t('shell.openMenu')}>
          <Icon.Menu size={20} />
        </button>
        <nav aria-label={t('projects.crumb')} className="min-w-0 flex items-center gap-1 text-label">
          <button type="button" onClick={onBack} className="min-h-10 px-2 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] [@media(hover:none)]:min-h-11">
            {t('projects.crumb')}
          </button>
          {crumbName && (
            <>
              <span aria-hidden className="text-[var(--faint)]">/</span>
              <span aria-current="page" className="min-w-0 truncate font-semibold text-[var(--text)]">
                {crumbName}
              </span>
            </>
          )}
        </nav>
        {crumbName && can(role, 'members') && (
          <button type="button" onClick={goToMembers} className={`${ghostBtn} ml-auto shrink-0`}>
            <Icon.Users size={14} /> <span className="hidden sm:inline">{t('projects.share')}</span>
            <span className="sr-only sm:hidden">{t('projects.share')}</span>
          </button>
        )}
      </header>
      <div className="w-full max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-8 space-y-4">{children}</div>
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
  const shown = members.slice(0, 4)
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
            <ProjectDot id={project.id} />
            <h1 id={titleId} className="text-title font-bold text-[var(--text)] min-w-0 truncate" title={project.name as string}>
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
      {project.description && <p className="max-w-2xl text-body text-[var(--muted)]">{project.description}</p>}
      {members.length > 0 && (
        <ul aria-label={t('projects.members.avatars', { names: members.map((m) => m.principal).join(', ') })} className="flex items-center -space-x-1.5">
          {shown.map((m) => (
            <li key={`${m.kind}:${m.principal}`} title={m.principal} className="grid place-items-center w-7 h-7 rounded-full border-2 border-[var(--surface)] bg-accent-soft text-caption font-semibold text-[var(--accent-text)]">
              <span aria-hidden>{m.principal.slice(0, 2).toUpperCase()}</span>
            </li>
          ))}
          {members.length > shown.length && (
            <li aria-hidden className="grid place-items-center min-w-7 h-7 px-1 rounded-full border-2 border-[var(--surface)] bg-[var(--surface-3)] text-caption font-semibold text-[var(--muted)]">
              +{members.length - shown.length}
            </li>
          )}
        </ul>
      )}
      <FailureNotice error={nameError} ctx="edit" onDismiss={() => setNameError(null)} />
      {role === 'view' && <p className="text-label text-[var(--muted)]">{t('projects.viewerNote')}</p>}
      <p className="text-label text-[var(--muted)]">{t('projects.retention')}</p>

      <div className="grid gap-4 lg:flex lg:items-start">
        <div className="min-w-0 lg:flex-1 space-y-4">
          {can(role, 'attach') && (
            <button
              type="button"
              onClick={() => onNewChat(projectId)}
              className="w-full min-h-14 flex items-center gap-3 rounded-composer border border-[var(--border)] bg-raised px-4 text-left text-body text-[var(--muted)] shadow-raised hover:border-[var(--accent)] transition-colors duration-fast [@media(hover:none)]:min-h-14"
            >
              <Icon.Plus size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('projects.newChatHere')}</span>
              <span aria-hidden className="grid place-items-center w-8 h-8 rounded-control bg-action text-on-action">
                <Icon.Send size={14} />
              </span>
            </button>
          )}
          <ChatsSection {...common} email={email} sessions={sessions} onReload={refresh} onOpenChat={onOpenChat} />
        </div>
        <div role="group" aria-label={t('projects.side.label')} className="min-w-0 lg:w-80 lg:shrink-0 space-y-4">
          <InstructionsSection {...common} project={project} onSaved={(p) => setData((d) => ({ ...d, project: { ...d.project, ...p } as Project }))} />
          <FilesSection {...common} files={files} context={context} loadError={filesError} onReload={refresh} />
          <div ref={membersRef}>
            <MembersSection {...common} email={email} members={members} onReload={refresh} onLeft={onBack} />
          </div>
        </div>
      </div>

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
    </>,
    project.name as string
  )
}
