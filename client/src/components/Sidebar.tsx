import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Logo from './Logo.tsx'
import * as Icon from './Icons.tsx'
import Skeleton from './Skeleton.tsx'
import { timeGroupKey } from '../lib/date.ts'
import { useI18n } from '../lib/i18n.tsx'
import { fmtCost } from './CostBadge.tsx'
import type { MonthSpend } from './CostMeter.tsx'
import { projectDotClass } from '../lib/projectColor.ts'
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
// - desktop collapsed (or at <=1100 px): a 64 px rail of 44 px icon buttons with
//   tooltips. Hovering or focusing the rail "peeks": the full sidebar floats over
//   the content until the pointer and focus leave it (Esc closes it);
// - mobile (<=760 px): an off-canvas drawer that behaves as a modal dialog while open
//   (focus moves in and is trapped, Esc and the scrim close it, focus returns to
//   the button that opened it) and is inert while closed, so Tab never lands on
//   invisible controls.

const MOBILE_QUERY = '(max-width: 760px)'
const NARROW_QUERY = '(max-width: 1100px)'
const PEEK_CLOSE_MS = 160
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

function Avatar({ email, name, className = '' }: { email?: string; name?: string | null; className?: string }) {
  return (
    <div
      aria-hidden
      className={`shrink-0 w-8 h-8 rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center text-label font-semibold ${className}`}
    >
      {(name || email || '?')[0]!.toUpperCase()}
    </div>
  )
}

const railBtn =
  'w-11 h-11 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors duration-fast'
const iconBtn =
  'shrink-0 grid place-items-center w-8 h-8 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast'
// the "New chat" button: a raised card in the mockup, not the primary action of the screen
const newChatBtn =
  'border border-[var(--border)] bg-[var(--raised)] text-[var(--text)] hover:border-[var(--muted)] shadow-raised transition duration-fast'
const navItem = (active: boolean) =>
  `w-full min-h-10 flex items-center gap-2.5 rounded-control px-3 text-label font-medium transition-colors duration-fast ${
    active ? 'bg-[var(--raised)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border)]' : 'text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
  }`

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
  /** this month's spend at list price (GET /api/usage/summary); null hides the card */
  monthSpend?: MonthSpend | null
  onToggleTheme?: () => void
  /** the resolved theme, for the toggle's icon and name */
  isDark?: boolean
  /** first name derived from the e-mail (same rule as Welcome); null shows the e-mail */
  displayName?: string | null
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
  monthSpend = null,
  onToggleTheme,
  isDark = false,
  displayName = null,
}: SidebarProps) {
  // useI18n() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const { t, locale } = useI18n() as { t: Translate; locale: string }
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [moving, setMoving] = useState<SidebarSession | null>(null)
  const [peek, setPeek] = useState(false)
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const isNarrow = useMediaQuery(NARROW_QUERY)
  // desktop rail: the saved preference, or a window too narrow to dock 256 px
  const railMode = !isMobile && (collapsed || isNarrow)
  const drawerRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const newChatRef = useRef<HTMLButtonElement>(null)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Esc hands focus to the rail's button; that focus must not reopen the peek it just closed
  const skipFocusPeek = useRef(false)
  // App passes inline arrows; keep the latest without re-running the effects
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useThemeTransition()

  const drawerModal = isMobile && open
  const peeking = railMode && peek

  // peek: open on pointer or focus over the rail or the floating panel, close a
  // moment after both lose it (the delay bridges the gap between them)
  const keepPeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = null
    if (railMode) setPeek(true)
  }
  const focusPeek = () => {
    if (skipFocusPeek.current) {
      skipFocusPeek.current = false
      return
    }
    keepPeek()
  }
  const leavePeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => setPeek(false), PEEK_CLOSE_MS)
  }
  const leaveOnBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (next && (drawerRef.current?.contains(next) || railRef.current?.contains(next))) return
    leavePeek()
  }
  useEffect(() => () => void (peekTimer.current && clearTimeout(peekTimer.current)), [])
  useEffect(() => {
    if (!railMode) setPeek(false)
  }, [railMode])
  // Esc closes the peek and hands focus back to the rail
  useEffect(() => {
    if (!peeking) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setPeek(false)
      if (drawerRef.current?.contains(document.activeElement)) {
        skipFocusPeek.current = true
        expandRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [peeking])
  // a navigation made from the floating panel puts it away
  const go =
    <A extends unknown[]>(fn?: (...a: A) => void) =>
    (...a: A) => {
      setPeek(false)
      fn?.(...a)
    }
  // a rail made by the window width (not the saved preference) cannot be docked: its expand button peeks instead
  const expand = () => (collapsed && !isNarrow ? onToggleCollapse() : setPeek(true))

  // closed mobile drawer: off-screen, so take it out of the tab order and the
  // accessibility tree. (The desktop panel parked behind the rail does the same
  // with `invisible`, not `inert`: a page-wide [inert] is the signal of a modal.)
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

  const monthName = new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date())
  const themeLabel = isDark ? t('sidebar.themeToLight') : t('sidebar.themeToDark')

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
          active ? 'bg-[var(--raised)] shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-[var(--surface-3)]'
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
            className="flex-1 min-w-0 bg-transparent text-label px-3 py-2 border-b border-[var(--accent)]"
          />
        ) : (
          // full width for the title; it gives up room on the
          // right only while the row actions are visible
          // (hover, keyboard focus inside the row, touch screens)
          <button
            type="button"
            onClick={() => go(onSelect)(sNode.id)}
            aria-current={active ? 'page' : undefined}
            className={`flex-1 min-w-0 min-h-9 text-left text-label py-2 pl-3 truncate rounded-control ${
              active ? 'text-[var(--text)]' : 'text-[var(--muted)] group-hover:text-[var(--text)]'
            } ${
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

  const themeButton = (cls: string): ReactNode =>
    onToggleTheme && (
      <button type="button" onClick={onToggleTheme} className={cls} aria-label={themeLabel} title={themeLabel}>
        {isDark ? <Icon.Sun size={18} /> : <Icon.Moon size={18} />}
      </button>
    )

  const spendFigure = monthSpend && (
    <strong className={`text-label font-semibold tabular-nums ${monthSpend.stale ? 'text-[var(--muted)]' : 'text-[var(--text)]'}`}>
      {monthSpend.estimated ? '≈' : ''}
      {monthSpend.amountUsd > 0 ? fmtCost(monthSpend.amountUsd) : '$0.00'}
    </strong>
  )
  const spendCard = monthSpend && (
    <div data-testid="sidebar-spend" className="rounded-card px-3 py-2" title={t('sidebar.spendNote')}>
      <div className="flex items-baseline justify-between gap-2 text-caption text-[var(--muted)]">
        <span className="truncate">{t('sidebar.spendMonth', { month: monthName })}</span>
        {monthSpend.loading ? <Skeleton className="h-3 w-12" rounded="rounded-full" /> : monthSpend.error && !monthSpend.stale ? null : spendFigure}
      </div>
      {monthSpend.error && !monthSpend.loading ? (
        // a failed load keeps the card: the last figure (muted, stale) and a way to try again
        <div role="status" className="mt-0.5 flex items-center justify-between gap-2 text-caption text-[var(--muted)]">
          <span>{t(monthSpend.stale ? 'sidebar.spendStale' : 'sidebar.spendError')}</span>
          <button
            type="button"
            onClick={monthSpend.retry}
            className="shrink-0 min-h-6 rounded-badge font-medium text-[var(--accent-text)] underline underline-offset-2 hover:opacity-80 [@media(pointer:coarse)]:min-h-11"
          >
            {t('sidebar.spendRetry')}
          </button>
        </div>
      ) : (
        <div className="mt-0.5 text-caption text-[var(--faint)]">{t('sidebar.spendNote')}</div>
      )}
    </div>
  )

  return (
    <>
      {/* collapsed desktop rail — mobile always shows the full drawer below,
          regardless of this preference, so it's gated with plain conditional
          rendering (not a responsive class). Pointer or focus on it peeks the
          full sidebar over the content. */}
      {railMode && (
        <aside
          ref={railRef}
          aria-label={t('sidebar.drawerLabel')}
          onMouseEnter={keepPeek}
          onMouseLeave={leavePeek}
          onFocus={focusPeek}
          onBlur={leaveOnBlur}
          className="flex z-drawer h-full w-16 shrink-0 flex-col items-center bg-[var(--bg)] border-r border-[var(--border-soft)] py-3 gap-1"
        >
          <button
            ref={expandRef}
            type="button"
            onClick={expand}
            className={railBtn}
            aria-label={t('sidebar.expand')}
            title={t('sidebar.expand')}
            aria-expanded={peeking}
            aria-controls="app-sidebar"
          >
            <Logo size={22} />
          </button>
          <button
            type="button"
            onClick={onNew}
            className={`mt-2 w-11 h-11 grid place-items-center rounded-control ${newChatBtn}`}
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
          {themeButton(railBtn)}
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className={railBtn} aria-label={t('sidebar.openSettings')} title={t('sidebar.openSettings')}>
              <Icon.Settings size={18} />
            </button>
          )}
          <div className="w-11 h-11 grid place-items-center" title={email}>
            <Avatar email={email} name={displayName} />
            <span className="sr-only">{t('sidebar.account', { email: email || '' })}</span>
          </div>
        </aside>
      )}

      {open && (
        // above the app header (z-dropdown): before, the header painted over the
        // drawer and hid its brand row and close button on phones
        <div aria-hidden className="fixed inset-0 z-modal bg-scrim min-[761px]:hidden animate-fade-in" onClick={onClose} />
      )}
      {/* overlay mode (expanded Studio on desktop): the drawer floats OVER the
          narrow chat column instead of squeezing it; clicking the scrim tucks
          it back into the rail */}
      {overlay && !railMode && (
        <div aria-hidden className="hidden min-[761px]:block fixed inset-0 z-dropdown bg-black/30" onClick={onToggleCollapse} />
      )}
      {/* a div with an explicit role: it is a landmark (complementary) in the
          layout and a modal dialog while the mobile drawer is open, and
          <aside> does not allow the dialog role. On desktop with a rail it is
          the peek panel: parked off-screen (and inert) until the rail is
          hovered or focused. */}
      <div
        ref={drawerRef}
        id="app-sidebar"
        aria-label={t('sidebar.drawerLabel')}
        role={drawerModal ? 'dialog' : 'complementary'}
        aria-modal={drawerModal ? 'true' : undefined}
        onMouseEnter={railMode ? keepPeek : undefined}
        onMouseLeave={railMode ? leavePeek : undefined}
        onFocus={railMode ? focusPeek : undefined}
        onBlur={railMode ? leaveOnBlur : undefined}
        className={`fixed z-modal h-full w-64 shrink-0 flex flex-col bg-[var(--bg)] border-r border-[var(--border-soft)] transition-[transform,visibility] duration-base ease-standard motion-reduce:transition-none ${
          overlay || railMode ? 'min-[761px]:shadow-modal' : 'min-[761px]:z-drawer min-[761px]:static'
        } ${drawerModal ? 'shadow-modal' : ''} ${open ? 'translate-x-0' : '-translate-x-full'} ${
          !railMode ? 'min-[761px]:translate-x-0' : peek ? 'min-[761px]:translate-x-0' : 'min-[761px]:-translate-x-full min-[761px]:shadow-none min-[761px]:invisible'
        }`}
      >
        {/* brand — clicking the logo/name goes home (starts a new chat) */}
        <div className="flex items-center gap-2 pl-3 pr-2 pt-3 pb-2">
          <button
            type="button"
            onClick={go(onNew)}
            className="flex items-center gap-2.5 p-1 rounded-control hover:bg-[var(--surface-3)] transition-colors duration-fast"
            title={t('sidebar.home')}
          >
            <span className="grid place-items-center w-8 h-8 rounded-control border border-[var(--border)] bg-[var(--raised)] text-[var(--text)]">
              <Logo size={22} />
            </span>
            <span className="font-semibold tracking-tight text-body leading-none">AI Prism</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto min-[761px]:hidden w-11 h-11 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
            aria-label={t('sidebar.close')}
            title={t('sidebar.close')}
          >
            <Icon.Close size={18} />
          </button>
          {!railMode && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className={`ml-auto hidden min-[761px]:grid ${iconBtn}`}
              aria-label={t('sidebar.collapse')}
              title={t('sidebar.collapse')}
            >
              <Icon.ChevronLeft size={16} />
            </button>
          )}
        </div>

        {/* first: new chat, then search */}
        <div className="px-3 pb-1 space-y-1">
          <button
            ref={newChatRef}
            type="button"
            onClick={go(onNew)}
            className={`w-full min-h-11 flex items-center gap-2 rounded-control px-3 font-medium text-label ${newChatBtn}`}
          >
            <Icon.Plus size={18} /> {t('sidebar.newChat')}
          </button>
          <button
            type="button"
            onClick={go(onOpenHistory)}
            className="w-full min-h-10 flex items-center gap-2.5 rounded-control px-3 text-label text-[var(--faint)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast"
          >
            <Icon.Search size={17} /> {t('sidebar.search')}
          </button>
          <div className="pt-1 space-y-px">
            {onOpenProjects && (
              <button type="button" onClick={go(onOpenProjects)} aria-current={projectsActive ? 'page' : undefined} className={navItem(projectsActive)}>
                <Icon.Folder size={17} /> {t('projects.nav')}
              </button>
            )}
            {onOpenAgents && (
              <button type="button" onClick={go(onOpenAgents)} aria-current={agentsActive ? 'page' : undefined} className={navItem(agentsActive)}>
                <Icon.Play size={17} /> {t('agents.nav')}
              </button>
            )}
            {/* admins only (Shell passes onOpenCosts just for them) */}
            {onOpenCosts && (
              <button type="button" onClick={go(onOpenCosts)} aria-current={costsActive ? 'page' : undefined} className={navItem(costsActive)}>
                <Icon.Gauge size={17} /> {t('sidebar.costs')}
              </button>
            )}
          </div>
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
                onClick={go(onNew)}
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
                    <h2 id={hid} className="flex-1 min-w-0 px-3 pt-1 pb-1 text-caption font-medium text-[var(--muted)] flex items-center gap-2">
                      <span aria-hidden data-sidebar-project-dot className={`shrink-0 w-2 h-2 rounded-sm ${projectDotClass(pg.project.id)}`} />
                      <button type="button" onClick={go(() => onOpenProject?.(pg.project.id))} className="truncate text-left hover:text-[var(--text)] max-md:min-h-11 [@media(pointer:coarse)]:min-h-11" title={pname}>
                        {pname}
                      </button>
                    </h2>
                    {pg.project.role && (
                      <button
                        type="button"
                        onClick={go(() => onNewChatInProject?.(pg.project.id))}
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
                <h2 id={`sg-${grp.key}`} className="px-3 pt-1 pb-1 text-caption font-medium text-[var(--faint)]">
                  {t(grp.key)}
                </h2>
                <ul>
                  {grp.items.map(renderRow)}
                </ul>
              </div>
            ))}
        </nav>

        {/* last: this month's spend, then the account, theme and Settings, bottom-left */}
        <div className="border-t border-[var(--border-soft)] px-3 pt-2 pb-3 space-y-1">
          {spendCard}
          <a
            href="https://www.databricks.com/product/machine-learning/foundation-models"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-1 text-caption text-[var(--faint)] hover:text-[var(--muted)] transition-colors duration-fast"
          >
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            {t('sidebar.poweredBy')}
          </a>
          <div className="flex items-center gap-2 pl-1">
            <Avatar email={email} name={displayName} />
            <div className="min-w-0 flex-1 leading-tight">
              <span className="sr-only">{t('sidebar.account', { email: email || '' })}</span>
              <div aria-hidden className="text-label font-medium truncate" title={email}>
                {displayName || email}
              </div>
              {displayName && (
                <div aria-hidden className="text-caption text-[var(--muted)] truncate" title={email}>
                  {email}
                </div>
              )}
            </div>
            {themeButton('shrink-0 w-11 h-11 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast')}
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
