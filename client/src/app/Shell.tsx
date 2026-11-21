import type { Dispatch, SetStateAction } from 'react'
import Sidebar from '../components/Sidebar.jsx'
import HistoryPage from '../components/HistoryPage.jsx'
import CostsPage from '../components/costs/CostsPage.jsx'
import SettingsModal from '../components/SettingsModal.jsx'
import VoiceOverlay from '../components/VoiceOverlay.jsx'
import DeckStudio from '../components/DeckStudio.jsx'
import SpreadsheetStudio from '../components/SpreadsheetStudio.jsx'
import DocumentStudio from '../components/DocumentStudio.jsx'
import ProjectsPage from '../components/projects/ProjectsPage.jsx'
import ProjectDetail from '../components/projects/ProjectDetail.jsx'
import { useProjectsList } from '../components/projects/useProjectsList.js'
import { mergeProjectChats, useProjectChats } from '../components/projects/useProjectChats.js'
import ChatView from './ChatView.tsx'
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
  const routeKey = `${s.view}:${s.currentId ?? ''}:${s.navKey}`
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        open={layout.sidebarOpen}
        email={cfg.email}
        sessions={sidebarSessions}
        sessionsLoading={s.sessionsLoading}
        currentId={s.currentId}
        onNew={() => (closeDrawer(), s.newChat())}
        onSelect={(id: string | number) => (closeDrawer(), s.openSession(id))}
        onDelete={s.removeSession}
        deletingId={s.deletingId}
        onRename={s.renameSession}
        onClose={closeDrawer}
        onOpenHistory={s.openHistory}
        // admins only: the page itself still says "admins only" to anyone else
        onOpenCosts={cfg.isAdmin ? () => (closeDrawer(), s.openCosts()) : undefined}
        costsActive={s.view === 'costs'}
        projects={projects.projects}
        onOpenProjects={() => (closeDrawer(), s.openProjects())}
        projectsActive={s.view === 'projects'}
        onOpenProject={(id: string | null) => (closeDrawer(), s.openProjects(id))}
        onNewChatInProject={(id: string | number) => (closeDrawer(), s.newChatInProject(id))}
        onProjectsChanged={refreshProjects}
        onOpenSettings={() => (closeDrawer(), cfg.openSettings())}
        collapsed={layout.sidebarCollapsed}
        onToggleCollapse={layout.toggleSidebarCollapse}
        // expanded studio leaves only a narrow chat column — expanding the
        // sidebar there overlays the chat instead of squeezing it further
        overlay={layout.focused}
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
      ) : s.view === 'costs' ? (
        <CostsPage onBack={s.closeHistory} />
      ) : s.view === 'history' ? (
        <HistoryPage
          // temporary chats are not part of the history (W3-6)
          sessions={s.sessions.filter((x) => !x.ephemeral)}
          sessionsLoading={s.sessionsLoading}
          currentId={s.currentId}
          onSelect={s.openSession}
          onNew={s.newChat}
          onDelete={s.removeSession}
          deletingId={s.deletingId}
          onRename={s.renameSession}
          onBack={s.closeHistory}
          onSearch={s.doSearch}
          searchResults={s.searchResults}
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
        onModelsChanged={cfg.refreshModels}
        onCreateWithClaude={onCreateSkill}
        personal={personal}
      />

      <VoiceOverlay open={voice.open} onClose={() => voice.setOpen(false)} onSend={(text: string) => turn.sendMessage(text, [])} />

      <DeckStudio
        open={!!studios.deckStudioId}
        deckId={studios.deckStudioId === 'streaming' ? null : studios.deckStudioId}
        streamingDeck={studios.deckStudioId === 'streaming' ? studios.streamingDeck : null}
        onClose={studios.closeDeck}
        pushToast={toasts.notifyError}
        focus={layout.deckFocus}
        onToggleFocus={layout.toggleDeckFocus}
        onEditModeChange={layout.setDeckEditFullscreen}
        onDeckSession={studios.setDeckSessionId}
        models={cfg.models}
        model={cfg.model}
      />
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

      <Toasts toasts={toasts.toasts} onDismiss={toasts.dismissToast} />
    </div>
  )
}
