import { useCallback, useEffect, useRef, useState } from 'react'
import { getJSON, patchJSON, del } from '../../api.ts'
import { pushHash } from '../../lib/hashRouter.ts'
import { classifyError } from '../../lib/errors.ts'
import { parseRoute, routeHash } from '../routes.ts'
import type { Route } from '../routes.ts'

// The conversation list, the open conversation and the per-chat settings that
// travel with it (system prompt, tools, composer draft), plus navigation
// between chat, history and the admin Costs page. `navKey` increases on every explicit change of
// conversation so other parts of the shell (studios, popovers, the mobile
// drawer) can close what belongs to the previous one.

// a conversation id: strings from the URL hash, numbers from some API payloads
type Id = string | number

interface ToolCall {
  id: string
  name?: string
  label?: string
  args?: unknown
  status?: string
  elapsedMs?: number
  result?: unknown
  durationMs?: number
}

/** Why a turn failed and what Retry should do about it (see retryPlan in useTurnStream). */
export type RetryRoute =
  | { route: 'regenerate'; messageId: Id }
  | { route: 'continue' }
  | { route: 'send'; prompt: string; files: File[] }

/** A row of the open thread: the server's message plus the local-only flags a streaming turn adds. */
export interface ChatMessage {
  id?: Id | null
  role: string
  content: string
  model?: string
  streaming?: boolean
  local?: boolean
  attachments?: string | null
  blocks?: unknown[] | null
  toolCalls?: ToolCall[]
  activeSkills?: unknown[]
  reasoning?: string
  variants?: ChatMessage[]
  prompt_tokens?: number
  completion_tokens?: number
  error?: { message: string; retry?: RetryRoute }
  compaction?: unknown
  tool_calls?: unknown
  created_at?: string | null
  sent_by?: string | null
}

/** A tool toggled on for a chat, e.g. `{ kind: 'genie-one' }`. */
interface EnabledTool {
  kind: string
  [key: string]: unknown
}

/** A row of GET /api/sessions (only the fields the shell reads). */
export interface Session {
  id: Id
  title?: string
  model?: string
  system_prompt?: string | null
  enabled_tools?: EnabledTool[] | null
  ephemeral?: boolean
  project_id?: string | number | null
}

const DEFAULT_TOOLS = (): EnabledTool[] => [{ kind: 'genie-one' }, { kind: 'image-gen' }]

/**
 * A deep link points at nothing: the id is not one of the user's conversations
 * and loading it returned no messages (the server scopes every read by owner,
 * so a foreign id looks exactly like a deleted one), or the server rejected the
 * id itself. Any other load failure is an error, not "not found".
 */
export function isMissingConversation({ id, sessions = [], messages = [], error = null }: {
  id: Id
  sessions?: { id: Id }[]
  messages?: unknown[]
  error?: unknown
}): boolean {
  // only a 404 or an id the database cannot parse; a 5xx whose text happens to
  // say "not found" is a load error (retryable)
  if (error) {
    const { status, detail } = classifyError(error)
    return status === 404 || /invalid input syntax for type (bigint|integer|uuid)/i.test(detail)
  }
  if (sessions.some((x) => String(x.id) === String(id))) return false
  return messages.length === 0
}

interface UseSessionsArgs {
  notifyError: (err: unknown) => void
  onSessionModel?: (model: string | undefined) => void
}

export function useSessions({ notifyError, onSessionModel }: UseSessionsArgs) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [currentId, setCurrentId] = useState<Id | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingSession, setLoadingSession] = useState(false)
  // the id from the URL that turned out not to exist (NotFound screen)
  const [missingId, setMissingId] = useState<Id | null>(null)
  // a load that failed for another reason (ChatView shows it with Retry)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [deletingId, setDeletingId] = useState<Id | null>(null)
  const [view, setView] = useState<Route['view']>('chat')
  // Projects (W3-2): the project open on #/projects/:id, and the project the next new chat is created in
  const [projectId, setProjectId] = useState<string | null>(null)
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  const [navKey, setNavKey] = useState(0)
  const [streaming, setStreaming] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [enabledTools, setEnabledTools] = useState<EnabledTool[]>(DEFAULT_TOOLS)
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<File[]>([])
  // GET /api/search results; the shape belongs to HistoryPage, which reads them
  const [searchResults, setSearchResults] = useState<unknown[] | null>(null)
  const [searching, setSearching] = useState(false)
  // Temporary chats (W3-6). `pendingEphemeral`: the next first message starts a
  // temporary chat (chosen in the composer's + menu). `tempIds`: ids this tab
  // created as temporary, known before the list reload brings `ephemeral` back.
  const [pendingEphemeral, setPendingEphemeral] = useState(false)
  const [tempIds, setTempIds] = useState<Set<string>>(() => new Set())

  // Mirror of `messages` for handlers that only need to READ the current list
  // (regenerate/edit): reading through the ref keeps those useCallbacks from
  // depending on `messages`, so their identity stays stable while a turn
  // streams — which is what lets memo(Message) skip re-rendering finished
  // bubbles on every token.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // whether new streaming output should keep the view pinned to the bottom —
  // owned by the user's scroll position, not by the arrival of tokens
  const stickToBottomRef = useRef(true)

  const loadSessions = useCallback(async () => {
    try {
      const r = await getJSON<{ sessions: Session[] }>('/api/sessions')
      setSessions(r.sessions)
      return r.sessions
    } catch (e) {
      notifyError(e)
      return [] as Session[]
    }
  }, [notifyError])

  const isTemporary = (id: Id | null | undefined) =>
    id != null && (tempIds.has(String(id)) || sessions.some((x) => String(x.id) === String(id) && x.ephemeral === true))
  const currentEphemeral = currentId ? isTemporary(currentId) : pendingEphemeral

  // Leaving a temporary chat deletes it. Fire and forget: the retention sweep
  // (server/retention.js, idle > 24 h) is the safety net for a delete that never
  // arrives. `nextId` is where we go; staying on the same chat (a retry) keeps it.
  const discardTemporary = (nextId?: Id | null) => {
    if (!currentId || String(nextId ?? '') === String(currentId) || !isTemporary(currentId)) return
    const id = String(currentId)
    setSessions((prev) => prev.filter((x) => String(x.id) !== id))
    setTempIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    del(`/api/sessions/${id}`).catch(() => {})
  }

  // closing the tab or navigating away from the app: the page is going away, so
  // the request must outlive it (keepalive); a lost one is the sweep's job
  const liveTemporaryRef = useRef<string | null>(null)
  liveTemporaryRef.current = currentId && isTemporary(currentId) ? String(currentId) : null
  useEffect(() => {
    const onHide = () => {
      const id = liveTemporaryRef.current
      if (id) fetch(`/api/sessions/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  const leaveConversation = (nextId: Id | null = null) => {
    discardTemporary(nextId)
    setMissingId(null)
    setLoadError(null)
    setNavKey((k) => k + 1)
  }

  // pure state transitions — no URL side effects, safe to call from the
  // popstate handler (which must never push a *new* history entry back)
  const resetToNewChat = () => {
    if (streaming) return
    leaveConversation(null)
    setPendingEphemeral(false)
    setPendingProjectId(null)
    setCurrentId(null)
    setMessages([])
    setSystemPrompt('')
    setEnabledTools(DEFAULT_TOOLS())
    setInput('')
    setFiles([])
    setView('chat')
  }

  const loadSession = async (id: Id, sessionsOverride?: Session[] | null, force: boolean = false) => {
    if (streaming || loadingSession) return
    setView('chat')
    if (id === currentId && !force) return
    leaveConversation(id)
    setCurrentId(id)
    setMessages([])
    setLoadingSession(true)
    const list = sessionsOverride || sessions
    try {
      const r = await getJSON<{ messages: ChatMessage[] }>(`/api/sessions/${id}/messages`)
      if (isMissingConversation({ id, sessions: list, messages: r.messages })) {
        setMissingId(id)
        setCurrentId(null)
        return
      }
      stickToBottomRef.current = true // a freshly opened session starts at its tail
      setMessages(r.messages)
      const s = list.find((x) => String(x.id) === String(id))
      if (s) {
        onSessionModel?.(s.model)
        setSystemPrompt(s.system_prompt || '')
        setEnabledTools(s.enabled_tools || [])
      }
    } catch (e) {
      if (isMissingConversation({ id, sessions: list, error: e })) {
        setMissingId(id)
        setCurrentId(null)
      } else setLoadError(e)
    } finally {
      setLoadingSession(false)
    }
  }

  // applies a route parsed from the URL (boot and browser back/forward);
  // #/projects[/:id] is the Projects screen. #/costs is
  // the admin Costs page; for a non-admin the page itself says "admins only"
  // (the server answers 403), so a shared link never lands on a blank screen.
  const applyRoute = (route: Route, list?: Session[]) => {
    if (route.view === 'projects') {
      setMissingId(null)
      setProjectId(route.projectId)
      setView('projects')
    } else if (route.view === 'history') setView('history')
    else if (route.view === 'costs') setView('costs')
    else if (route.view === 'chat' && route.sessionId) return loadSession(route.sessionId, list)
    else resetToNewChat()
  }

  // first load: `before` fetches the catalog (useSettingsState), then the list,
  // then the deep link. `list` is passed explicitly: `sessions` state is not
  // updated yet inside this closure.
  const boot = async (before?: () => Promise<void> | void) => {
    try {
      await before?.()
      const list = await loadSessions()
      await applyRoute(parseRoute(location.hash), list)
    } catch (e) {
      notifyError(e)
    } finally {
      setSessionsLoading(false)
    }
  }

  // handles browser back/forward — always re-registered with fresh closures
  // via a ref so it never acts on stale `sessions`/`currentId`/`streaming`
  const popHandlerRef = useRef(() => {})
  popHandlerRef.current = () => applyRoute(parseRoute(location.hash))
  useEffect(() => {
    const handler = () => popHandlerRef.current()
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // navigating wrappers — used by explicit user actions (sidebar, history
  // page); these push a URL so the browser's back/forward buttons work
  const newChat = () => {
    if (streaming) return
    resetToNewChat()
    pushHash('#/chat')
  }

  // "Temporary chat" in the + menu: a fresh chat whose first message creates a
  // temporary one (nothing exists on the server until then)
  const startTemporaryChat = () => {
    if (streaming) return
    resetToNewChat()
    setPendingEphemeral(true)
    pushHash('#/chat')
  }
  const markTemporary = (id: Id) => {
    setPendingEphemeral(false)
    setTempIds((prev) => new Set(prev).add(String(id)))
  }

  const openSession = async (id: Id) => {
    if (streaming || loadingSession) return
    await loadSession(id)
    pushHash(routeHash({ view: 'chat', sessionId: id }))
  }

  const openHistory = () => {
    // leaving a link that pointed at nothing: coming back is a new chat
    setMissingId(null)
    setView('history')
    pushHash('#/history')
  }

  const closeHistory = () => {
    setView('chat')
    pushHash(routeHash({ view: 'chat', sessionId: currentId }))
  }

  const openProjects = (id: string | null = null) => {
    setMissingId(null)
    setProjectId(id)
    setView('projects')
    pushHash(routeHash({ view: 'projects', projectId: id }))
  }

  // a fresh chat whose first message creates the chat INSIDE the project
  const newChatInProject = (id: Id) => {
    if (streaming) return
    resetToNewChat()
    setPendingProjectId(String(id))
    pushHash('#/chat')
  }

  const openCosts = () => {
    setMissingId(null)
    setView('costs')
    pushHash('#/costs')
  }

  const retryLoad = () => currentId && loadSession(currentId, null, true)

  const removeSession = async (id: Id) => {
    setDeletingId(id)
    try {
      await del(`/api/sessions/${id}`)
      if (id === currentId) newChat()
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (e) {
      notifyError(e)
    } finally {
      setDeletingId(null)
    }
  }

  const renameSession = async (id: Id, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    try {
      await patchJSON(`/api/sessions/${id}`, { title })
    } catch (e) {
      notifyError(e)
    }
  }

  const doSearch = useCallback(
    async (q: string) => {
      if (!q) {
        setSearchResults(null)
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const r = await getJSON<{ results: unknown[] }>(`/api/search?q=${encodeURIComponent(q)}`)
        setSearchResults(r.results)
      } catch (e) {
        notifyError(e)
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    },
    [notifyError]
  )

  // per-chat settings changed in the header: saved on the session when it exists
  const patchCurrent = async (body: unknown) => {
    if (!currentId) return
    try {
      await patchJSON(`/api/sessions/${currentId}`, body)
    } catch {}
  }
  const changeTools = (tools: EnabledTool[]) => {
    setEnabledTools(tools)
    patchCurrent({ enabled_tools: tools })
  }

  return {
    sessions, setSessions, sessionsLoading, currentId, setCurrentId, messages, setMessages, messagesRef, stickToBottomRef,
    loadingSession, missingId, projectId, pendingProjectId, clearPendingProject: () => setPendingProjectId(null), openProjects, newChatInProject, loadError, deletingId, view, navKey, streaming, setStreaming,
    systemPrompt, setSystemPrompt, enabledTools, changeTools, input, setInput, files, setFiles,
    pendingEphemeral, currentEphemeral, isTemporary, startTemporaryChat, markTemporary,
    searchResults, searching, doSearch, loadSessions, boot, newChat, resetToNewChat, openSession, openHistory, closeHistory, openCosts,
    retryLoad, removeSession, renameSession, patchCurrent,
    currentTitle: sessions.find((x) => String(x.id) === String(currentId))?.title,
  }
}

export type SessionsState = ReturnType<typeof useSessions>
