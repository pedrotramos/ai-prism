import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type { ChatMessage, SessionsState } from './hooks/useSessions.ts'
import type { SettingsState } from './hooks/useSettingsState.ts'
import type { StudiosState } from './hooks/useStudios.ts'
import type { DeckFocusState } from './hooks/useDeckFocus.ts'
import type { TurnActions } from './hooks/useTurnStream.ts'
import type { ToastsState } from './Toasts.tsx'
import Composer from '../components/Composer.tsx'
import Message from '../components/Message.tsx'
import Welcome from '../components/Welcome.tsx'
import SessionSkeleton from '../components/SessionSkeleton.tsx'
import CompactionDivider from '../components/CompactionDivider.tsx'
import * as Icon from '../components/Icons.tsx'
import { COMPACTION_ROLE } from '../lib/compaction.ts'
import { friendlyError } from '../lib/errors.ts'
import { useI18n, useT } from '../lib/i18n.tsx'
import { normalizeSlash } from '../lib/slashCommands.ts'
import ErrorBoundary, { ErrorDetails } from './ErrorBoundary.tsx'
import Header from './Header.tsx'
import ProjectChatBar from '../components/projects/ProjectChatBar.tsx'
import { useSessionBusy } from '../components/projects/useSessionBusy.ts'
import { can } from '../components/projects/projectsLogic.ts'
import NotFound from './NotFound.tsx'

// "Stick to bottom" driven by user intent, not by content: a scroll listener
// releases the auto-follow the moment the user moves away from the bottom and
// re-engages it when they come back. The jump itself is instant (never
// smooth) — a smooth animation still in flight drags the view down WHILE the
// user is wheeling up, re-sticking them against their will.
const STICK_TO_BOTTOM_THRESHOLD = 120

// Inline error for a failed turn (send, continue or regenerate): what went
// wrong in plain words, the raw text behind Details, Retry, and a way to keep
// the prompt (copy) when the user would rather rephrase.
function TurnError({ error, prompt, onRetry, disabled }: { error: { message: string }; prompt: string | undefined; onRetry: () => void; disabled: boolean }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const e = friendlyError(t, error.message)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt!) // Copy only renders when there is a prompt
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }
  return (
    <div role="alert" className="rounded-card border border-[var(--border)] bg-[var(--danger-soft)] px-4 py-3 space-y-2 animate-fade-in">
      <div className="flex items-start gap-2">
        <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" />
        <div className="min-w-0 flex-1 text-body">
          <p className="font-semibold text-[var(--text)]">{t('chat.turnFailed')}</p>
          <p className="text-[var(--muted)]">{e.message}</p>
          <ErrorDetails detail={e.detail} className="mt-1" />
        </div>
      </div>
      <div className="flex flex-wrap gap-in-group pl-6">
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 min-h-9 px-3 rounded-control bg-accent-strong text-on-accent text-label font-semibold hover:brightness-110 transition duration-fast disabled:bg-disabled disabled:text-disabled-text"
        >
          <Icon.Regenerate size={14} /> {t('chat.retry')}
        </button>
        {prompt && (
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 min-h-9 px-3 rounded-control border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] text-label font-semibold text-[var(--text)] transition duration-fast"
          >
            {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />} {copied ? t('chat.promptCopied') : t('chat.copyPrompt')}
          </button>
        )}
      </div>
    </div>
  )
}

interface ChatViewProps {
  s: SessionsState
  cfg: SettingsState
  turn: TurnActions
  studios: StudiosState
  layout: DeckFocusState
  onOpenMenu: () => void
  onOpenVoice: () => void
  speakText: (text: string) => void
  routeKey: string
  notify: ToastsState['pushToast']
  projects?: { id: string | number; name: string }[]
  sharedSessions?: SessionsState['sessions'] | null
}

export default function ChatView({ s, cfg, turn, studios, layout, onOpenMenu, onOpenVoice, speakText, routeKey, notify, projects = [], sharedSessions = null }: ChatViewProps) {
  const { t, locale } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const { messages, streaming, stickToBottomRef } = s

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [stickToBottomRef])
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, stickToBottomRef])

  const last = messages[messages.length - 1]

  // A chat that lives in a project is shared (W3-2): its author shows on each user
  // message, "<name> is answering…" shows while another member's turn runs, and
  // rewriting history needs manage or owner (the server refuses it otherwise).
  const currentSession = (sharedSessions || s.sessions).find((x) => String(x.id) === String(s.currentId))
  const projectId = currentSession?.project_id ?? null
  const projectName = projectId != null ? projects.find((p) => String(p.id) === String(projectId))?.name : null
  const shared = s.currentId != null && projectId != null
  const live = useSessionBusy({ sessionId: s.currentId, enabled: shared, streaming, email: cfg.email })
  const canRewrite = !shared || (live.role != null && can(live.role, 'edit'))
  // a message sent from the not-found screen starts a new chat: show it
  const missing = (s.missingId != null || !!s.loadError) && messages.length === 0
  const goHistory = () => s.openHistory()

  // The composer's "/" commands (components/Composer.jsx): /compactar and
  // /ajuda run inside the composer; everything else lands here.
  const setChatModel = (id: string) => {
    cfg.setModel(id)
    s.patchCurrent({ model: id })
  }
  const runCommand = (id: string, arg: string = '') => {
    if (id === 'new') return s.newChat()
    if (id === 'history') return s.openHistory()
    if (id === 'settings') return cfg.openSettings()
    if (id === 'skills') return cfg.openSettings('skills')
    if (id === 'model') {
      // a picked option passes the id; a typed "/model <text>" passes a query
      const q = normalizeSlash(arg.trim())
      const exact = cfg.models.find((m) => m.id === arg)
      const hits = exact ? [exact] : cfg.models.filter((m) => normalizeSlash(`${m.label || ''} ${m.id}`).includes(q))
      if (q && hits.length === 1) return setChatModel(hits[0]!.id) // hits.length === 1
      return notify(t(q ? 'composer.slash.model.noMatch' : 'composer.slash.model.pick', { q: arg.trim() }))
    }
    if (id === 'cost') {
      // the header's cost meter owns its popover: open it the way a click does
      return document.querySelector<HTMLButtonElement>(`header button[title="${t('meter.title')}"]`)?.click()
    }
    if (id === 'context') {
      const last = [...messages].reverse().find((m) => m.role === 'assistant' && (m.prompt_tokens ?? 0) > 0)
      return notify(
        last
          ? t('composer.slash.context.tokens', { n: Number(last.prompt_tokens).toLocaleString(locale) })
          : t('composer.slash.context.none')
      )
    }
  }

  return (
    <main
      className={`flex-1 flex flex-col min-w-0 ${
        // manual HTML Edit mode hides the chat entirely so the slide gets the full row
        layout.deckEditFullscreen ? 'hidden' : ''
      } ${
        // focus mode: the chat column scales with the window (32%) instead of
        // a fixed 380px, so the composer isn't cramped on big screens
        layout.focused ? 'md:flex-none md:w-[clamp(400px,32%,560px)] md:border-r md:border-[var(--border)]' : ''
      }`}
    >
      <Header cfg={cfg} s={s} layout={layout} onOpenMenu={onOpenMenu} routeKey={routeKey} />
      {shared && <ProjectChatBar projectName={projectName} answeringBy={live.answeringBy} />}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {s.loadingSession ? (
          <SessionSkeleton />
        ) : missing ? (
          <NotFound error={s.loadError} onRetry={s.retryLoad} onHistory={goHistory} onNewChat={s.newChat} />
        ) : messages.length === 0 ? (
          <Welcome
            email={cfg.email}
            enabledTools={s.enabledTools}
            toolPolicy={cfg.toolPolicy}
            imageModels={cfg.imageModels}
            // a starter fills the composer and puts the caret there to finish the sentence
            onPick={(text: string) => (s.setInput(text), requestAnimationFrame(() => scrollRef.current?.parentElement?.querySelector('textarea')?.focus()))}
          />
        ) : (
          <ErrorBoundary variant="message" resetKey={s.currentId}>
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {messages.map((m: ChatMessage, i: number) => {
                // stable id keys keep React from re-mounting bubbles as the list
                // grows; index only for local rows without a server id yet
                const key = m.id ?? `local-${i}`
                if (m.role === COMPACTION_ROLE) return <CompactionDivider key={key} compaction={m.compaction} />
                const failed = m.role === 'assistant' && m.error && !m.streaming
                const bare = failed && !(m.content || '').trim() && !m.blocks?.length
                const prompt = failed ? [...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.content : ''
                return (
                  <div key={key} className="space-y-3">
                    {!bare && (
                      <ErrorBoundary variant="message" resetKey={`${m.id}:${m.content?.length || 0}`}>
                        <Message
                          msg={m as unknown as ComponentProps<typeof Message>['msg']} // type-only: a local row may lack the numeric id; callers guard it
                          models={cfg.models}
                          streaming={m.streaming}
                          onSpeak={speakText}
                          // a local row (failed before the server stored it) has no id to regenerate
                          canRegenerate={canRewrite && !streaming && m.role === 'assistant' && m.id != null}
                          onRegenerate={turn.regenerateMessage}
                          onSwitchVariant={turn.switchVariant}
                          onEditUser={canRewrite ? turn.editUserMessage : undefined}
                          author={shared && m.role === 'user' ? m.sent_by : null}
                          onOpenDeck={studios.openDeck as (id: unknown) => void}
                          onOpenSpreadsheet={studios.openSpreadsheet as (id: unknown) => void}
                          onOpenDocument={studios.openDocument as (id: unknown) => void}
                          isLatest={i === messages.length - 1 && !streaming}
                          onSubmitAnswers={turn.submitQuestionAnswers}
                        />
                      </ErrorBoundary>
                    )}
                    {failed && <TurnError error={m.error!} prompt={prompt} disabled={streaming} onRetry={() => turn.retryTurn(i)} />}
                  </div>
                )
              })}
              {/* Recovery: the thread ends on a user message with no assistant
                  reply (server crashed / token expired mid-generation). There's
                  no assistant bubble to regenerate, so offer to produce the
                  missing answer instead of leaving the user stuck. */}
              {!streaming && last?.role === 'user' && (
                <div className="flex flex-col items-center gap-2 py-2 text-center animate-fade-in">
                  <p className="text-body text-[var(--muted)]">{t('chat.unanswered')}</p>
                  <button
                    type="button"
                    onClick={turn.continueMessage}
                    className="inline-flex items-center gap-2 min-h-11 px-4 rounded-control bg-accent-strong text-on-accent text-body font-semibold hover:brightness-110 transition duration-fast"
                  >
                    <Icon.Regenerate size={15} /> {t('chat.generateAnswer')}
                  </button>
                </div>
              )}
            </div>
          </ErrorBoundary>
        )}
      </div>

      <div className="shrink-0 pb-2">
        <div className="max-w-3xl mx-auto">
          <Composer
            value={s.input}
            onChange={s.setInput}
            onSend={(text: string, f: File[]) => turn.sendMessage(text, f)}
            onStop={turn.stop}
            streaming={streaming}
            files={s.files}
            setFiles={s.setFiles}
            supportedExt={cfg.supportedExt}
            mediaExt={cfg.mediaExt}
            onOpenVoice={onOpenVoice}
            onCommand={runCommand}
            models={cfg.models}
            onStartTemporary={s.currentEphemeral || streaming ? undefined : s.startTemporaryChat}
          />
        </div>
      </div>
    </main>
  )
}
