import { useEffect, useRef, useState } from 'react'
import Logo from './Logo.tsx'
import * as Icon from './Icons.tsx'
import Skeleton from './Skeleton.tsx'
import { timeGroupKey } from '../lib/date.ts'
import { useT } from '../lib/i18n.tsx'
import TemporaryBadge from './TemporaryBadge.tsx'
import { useThemeTransition } from './welcome/themeTransition.ts'
import { groupSessionsByProject } from './projects/projectsLogic.ts'
import MoveToProjectDialog from './projects/MoveToProjectDialog.tsx'

// Left navigation, in the order people expect from other chat assistants
// (Jakob's law) and with the two most-used ends of the list where attention is
// highest (serial position): New chat first, then search; the conversation list
// in the middle; the account and Settings last, bottom-left.
//
// Three presentations of the same content:
// - desktop expanded: an in-flow column (or, beside an expanded studio, a
//   floating panel over a scrim);
// - desktop collapsed: a 64 px rail of 44 px icon buttons with tooltips;
// - mobile: an off-canvas drawer that behaves as a modal dialog while open
//   (focus moves in and is trapped, Esc and the scrim close it, focus returns to
//   the button that opened it) and is inert while closed, so Tab never lands on
//   invisible controls.

const MOBILE_QUERY = '(max-width: 767px)'
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function useMediaQuery(query: string) {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return undefined
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

// Same rows the list renders (group label + 36 px title rows), so the list
// does not jump when the sessions arrive.
function SidebarSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="px-1 pt-1 space-y-3 animate-fade-in">
      {[[70, 55, 80], [60, 85, 50, 65]].map((rows, g) => (
        <div key={g}>
          <div className="px-3 pt-1 pb-2">
            <Skeleton className="h-2.5 w-16" rounded="rounded-full" />
          </div>
          {rows.map((w, i) => (
            <div key={i} className="h-9 flex items-center px-3">
              <Skeleton className="h-3" rounded="rounded-full" /* data */ style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Avatar({ email, className = '' }: { email?: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={`shrink-0 w-8 h-8 rounded-full bg-[var(--surface-3)] grid place-items-center text-label font-bold text-[var(--muted)] ${className}`}
    >
      {(email || '?')[0]!.toUpperCase()}
    </div>
  )
}

const railBtn =
  'w-11 h-11 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors duration-fast'
const iconBtn =
  'shrink-0 grid place-items-center w-8 h-8 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast'

// A chat row as the sidebar reads it.
interface SidebarSession {
  id: number
  title: string
  created_at: string
  updated_at?: string
  owner_email?: string
  ephemeral?: boolean
  project_id?: number | null
}

interface SidebarProject {
  id: number
  name?: string | null
  role?: string | null
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

interface SidebarProps {
  open: boolean
  email?: string
  sessions: SidebarSession[]
  sessionsLoading: boolean
  currentId: number | null
  onNew: () => void
  onSelect: (id: number) => void
  onDelete: (id: number) => void
  deletingId: number | null
  onRename: (id: number, title: string) => void
  onClose?: () => void
  onOpenHistory: () => void
  onOpenProject?: (id: number) => void
  onOpenCosts?: () => void
  costsActive: boolean
  /** scheduled agents: Shell passes the opener only while the server says the feature is on */
  onOpenAgents?: () => void
  agentsActive?: boolean
  projects?: SidebarProject[]
  onOpenProjects?: () => void
  projectsActive: boolean
  onNewChatInProject?: (id: number) => void
  onProjectsChanged?: () => void | Promise<void>
  onOpenSettings?: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  overlay: boolean
}

export default function Sidebar({
  open,
  email,
  sessions,
  sessionsLoading,
  currentId,
  onNew,
  onSelect,
  onDelete,
  deletingId,
  onRename,
  onClose,
  onOpenHistory,
  onOpenProject,
  onOpenCosts,
  costsActive,
  onOpenAgents,
  agentsActive = false,
  projects = [],
  onOpenProjects,
  projectsActive,
  onNewChatInProject,
  onProjectsChanged,
  onOpenSettings,
  collapsed,
  onToggleCollapse,
  overlay,
}: SidebarProps) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [moving, setMoving] = useState<SidebarSession | null>(null)
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const drawerRef = useRef<HTMLDivElement>(null)
  const newChatRef = useRef<HTMLButtonElement>(null)
  // App passes inline arrows; keep the latest without re-running the effects
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useThemeTransition()

  const drawerModal = isMobile && open

  // closed mobile drawer: off-screen, so take it out of the tab order and the
  // accessibility tree
  useEffect(() => {
    const el = drawerRef.current
    if (el) el.inert = isMobile && !open
  }, [isMobile, open])

  // open mobile drawer: move focus in, trap Tab, close on Escape, give focus
  // back to whatever opened it (the header's menu button)
  useEffect(() => {
    if (!drawerModal) return undefined
    const el = drawerRef.current
    if (!el) return undefined
    const opener = document.activeElement
    const focusables = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0)
    ;(newChatRef.current || focusables()[0] || el).focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const first = list[0]!
      const last = list[list.length - 1]!
      if (!el.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [drawerModal])

  // project chats sit under their project (Common Region); the rest keep the time groups
  const { groups: projectGroups, personal } = groupSessionsByProject(sessions, projects)
  const groups: { key: string; items: SidebarSession[] }[] = []
  let lastGroup = null
  for (const sNode of personal) {
    const g = timeGroupKey(sNode.updated_at || sNode.created_at)
    if (g !== lastGroup) {
      groups.push({ key: g, items: [] })
      lastGroup = g
    }
    groups[groups.length - 1]!.items.push(sNode)
  }

  const startEdit = (sNode: SidebarSession) => {
    setEditingId(sNode.id)
    setDraft(sNode.title)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  const renderRow = (sNode: SidebarSession) => {
    // a temporary chat can never join a project: no project actions on it (server: 400 ephemeral_in_project)
    // a teammate's chat in a shared project: readable here, but only its author renames or deletes it
    const foreign = !!sNode.owner_email && String(sNode.owner_email).toLowerCase() !== String(email || '').toLowerCase()
    const movable = !foreign && !sNode.ephemeral && sNode.project_id == null && projects.length > 0
      const active = sNode.id === currentId
      const isDeleting = sNode.id === deletingId
      return (
        <li
          key={sNode.id}
          className={`group relative flex items-center rounded-control transition-colors duration-fast ${
            active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]'
          } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
        >
          {editingId === sNode.id ? (
            <input
              autoFocus
              aria-label={t('sidebar.rename')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') {
                  // cancel the edit, not the drawer
                  e.stopPropagation()
                  setEditingId(null)
                }
              }}
              className="flex-1 min-w-0 bg-transparent text-body px-3 py-2 border-b border-[var(--accent)]"
            />
          ) : (
            // full width for the title; it gives up room on the
            // right only while the row actions are visible
            // (hover, keyboard focus inside the row, touch screens)
            <button
              type="button"
              onClick={() => onSelect(sNode.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex-1 min-w-0 min-h-9 text-left text-body py-2 pl-3 truncate rounded-control ${
                isDeleting ? 'pr-9' : `pr-3 ${foreign ? '' : movable ? 'group-hover:pr-28 group-focus-within:pr-28' : 'group-hover:pr-20 group-focus-within:pr-20'} ${foreign ? '' : active ? (movable ? '[@media(hover:none)]:pr-32' : '[@media(hover:none)]:pr-24') : ''}`
              }`}
              title={sNode.title}
            >
              {sNode.ephemeral ? (
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{sNode.title}</span>
                  <TemporaryBadge />
                </span>
              ) : foreign ? (
                <span className="block min-w-0">
                  <span className="block truncate">{sNode.title}</span>
                  <span data-chat-author className="block truncate text-caption text-[var(--muted)]">
                    {t('projects.chats.by', { name: sNode.owner_email })}
                  </span>
                </span>
              ) : (
                sNode.title
              )}
            </button>
          )}
          {editingId !== sNode.id && !foreign && (
            <div
              className={`absolute right-1 top-1/2 -translate-y-1/2 items-center ${
                // touch screens have no hover: the open chat's row
                // keeps its actions visible (History shows them on
                // every row), the others stay clean
                isDeleting ? 'flex' : `hidden group-hover:flex group-focus-within:flex ${active ? '[@media(hover:none)]:flex' : ''}`
              }`}
            >
              {isDeleting ? (
                <span className="p-1.5" role="status" aria-label={t('sidebar.deleting')} title={t('sidebar.deleting')}>
                  <span className="block w-3.5 h-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                </span>
              ) : (
                <>
                  {movable && (
                    <button
                      type="button"
                      onClick={() => setMoving(sNode)}
                      className={`${iconBtn} [@media(hover:none)]:w-11 [@media(hover:none)]:h-11`}
                      aria-label={t('projects.move.chat', { title: sNode.title })}
                      title={t('projects.move.short')}
                    >
                      <Icon.Folder size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => startEdit(sNode)}
                    className={`${iconBtn} [@media(hover:none)]:w-11 [@media(hover:none)]:h-11`}
                    aria-label={t('sidebar.renameChat', { title: sNode.title })}
                    title={t('sidebar.rename')}
                  >
                    <Icon.Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(sNode.id)}
                    className={`${iconBtn} hover:text-[var(--danger)] [@media(hover:none)]:w-11 [@media(hover:none)]:h-11`}
                    aria-label={t('sidebar.deleteChat', { title: sNode.title })}
                    title={t('common.delete')}
                  >
                    <Icon.Trash size={14} />
                  </button>
                </>
              )}
            </div>
          )}
        </li>
      )
  }

  return (
    <>
      {/* collapsed desktop rail — mobile always shows the full drawer below,
          regardless of this preference, so it's gated with plain conditional
          rendering (not a responsive class) plus `hidden md:flex` as a belt-
          and-suspenders guard against a flash at the md breakpoint */}
      {collapsed && (
        <aside
          aria-label={t('sidebar.drawerLabel')}
          className="hidden md:flex z-drawer h-full w-16 shrink-0 flex-col items-center bg-[var(--surface)] border-r border-[var(--border)] py-3 gap-1"
        >
          <button type="button" onClick={onToggleCollapse} className={railBtn} aria-label={t('sidebar.expand')} title={t('sidebar.expand')}>
            <Logo size={22} />
          </button>
          <button
            type="button"
            onClick={onNew}
            className="mt-2 w-11 h-11 grid place-items-center rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] hover:brightness-110 transition duration-fast shadow-raised"
            aria-label={t('sidebar.newChat')}
            title={t('sidebar.newChat')}
          >
            <Icon.Plus size={18} />
          </button>
          <button type="button" onClick={onOpenHistory} className={railBtn} aria-label={t('sidebar.search')} title={t('sidebar.search')}>
            <Icon.Search size={18} />
          </button>
          {onOpenProjects && (
            <button
              type="button"
              onClick={onOpenProjects}
              className={railBtn}
              aria-label={t('projects.nav')}
              title={t('projects.nav')}
              aria-current={projectsActive ? 'page' : undefined}
            >
              <Icon.Folder size={18} />
            </button>
          )}
          {onOpenAgents && (
            <button
              type="button"
              onClick={onOpenAgents}
              className={railBtn}
              aria-label={t('agents.nav')}
              title={t('agents.nav')}
              aria-current={agentsActive ? 'page' : undefined}
            >
              <Icon.Play size={18} />
            </button>
          )}
          {onOpenCosts && (
            <button
              type="button"
              onClick={onOpenCosts}
              className={railBtn}
              aria-label={t('sidebar.costs')}
              title={t('sidebar.costs')}
              aria-current={costsActive ? 'page' : undefined}
            >
              <Icon.Gauge size={18} />
            </button>
          )}
          <div className="flex-1" />
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className={railBtn} aria-label={t('sidebar.openSettings')} title={t('sidebar.openSettings')}>
              <Icon.Settings size={18} />
            </button>
          )}
          <div className="w-11 h-11 grid place-items-center" title={email}>
            <Avatar email={email} />
            <span className="sr-only">{t('sidebar.account', { email: email || '' })}</span>
          </div>
        </aside>
      )}

      {open && (
        // above the app header (z-dropdown): before, the header painted over the
        // drawer and hid its brand row and close button on phones
        <div aria-hidden className="fixed inset-0 z-modal bg-scrim md:hidden animate-fade-in" onClick={onClose} />
      )}
      {/* overlay mode (expanded Studio on desktop): the drawer floats OVER the
          narrow chat column instead of squeezing it; clicking the scrim tucks
          it back into the rail */}
      {overlay && !collapsed && (
        <div aria-hidden className="hidden md:block fixed inset-0 z-dropdown bg-black/30" onClick={onToggleCollapse} />
      )}
      {/* a div with an explicit role: it is a landmark (complementary) in the
          layout and a modal dialog while the mobile drawer is open, and
          <aside> does not allow the dialog role */}
      <div
        ref={drawerRef}
        id="app-sidebar"
        aria-label={t('sidebar.drawerLabel')}
        role={drawerModal ? 'dialog' : 'complementary'}
        aria-modal={drawerModal ? 'true' : undefined}
        className={`fixed z-modal h-full w-[280px] shrink-0 flex flex-col bg-[var(--surface)] border-r border-[var(--border)] transition-transform duration-base ease-standard ${
          overlay ? 'md:shadow-modal' : 'md:z-drawer md:static'
        } ${drawerModal ? 'shadow-modal' : ''} ${collapsed ? 'md:hidden' : ''} ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
      >
        {/* brand — clicking the logo/name goes home (starts a new chat) */}
        <div className="flex items-center gap-2 pl-3 pr-2 h-14 border-b border-[var(--border)]">
          <button
            type="button"
            onClick={onNew}
            className="flex items-center gap-2.5 p-1.5 rounded-control hover:bg-[var(--surface-3)] transition-colors duration-fast"
            title={t('sidebar.home')}
          >
            <Logo size={26} />
            <span className="font-extrabold tracking-tight text-body leading-none">
              AI <span className="prism-text">Prism</span>
            </span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto md:hidden w-11 h-11 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
            aria-label={t('sidebar.close')}
            title={t('sidebar.close')}
          >
            <Icon.Close size={18} />
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`ml-auto hidden md:grid ${iconBtn}`}
            aria-label={t('sidebar.collapse')}
            title={t('sidebar.collapse')}
          >
            <Icon.ChevronLeft size={16} />
          </button>
        </div>

        {/* first: new chat, then search */}
        <div className="p-3 space-y-1">
          <button
            ref={newChatRef}
            type="button"
            onClick={onNew}
            className="w-full min-h-11 flex items-center gap-2 justify-center rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] hover:brightness-110 font-semibold text-body transition duration-fast shadow-raised"
          >
            <Icon.Plus size={18} /> {t('sidebar.newChat')}
          </button>
          <button
            type="button"
            onClick={onOpenHistory}
            className="w-full min-h-10 flex items-center gap-2.5 rounded-control px-3 text-body font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors duration-fast"
          >
            <Icon.Search size={17} /> {t('sidebar.search')}
          </button>
          {onOpenProjects && (
            <button
              type="button"
              onClick={onOpenProjects}
              aria-current={projectsActive ? 'page' : undefined}
              className={`w-full min-h-10 flex items-center gap-2.5 rounded-control px-3 text-body font-medium transition-colors duration-fast ${
                projectsActive ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
            >
              <Icon.Folder size={17} /> {t('projects.nav')}
            </button>
          )}
          {onOpenAgents && (
            <button
              type="button"
              onClick={onOpenAgents}
              aria-current={agentsActive ? 'page' : undefined}
              className={`w-full min-h-10 flex items-center gap-2.5 rounded-control px-3 text-body font-medium transition-colors duration-fast ${
                agentsActive ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
            >
              <Icon.Play size={17} /> {t('agents.nav')}
            </button>
          )}
          {/* admins only (Shell passes onOpenCosts just for them) */}
          {onOpenCosts && (
            <button
              type="button"
              onClick={onOpenCosts}
              aria-current={costsActive ? 'page' : undefined}
              className={`w-full min-h-10 flex items-center gap-2.5 rounded-control px-3 text-body font-medium transition-colors duration-fast ${
                costsActive ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
            >
              <Icon.Gauge size={17} /> {t('sidebar.costs')}
            </button>
          )}
        </div>

        {/* middle: the conversations */}
        <nav aria-label={t('sidebar.navLabel')} className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
          {sessionsLoading ? (
            <SidebarSkeleton label={t('sidebar.loading')} />
          ) : sessions.length === 0 ? (
            <div className="mx-1 mt-2 rounded-card border border-dashed border-[var(--border)] px-4 py-5 text-center">
              <p className="text-body font-medium text-[var(--text)]">{t('sidebar.empty')}</p>
              <p className="mt-1 text-label text-[var(--muted)]">{t('sidebar.emptyHint')}</p>
              <button
                type="button"
                onClick={onNew}
                className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-control px-3 text-label font-semibold text-[var(--accent-text)] hover:bg-[var(--accent-soft)] transition-colors duration-fast"
              >
                <Icon.Plus size={14} /> {t('sidebar.startFirst')}
              </button>
            </div>
          ) : null}
          {!sessionsLoading &&
            projectGroups.map((pg) => {
              const hid = `pg-${pg.project.id}`
              const pname = pg.project.name || t('projects.unnamed')
              return (
                <div key={hid} role="group" aria-labelledby={hid} data-testid="sidebar-project-group">
                  <div className="flex items-center gap-1 pr-1">
                    <h2 id={hid} className="flex-1 min-w-0 px-3 pt-1 pb-1 text-caption font-semibold uppercase tracking-wide text-[var(--faint)] flex items-center gap-1.5">
                      <Icon.Folder size={11} className="shrink-0" />
                      <button type="button" onClick={() => onOpenProject?.(pg.project.id)} className="truncate normal-case tracking-normal text-left hover:text-[var(--text)] max-md:min-h-11 [@media(pointer:coarse)]:min-h-11" title={pname}>
                        {pname}
                      </button>
                    </h2>
                    {pg.project.role && (
                      <button
                        type="button"
                        onClick={() => onNewChatInProject?.(pg.project.id)}
                        className={`${iconBtn} [@media(hover:none)]:w-11 [@media(hover:none)]:h-11`}
                        aria-label={t('projects.newChatIn', { name: pname })}
                        title={t('projects.newChat')}
                      >
                        <Icon.Plus size={14} />
                      </button>
                    )}
                  </div>
                  <ul>{pg.items.map(renderRow)}</ul>
                </div>
              )
            })}
          {!sessionsLoading &&
            groups.map((grp) => (
              <div key={grp.key} role="group" aria-labelledby={`sg-${grp.key}`}>
                <h2 id={`sg-${grp.key}`} className="px-3 pt-1 pb-1 text-caption font-semibold uppercase tracking-wide text-[var(--faint)]">
                  {t(grp.key)}
                </h2>
                <ul>
                  {grp.items.map(renderRow)}
                </ul>
              </div>
            ))}
        </nav>

        {/* last: the account and Settings, bottom-left */}
        <div className="border-t border-[var(--border)] px-3 pt-2 pb-3 space-y-2">
          <a
            href="https://www.databricks.com/product/machine-learning/foundation-models"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-1 py-1 text-caption text-[var(--faint)] hover:text-[var(--muted)] transition-colors duration-fast"
          >
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            {t('sidebar.poweredBy')}
          </a>
          <div className="flex items-center gap-2">
            <Avatar email={email} />
            <div className="min-w-0 flex-1">
              <span className="sr-only">{t('sidebar.account', { email: email || '' })}</span>
              <div aria-hidden className="text-label font-medium truncate" title={email}>
                {email}
              </div>
            </div>
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="shrink-0 w-11 h-11 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast"
                aria-label={t('sidebar.openSettings')}
                title={t('sidebar.openSettings')}
              >
                <Icon.Settings size={19} />
              </button>
            )}
          </div>
        </div>
      </div>
      {moving && (
        <MoveToProjectDialog
          session={moving}
          projects={projects}
          onClose={() => setMoving(null)}
          onMoved={async () => {
            await onProjectsChanged?.()
          }}
        />
      )}
    </>
  )
}
