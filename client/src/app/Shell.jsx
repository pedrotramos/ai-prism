import Sidebar from '../components/Sidebar.jsx'
import HistoryPage from '../components/HistoryPage.jsx'
import SettingsModal from '../components/SettingsModal.jsx'
import VoiceOverlay from '../components/VoiceOverlay.jsx'
import DeckStudio from '../components/DeckStudio.jsx'
import SpreadsheetStudio from '../components/SpreadsheetStudio.jsx'
import DocumentStudio from '../components/DocumentStudio.jsx'
import ChatView from './ChatView.jsx'
import Toasts from './Toasts.jsx'

// Layout of the app: sidebar, the main view (chat or history), the Settings
// dialog, voice mode, the three artifact Studios and the toast stack. State
// comes from the hooks App.jsx wires together; this file only places things.
export default function Shell({ s, cfg, turn, studios, layout, toasts, voice, personal, onCreateSkill, speakText }) {
  const closeDrawer = () => layout.setSidebarOpen(false)
  const routeKey = `${s.view}:${s.currentId ?? ''}:${s.navKey}`
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        open={layout.sidebarOpen}
        email={cfg.email}
        sessions={s.sessions}
        sessionsLoading={s.sessionsLoading}
        currentId={s.currentId}
        onNew={() => (closeDrawer(), s.newChat())}
        onSelect={(id) => (closeDrawer(), s.openSession(id))}
        onDelete={s.removeSession}
        deletingId={s.deletingId}
        onRename={s.renameSession}
        onClose={closeDrawer}
        onOpenHistory={s.openHistory}
        collapsed={layout.sidebarCollapsed}
        onToggleCollapse={layout.toggleSidebarCollapse}
        // expanded studio leaves only a narrow chat column — expanding the
        // sidebar there overlays the chat instead of squeezing it further
        overlay={layout.focused}
      />

      {s.view === 'history' ? (
        <HistoryPage
          sessions={s.sessions}
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
        />
      ) : (
        <ChatView
          s={s}
          cfg={cfg}
          turn={turn}
          studios={studios}
          layout={layout}
          routeKey={routeKey}
          speakText={speakText}
          onOpenMenu={() => layout.setSidebarOpen(true)}
          onOpenVoice={() => voice.setOpen(true)}
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

      <VoiceOverlay open={voice.open} onClose={() => voice.setOpen(false)} onSend={(text) => turn.sendMessage(text, [])} />

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
