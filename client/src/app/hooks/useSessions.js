import { useCallback, useEffect, useRef, useState } from 'react'
import { getJSON, patchJSON, del } from '../../api.js'
import { pushHash } from '../../lib/hashRouter.js'
import { classifyError } from '../../lib/errors.js'
import { parseRoute, routeHash } from '../routes.js'

// The conversation list, the open conversation and the per-chat settings that
// travel with it (system prompt, tools, composer draft), plus navigation
// between chat, history and the admin Costs page. `navKey` increases on every explicit change of
// conversation so other parts of the shell (studios, popovers, the mobile
// drawer) can close what belongs to the previous one.

const DEFAULT_TOOLS = () => [{ kind: 'genie-one' }, { kind: 'image-gen' }]

/**
 * A deep link points at nothing: the id is not one of the user's conversations
 * and loading it returned no messages (the server scopes every read by owner,
 * so a foreign id looks exactly like a deleted one), or the server rejected the
 * id itself. Any other load failure is an error, not "not found".
 */
export function isMissingConversation({ id, sessions = [], messages = [], error = null }) {
  // only a 404 or an id the database cannot parse; a 5xx whose text happens to
  // say "not found" is a load error (retryable)
  if (error) {
    const { status, detail } = classifyError(error)
    return status === 404 || /invalid input syntax for type (bigint|integer|uuid)/i.test(detail)
  }
  if (sessions.some((x) => String(x.id) === String(id))) return false
  return messages.length === 0
}

export function useSessions({ notifyError, onSessionModel }) {
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [currentId, setCurrentId] = useState(null)
  const [messages, setMessages] = useState([])
  const [loadingSession, setLoadingSession] = useState(false)
  // the id from the URL that turned out not to exist (NotFound screen)
  const [missingId, setMissingId] = useState(null)
  // a load that failed for another reason (ChatView shows it with Retry)
  const [loadError, setLoadError] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [view, setView] = useState('chat') // 'chat' | 'history' | 'costs'
  const [navKey, setNavKey] = useState(0)
  const [streaming, setStreaming] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [enabledTools, setEnabledTools] = useState(DEFAULT_TOOLS)
  const [input, setInput] = useState('')
  const [files, setFiles] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)

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
      const r = await getJSON('/api/sessions')
      setSessions(r.sessions)
      return r.sessions
    } catch (e) {
      notifyError(e)
      return []
    }
  }, [notifyError])

  const leaveConversation = () => {
    setMissingId(null)
    setLoadError(null)
    setNavKey((k) => k + 1)
  }

  // pure state transitions — no URL side effects, safe to call from the
  // popstate handler (which must never push a *new* history entry back)
  const resetToNewChat = () => {
    if (streaming) return
    leaveConversation()
    setCurrentId(null)
    setMessages([])
    setSystemPrompt('')
    setEnabledTools(DEFAULT_TOOLS())
    setInput('')
    setFiles([])
    setView('chat')
  }

  const loadSession = async (id, sessionsOverride, force = false) => {
    if (streaming || loadingSession) return
    setView('chat')
    if (id === currentId && !force) return
    leaveConversation()
    setCurrentId(id)
    setMessages([])
    setLoadingSession(true)
    const list = sessionsOverride || sessions
    try {
      const r = await getJSON(`/api/sessions/${id}/messages`)
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
  // #/projects is parsed but not routed yet: it opens a new chat. #/costs is
  // the admin Costs page; for a non-admin the page itself says "admins only"
  // (the server answers 403), so a shared link never lands on a blank screen.
  const applyRoute = (route, list) => {
    if (route.view === 'history') setView('history')
    else if (route.view === 'costs') setView('costs')
    else if (route.view === 'chat' && route.sessionId) return loadSession(route.sessionId, list)
    else resetToNewChat()
  }

  // first load: `before` fetches the catalog (useSettingsState), then the list,
  // then the deep link. `list` is passed explicitly: `sessions` state is not
  // updated yet inside this closure.
  const boot = async (before) => {
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

  const openSession = async (id) => {
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

  const openCosts = () => {
    setMissingId(null)
    setView('costs')
    pushHash('#/costs')
  }

  const retryLoad = () => currentId && loadSession(currentId, null, true)

  const removeSession = async (id) => {
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

  const renameSession = async (id, title) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    try {
      await patchJSON(`/api/sessions/${id}`, { title })
    } catch (e) {
      notifyError(e)
    }
  }

  const doSearch = useCallback(
    async (q) => {
      if (!q) {
        setSearchResults(null)
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}`)
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
  const patchCurrent = async (body) => {
    if (!currentId) return
    try {
      await patchJSON(`/api/sessions/${currentId}`, body)
    } catch {}
  }
  const changeTools = (tools) => {
    setEnabledTools(tools)
    patchCurrent({ enabled_tools: tools })
  }

  return {
    sessions, setSessions, sessionsLoading, currentId, setCurrentId, messages, setMessages, messagesRef, stickToBottomRef,
    loadingSession, missingId, loadError, deletingId, view, navKey, streaming, setStreaming,
    systemPrompt, setSystemPrompt, enabledTools, changeTools, input, setInput, files, setFiles,
    searchResults, searching, doSearch, loadSessions, boot, newChat, resetToNewChat, openSession, openHistory, closeHistory, openCosts,
    retryLoad, removeSession, renameSession, patchCurrent,
    currentTitle: sessions.find((x) => String(x.id) === String(currentId))?.title,
  }
}
