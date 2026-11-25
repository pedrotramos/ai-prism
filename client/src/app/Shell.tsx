import { useEffect, useRef, useState } from 'react'
import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import Sidebar from '../components/Sidebar.tsx'
import HistoryPage from '../components/HistoryPage.tsx'
import CostsPage from '../components/costs/CostsPage.tsx'
import SettingsModal from '../components/SettingsModal.tsx'
import VoiceOverlay from '../components/VoiceOverlay.tsx'
import DeckStudio from '../components/DeckStudio.tsx'
import SpreadsheetStudio from '../components/SpreadsheetStudio.tsx'
import DocumentStudio from '../components/DocumentStudio.tsx'
import AgentsPanel from '../components/agents/AgentsPanel.tsx'
import { useAgentsStatus } from '../components/agents/useAgentsStatus.ts'
import ProjectsPage from '../components/projects/ProjectsPage.tsx'
import ProjectDetail from '../components/projects/ProjectDetail.tsx'
import MoveToProjectDialog from '../components/projects/MoveToProjectDialog.tsx'
import { useIsOverlay } from '../components/studio/StudioChrome.tsx'
import { useProjectsList } from '../components/projects/useProjectsList.ts'
import { mergeProjectChats, useProjectChats } from '../components/projects/useProjectChats.ts'
import { useMonthSpend } from '../components/CostMeter.tsx'
import { firstNameFromEmail } from '../components/welcome/suggestions.ts'
import ChatView from './ChatView.tsx'
import { planShare } from './shareChat.ts'
import type { ShareSession } from './shareChat.ts'
import Toasts from './Toasts.tsx'
import type { ToastsState } from './Toasts.tsx'
import type { SessionsState } from './hooks/useSessions.ts'
import type { SettingsState } from './hooks/useSettingsState.ts'
import type { StudiosState } from './hooks/useStudios.ts'
import type { DeckFocusState } from './hooks/useDeckFocus.ts'
import type { TurnActions } from './hooks/useTurnStream.ts'

// Layout of the app: sidebar, the main view (chat, history or the admin Costs page), the Settings
// dialog, voice mode, the three artifact Studios and the toast stack. State
// comes from the hooks App.tsx wires together; this file only places things.
/** The personal preferences the Settings dialog edits: App builds it from the settings state plus the UI language. */
export type ShellPersonal = Pick<
  SettingsState,
  'theme' | 'setTheme' | 'responseLang' | 'setResponseLang' | 'notify' | 'setNotify' | 'imageModel' | 'setImageModel' | 'imageModels' | 'imageModelDefaultId'
> & { uiLang: string; setUiLang: Dispatch<SetStateAction<string>> }

/** The theme actually painted: 'system' follows the OS live, like useSettingsState does. */
function useResolvedDark(theme: string): boolean {
  const query = '(prefers-color-scheme: dark)'
  const read = () => (theme === 'system' ? !!window.matchMedia?.(query).matches : theme === 'dark')
  const [dark, setDark] = useState(read)
  useEffect(() => {
    setDark(read())
    if (theme !== 'system') return undefined
    const mq = window.matchMedia?.(query)
    if (!mq) return undefined
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])
  return dark
}

/**
 * After "Share" the Projects screen opens on the project: once its members form is on screen, scroll to it and
 * put the cursor on its first control (the same target as the page's own "Share project" button). The page loads
 * its data first, so this waits for the form for a few seconds and then gives up quietly.
 */
function useFocusMembers(projectId: string | null, done: () => void) {
  const doneRef = useRef(done)
  doneRef.current = done
  useEffect(() => {
    if (!projectId) return undefined
    let raf = 0
    const until = Date.now() + 5000
    const tick = () => {
      const first = document.querySelector<HTMLElement>('[data-share-first]')
      if (first) {
        const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        first.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' })
        first.focus({ preventScroll: true })
        doneRef.current()
        return
      }
      if (Date.now() > until) return doneRef.current()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [projectId])
}

interface ShellProps {
  s: SessionsState
  cfg: SettingsState
  turn: TurnActions
  studios: StudiosState
  layout: DeckFocusState
  toasts: ToastsState
  voice: { open: boolean; setOpen: Dispatch<SetStateAction<boolean>> }
  personal: ShellPersonal
  onCreateSkill: () => void
  speakText: (text: string) => void
}

export default function Shell({ s, cfg, turn, studios, layout, toasts, voice, personal, onCreateSkill, speakText }: ShellProps) {
  const closeDrawer = () => layout.setSidebarOpen(false)
  // the caller's projects: the sidebar groups chats by them, the Projects screen manages them
  const projects = useProjectsList()
  // chats other members made in the caller's projects (GET /api/sessions has only the caller's own)
  const projectChats = useProjectChats(projects.projects, s.sessions, !projects.loading && !s.sessionsLoading)
  const sidebarSessions = mergeProjectChats(s.sessions, projectChats)
  // useProjectsList() is still JS: its list is inferred as never[], so the row shape is stated here
  const projectNames = new Map((projects.projects as { id: string | number; name: string }[]).map((p) => [String(p.id), p.name]))
  // a chat moved into a project, or a project created/renamed/deleted: both lists change
  const refreshProjects = () => Promise.all([projects.reload(), s.loadSessions()])
  // scheduled agents (W4-4e): everything below is hidden unless the server says the feature is on (fails closed)
  const agents = useAgentsStatus()
  const monthSpend = useMonthSpend(s.streaming)
  const isDark = useResolvedDark(String(personal.theme))
  const overlay = useIsOverlay() // ≤ 1100 px: the deck panel floats over the chat and gets a scrim

  // Share (Q4-B): put the open chat in a project, then open that project's members
  const [moving, setMoving] = useState<ShareSession | null>(null)
  const [membersFor, setMembersFor] = useState<string | null>(null)
  useFocusMembers(s.view === 'projects' && s.projectId != null && String(s.projectId) === membersFor ? membersFor : null, () => setMembersFor(null))
  const currentRow = sidebarSessions.find((x) => String(x.id) === String(s.currentId)) as (ShareSession & { title?: string | null }) | undefined
  const sharePlan = planShare({ session: currentRow ?? null, projects: projects.projects as unknown[], email: cfg.email })
  const closeStudios = () => {
    studios.closeDeck()
    studios.setSpreadsheetStudioId(null)
    studios.setDocumentStudioId(null)
  }
  const openMembers = (projectId: string) => {
    closeStudios()
    setMembersFor(projectId)
    s.openProjects(projectId)
  }
  const share = () => {
    if (sharePlan.kind === 'open-members') return openMembers(sharePlan.projectId)
    if (sharePlan.kind === 'choose-project' && currentRow) return setMoving(currentRow)
    if (sharePlan.kind === 'no-projects') return (closeStudios(), s.openProjects())
  }
  const onShare = sharePlan.kind === 'unavailable' ? undefined : share
  const routeKey = `${s.view}:${s.currentId ?? ''}:${s.navKey}`
  return (
    <div className="flex h-full overflow-hidden [&>main]:bg-[var(--surface)]">
      <Sidebar
        open={layout.sidebarOpen}
        email={cfg.email}
        sessions={sidebarSessions as unknown as ComponentProps<typeof Sidebar>['sessions']} // type-only: the merged rows keep the shape each list gave
        sessionsLoading={s.sessionsLoading}
        currentId={s.currentId as number | null} // type-only cast: Sidebar types ids as numbers, the hook as string | number
        onNew={() => (closeDrawer(), s.newChat())}
        onSelect={(id: string | number) => (closeDrawer(), s.openSession(id))}
        onDelete={s.removeSession}
        deletingId={s.deletingId as number | null}
        onRename={s.renameSession}
        onClose={closeDrawer}
        onOpenHistory={s.openHistory}
        // admins only: the page itself still says "admins only" to anyone else
        onOpenCosts={cfg.isAdmin ? () => (closeDrawer(), s.openCosts()) : undefined}
        costsActive={s.view === 'costs'}
        onOpenAgents={agents.enabled ? () => (closeDrawer(), s.openAgents()) : undefined}
        agentsActive={s.view === 'agents' && agents.enabled}
        projects={projects.projects as unknown as ComponentProps<typeof Sidebar>['projects']} // type-only: Sidebar types project ids as numbers
        onOpenProjects={() => (closeDrawer(), s.openProjects())}
        projectsActive={s.view === 'projects'}
        onOpenProject={(id: number) => (closeDrawer(), s.openProjects(id as unknown as string))} // type-only: project ids reach the hook as given, never converted
        onNewChatInProject={(id: string | number) => (closeDrawer(), s.newChatInProject(id))}
        onProjectsChanged={refreshProjects as unknown as () => Promise<void>} // type-only: the caller only awaits it
        onOpenSettings={() => (closeDrawer(), cfg.openSettings())}
        collapsed={layout.sidebarCollapsed}
        onToggleCollapse={layout.toggleSidebarCollapse}
        // expanded studio leaves only a narrow chat column — expanding the
        // sidebar there overlays the chat instead of squeezing it further
        overlay={layout.focused}
        monthSpend={monthSpend}
        isDark={isDark}
        // an explicit choice, the opposite of what is painted now ('system' becomes light or dark)
        onToggleTheme={() => personal.setTheme(isDark ? 'light' : 'dark')}
        displayName={firstNameFromEmail(cfg.email)}
      />

      {s.view === 'projects' && s.projectId ? (
        <ProjectDetail
          key={s.projectId}
          projectId={s.projectId}
          email={cfg.email}
          limits={projects.limits}
          onBack={() => s.openProjects()}
          onChanged={refreshProjects}
          onOpenChat={s.openSession}
          onNewChat={s.newChatInProject}
          onOpenMenu={() => layout.setSidebarOpen(true)}
        />
      ) : s.view === 'projects' ? (
        <ProjectsPage list={projects} onOpen={s.openProjects} onNewChat={s.newChatInProject} onBack={s.closeHistory} onOpenMenu={() => layout.setSidebarOpen(true)} />
      ) : s.view === 'agents' && agents.enabled ? (
        <AgentsPanel
          models={cfg.models}
          defaultModel={cfg.model || ''}
          uiLang={personal.uiLang}
          isAdmin={cfg.isAdmin}
          onOpenChat={s.openSession}
          onTryInChat={(draft) => (s.newChat(), s.setSystemPrompt(draft.instructions), s.setInput(draft.prompt))}
          onBack={s.closeHistory}
          onOpenMenu={() => layout.setSidebarOpen(true)}
        />
      ) : s.view === 'costs' ? (
        <CostsPage onBack={s.closeHistory} />
      ) : s.view === 'history' ? (
        <HistoryPage
          // temporary chats are not part of the history (W3-6)
          sessions={s.sessions.filter((x) => !x.ephemeral) as unknown as ComponentProps<typeof HistoryPage>['sessions']}
          sessionsLoading={s.sessionsLoading}
          currentId={s.currentId as number | null}
          onSelect={s.openSession}
          onNew={s.newChat}
          onDelete={s.removeSession}
          deletingId={s.deletingId as number | null}
          onRename={s.renameSession}
          onBack={s.closeHistory}
          onSearch={s.doSearch}
          searchResults={s.searchResults as ComponentProps<typeof HistoryPage>['searchResults']}
          searching={s.searching}
          projectNames={projectNames}
        />
      ) : (
        <ChatView
          s={s}
          cfg={cfg}
          turn={turn}
          studios={studios}
          layout={layout}
          routeKey={routeKey}
          projects={projects.projects}
          sharedSessions={sidebarSessions}
          onShare={onShare}
          speakText={speakText}
          onOpenMenu={() => layout.setSidebarOpen(true)}
          onOpenVoice={() => voice.setOpen(true)}
          notify={toasts.pushToast}
        />
      )}

      <SettingsModal
        open={cfg.settingsOpen}
        onClose={cfg.closeSettings}
        initialTab={cfg.settingsTab}
        systemPrompt={s.systemPrompt}
        setSystemPrompt={s.setSystemPrompt}
        isAdmin={cfg.isAdmin}
        agentsEnabled={agents.enabled}
        onAgentsChanged={agents.refresh}
        onModelsChanged={cfg.refreshModels}
        onCreateWithClaude={onCreateSkill}
        personal={personal as unknown as ComponentProps<typeof SettingsModal>['personal']}
        defaults={{ models: cfg.models, model: cfg.model, onModelChange: cfg.setModel, toolPolicy: cfg.toolPolicy }}
      />

      <VoiceOverlay
        open={voice.open}
        onClose={() => voice.setOpen(false)}
        onSend={(text: string) => turn.sendMessage(text, [])}
        // the active chat's model: its mark and name show in the overlay's hint line (undefined until the catalog loads)
        model={cfg.models.find((m) => m.id === cfg.model)}
      />

      {/* ≤ 1100 px the deck is a modal layer over the chat: this wrapper is its scrim. It sits ON the path to the
          studio, never beside it (the studio makes its siblings inert), and docked it takes no part in the layout. */}
      <div
        data-studio-scrim={overlay && !!studios.deckStudioId ? '' : undefined}
        className={overlay && studios.deckStudioId ? 'fixed inset-0 z-studio bg-scrim' : 'contents'}
        // a click, not a mousedown: the browser moves focus to <body> AFTER mousedown, which would undo the focus return
        onClick={(e) => {
          if (e.target !== e.currentTarget) return
          // the studio's own close path: it asks before dropping unsaved work
          e.currentTarget.querySelector<HTMLElement>('[data-studio-close]')?.click()
        }}
      >
      <DeckStudio
        open={!!studios.deckStudioId}
        deckId={studios.deckStudioId === 'streaming' ? null : studios.deckStudioId}
        streamingDeck={studios.deckStudioId === 'streaming' ? (studios.streamingDeck as unknown as ComponentProps<typeof DeckStudio>['streamingDeck']) : null}
        onClose={studios.closeDeck}
        pushToast={toasts.notifyError}
        focus={layout.deckFocus}
        onToggleFocus={layout.toggleDeckFocus}
        onEditModeChange={layout.setDeckEditFullscreen}
        onDeckSession={studios.setDeckSessionId as (sessionId: unknown) => void}
        onShare={onShare}
        models={cfg.models}
        model={cfg.model}
      />
      </div>
      <SpreadsheetStudio
        open={!!studios.spreadsheetStudioId}
        spreadsheetId={studios.spreadsheetStudioId}
        onClose={() => studios.setSpreadsheetStudioId(null)}
        pushToast={toasts.notifyError}
        models={cfg.models}
        model={cfg.model}
      />
      <DocumentStudio
        open={!!studios.documentStudioId}
        documentId={studios.documentStudioId}
        onClose={() => studios.setDocumentStudioId(null)}
        pushToast={toasts.notifyError}
        models={cfg.models}
        model={cfg.model}
      />

      {moving && (
        // above the studios (z-studio): the dialog opens from the deck panel's Share too
        <div className="relative z-dialog">
          <MoveToProjectDialog
            session={moving as ComponentProps<typeof MoveToProjectDialog>['session']}
            projects={projects.projects as unknown as ComponentProps<typeof MoveToProjectDialog>['projects']}
            onClose={() => setMoving(null)}
            onMoved={async (p) => {
              await refreshProjects()
              openMembers(String(p.id))
            }}
          />
        </div>
      )}

      <Toasts toasts={toasts.toasts} onDismiss={toasts.dismissToast} />
    </div>
  )
}
