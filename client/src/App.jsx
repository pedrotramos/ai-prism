import { useEffect, useRef, useState, useCallback } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Composer from './components/Composer.jsx'
import Message from './components/Message.jsx'
import Welcome from './components/Welcome.jsx'
import SessionSkeleton from './components/SessionSkeleton.jsx'
import ModelPicker from './components/ModelPicker.jsx'
import ToolsPicker from './components/ToolsPicker.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import VoiceOverlay from './components/VoiceOverlay.jsx'
import HistoryPage from './components/HistoryPage.jsx'
import DeckStudio from './components/DeckStudio.jsx'
import SpreadsheetStudio from './components/SpreadsheetStudio.jsx'
import DocumentStudio from './components/DocumentStudio.jsx'
import * as Icon from './components/Icons.jsx'
import { getJSON, patchJSON, postJSON, del, streamChat, streamContinue, streamRegenerate } from './api.js'
import { speak, plainForSpeech } from './lib/speech.js'
import { prepareMediaFiles } from './lib/mediaChunk.js'
import { parseHash, pushHash, replaceHash } from './lib/hashRouter.js'
import { useT } from './lib/i18n.jsx'

// Shared SSE event handler for the three streaming flows (send / regenerate /
// continue). They differ only in HOW they locate & patch the target message
// (`setTarget`) and in a couple of flow-specific events (meta/title on send);
// everything else — tokens, tool chips, skill badges, blocks, errors — is
// identical, so it lives here once. `accRef` holds the running text buffer
// (mutable so token/blocks can rewrite it). `opts` supplies flow-specific
// hooks: onMeta, onTitle. Returns an (ev) => void for the stream consumer.
//   setTarget(patch): patch may be an object (merged) or a fn (prev => next).

// Fires a desktop notification when a turn finishes — only if the user enabled
// it AND the tab is in the background (no point notifying about something
// they're already watching). Best-effort: silently no-ops without permission.
function notifyTurnDone(enabled, t) {
  if (!enabled) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
  try {
    new Notification('AI Prism', {
      body: t('notify.ready'),
      tag: 'ai-prism-turn', // collapse repeats into one
    })
  } catch {}
}

function makeSSEHandler({ setTarget, accRef, pushToast, setDeckStudioId, setStreamingDeck, onMeta, onTitle }) {
  // Coalesce high-frequency content updates into ONE paint per animation frame
  // instead of one setState (→ full App re-render + markdown reparse) per token.
  // `accRef.value` is the single source of truth for the streamed text, so the
  // scheduled flush always reads the latest value: no token is ever dropped,
  // and any event that rewrites content (blocks/error) also updates accRef so
  // the next flush stays consistent. A pending frame fires within ~16ms; the
  // stream's `finally` reload then overwrites with authoritative server content.
  let rafId = null
  const scheduleContentFlush = () => {
    if (rafId != null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      setTarget({ content: accRef.value })
    })
  }
  const handler = (ev) => {
    switch (ev.type) {
      case 'meta':
        onMeta?.(ev)
        break
      case 'token':
        accRef.value += ev.value
        scheduleContentFlush()
        break
      case 'usage':
        setTarget({ prompt_tokens: ev.usage.prompt_tokens, completion_tokens: ev.usage.completion_tokens })
        break
      case 'deck_stream_start':
        // pure-HTML deck engine: the model started writing a deck. Open the
        // Studio immediately with an empty live deck so slides stream IN (kills
        // the blind spinner). The persisted deck (blocks event) supersedes it.
        setStreamingDeck?.({ title: ev.title || '', slides: [], meta: { format: 'html' }, streaming: true })
        setDeckStudioId?.('streaming')
        break
      case 'deck_slide':
        // one slide finished — append/replace at its index so thumbnails build
        // up live, in order.
        setStreamingDeck?.((d) => {
          const slides = (d?.slides || []).slice()
          slides[ev.index] = ev.html
          return { ...(d || { meta: { format: 'html' }, streaming: true }), slides }
        })
        break
      case 'reasoning':
        // native reasoning/thinking tokens streamed by the model — shown live in
        // a collapsible trace (ReasoningTrace). The server accumulates the full
        // trace and persists it with the message, so it survives a reload; here
        // we keep only a generous rolling window (bounding client memory during
        // very long runs — the reload then swaps in the full stored trace).
        setTarget((m) => ({ ...m, reasoning: ((m.reasoning || '') + ev.value).slice(-8000) }))
        break
      case 'skill_active':
        // ephemeral: which authored skills the router activated this turn. Shown
        // as a badge while the turn streams; not persisted, so it's gone on
        // reload (the server doesn't store it on the message).
        setTarget((m) => ({ ...m, activeSkills: ev.skills || [] }))
        break
      case 'tool_call':
        // inline {{toolcall:ID}} marker (mirrors the server) so the chip renders
        // at this exact point in the narrative, not grouped before the answer
        accRef.value += `\n\n{{toolcall:${ev.id}}}\n\n`
        setTarget((m) => ({
          ...m,
          content: accRef.value,
          toolCalls: [...(m.toolCalls || []), { id: ev.id, name: ev.name, label: ev.label, args: ev.args, status: 'running' }],
        }))
        break
      case 'tool_progress':
        setTarget((m) => ({
          ...m,
          toolCalls: (m.toolCalls || []).map((tc) => (tc.id === ev.id ? { ...tc, elapsedMs: ev.elapsedMs } : tc)),
        }))
        break
      case 'tool_result':
        setTarget((m) => ({
          ...m,
          toolCalls: (m.toolCalls || []).map((tc) =>
            tc.id === ev.id ? { ...tc, status: ev.status, result: ev.result, durationMs: ev.durationMs } : tc
          ),
        }))
        break
      case 'blocks':
        // backend swaps the raw ```prism-block fences for {{block:N}}
        // placeholders in `content` — replace wholesale so it matches exactly
        // what gets persisted/reloaded
        accRef.value = ev.content
        setTarget({ content: ev.content, blocks: ev.blocks })
        {
          const freshDeck = ev.blocks.find((b) => (b.type === 'deck' || b.type === 'deck-html') && b.deckId)
          if (freshDeck) {
            setDeckStudioId(freshDeck.deckId)
            // the persisted deck now supersedes the live-streamed one
            setStreamingDeck?.(null)
          }
        }
        break
      case 'title':
        onTitle?.(ev)
        break
      case 'error':
        pushToast(ev.error)
        accRef.value += (accRef.value ? '\n\n' : '') + `⚠️ ${ev.error}`
        setTarget({ content: accRef.value })
        break
      default:
        break
    }
  }
  // Cancel any scheduled frame and paint the final accumulated text once, so
  // the last tokens land even if the stream ends between frames. Callers invoke
  // this before their authoritative reload.
  handler.finalize = () => {
    if (rafId != null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    setTarget({ content: accRef.value })
  }
  return handler
}

export default function App({ uiLang, setUiLang }) {
  const t = useT()
  const [theme, setTheme] = useState(() => localStorage.getItem('prism-theme') || 'dark')
  // personal preferences (see PersonalTab): response language + desktop
  // notifications. (uiLang lives in main.jsx's Root, above the I18nProvider,
  // and arrives here as a prop.)
  const [responseLang, setResponseLang] = useState(() => localStorage.getItem('prism-response-lang') || 'auto')
  const [notify, setNotify] = useState(() => localStorage.getItem('prism-notify') === '1')
  const [email, setEmail] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [models, setModels] = useState([])
  const [supportedExt, setSupportedExt] = useState([])
  const [mediaExt, setMediaExt] = useState([])
  const [sessions, setSessions] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [messages, setMessages] = useState([])
  const [model, setModel] = useState(localStorage.getItem('prism-model') || '')
  // image-generation model: '' means "use the org default" (resolved server-side)
  const [imageModel, setImageModel] = useState(localStorage.getItem('prism-image-model') || '')
  const [imageModels, setImageModels] = useState([])
  // which model the "Padrão" (default) image selection resolves to, so the UI
  // can name it explicitly instead of an opaque "Default"
  const [imageModelDefaultId, setImageModelDefaultId] = useState(null)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [enabledTools, setEnabledTools] = useState([{ kind: 'genie-one' }, { kind: 'image-gen' }])
  // org tool policy ({ [toolKey]: boolean }); a missing key means enabled.
  const [toolPolicy, setToolPolicy] = useState({})
  const [input, setInput] = useState('')
  const [files, setFiles] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [manualSidebarCollapsed, setManualSidebarCollapsed] = useState(
    () => localStorage.getItem('prism-sidebar-collapsed') === '1'
  )
  const [view, setView] = useState('chat') // 'chat' | 'history'
  const [deckStudioId, setDeckStudioId] = useState(null)
  // which chat session the open deck belongs to — the Studio auto-closes when
  // the user navigates to a different conversation (a deck is bound to its chat)
  const [deckSessionId, setDeckSessionId] = useState(null)
  // pure-HTML deck engine: the deck being streamed live (before it persists and
  // gets a real deckId). Rendered by DeckStudio when deckStudioId === 'streaming'.
  const [streamingDeck, setStreamingDeck] = useState(null)
  const [spreadsheetStudioId, setSpreadsheetStudioId] = useState(null)
  const [documentStudioId, setDocumentStudioId] = useState(null)
  // focus mode: while a deck is open the chat shrinks to a narrow side column
  // and the Studio takes the rest of the row (Claude Design-style split);
  // toggleable from the Studio header, remembered across sessions
  const [deckFocus, setDeckFocus] = useState(() => localStorage.getItem('prism-deck-focus') !== '0')
  // auto-collapses when a deck panel opens (mirrors Claude's artifact layout)
  // but stays re-openable: expanding the rail while the Studio is up clears
  // only this flag, never the user's persisted manual preference. Closing the
  // deck falls back to whatever they'd set before.
  const [deckAutoCollapsed, setDeckAutoCollapsed] = useState(false)
  // when the deck Studio enters manual HTML Edit mode it asks to hide the chat
  // entirely (the user wants max canvas room to edit the slide). Cleared when
  // Edit mode closes or the Studio closes.
  const [deckEditFullscreen, setDeckEditFullscreen] = useState(false)
  useEffect(() => {
    setDeckAutoCollapsed(!!deckStudioId)
    if (!deckStudioId) {
      setDeckEditFullscreen(false)
      setDeckSessionId(null)
    }
  }, [deckStudioId])
  // a deck is bound to the chat that created it: once we know the open deck's
  // owning session, close the Studio if the user is viewing a different chat
  // (streaming decks have no persisted session yet — never force-close those)
  useEffect(() => {
    if (!deckStudioId || deckStudioId === 'streaming' || deckSessionId == null) return
    if (currentId != null && String(currentId) !== String(deckSessionId)) {
      setDeckStudioId(null)
      setStreamingDeck(null)
    }
  }, [currentId, deckSessionId, deckStudioId])
  const sidebarCollapsed = manualSidebarCollapsed || deckAutoCollapsed
  const toggleSidebarCollapse = () => {
    if (sidebarCollapsed) {
      setManualSidebarCollapsed(false)
      setDeckAutoCollapsed(false)
    } else if (deckStudioId) {
      setDeckAutoCollapsed(true)
    } else {
      setManualSidebarCollapsed(true)
    }
  }
  const [toasts, setToasts] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)

  const abortRef = useRef(null)
  const scrollRef = useRef(null)
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

  // Small, corner-anchored toast stack — errors are informative, not blocking,
  // so they must never sit on top of the composer or require a click to go
  // away. Each toast auto-dismisses; multiple errors stack instead of
  // clobbering each other.
  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
  const pushToast = useCallback(
    (message) => {
      if (!message) return
      const id = `${Date.now()}-${Math.random()}`
      setToasts((prev) => [...prev, { id, message }])
      setTimeout(() => dismissToast(id), 6000)
    },
    [dismissToast]
  )

  // theme: 'dark' | 'light' | 'system'. 'system' follows the OS preference live
  // (via matchMedia) so the app tracks a mid-session OS switch without a reload.
  useEffect(() => {
    localStorage.setItem('prism-theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', resolved)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // Response language is passed to the model per turn as `responseLang`.
  // (uiLang persistence + <html lang> live in main.jsx's Root.)
  useEffect(() => {
    localStorage.setItem('prism-response-lang', responseLang)
  }, [responseLang])

  useEffect(() => {
    localStorage.setItem('prism-notify', notify ? '1' : '0')
  }, [notify])

  useEffect(() => {
    if (model) localStorage.setItem('prism-model', model)
  }, [model])

  useEffect(() => {
    localStorage.setItem('prism-image-model', imageModel || '')
  }, [imageModel])

  useEffect(() => {
    localStorage.setItem('prism-sidebar-collapsed', manualSidebarCollapsed ? '1' : '0')
  }, [manualSidebarCollapsed])

  useEffect(() => {
    localStorage.setItem('prism-deck-focus', deckFocus ? '1' : '0')
  }, [deckFocus])

  // bootstrap
  useEffect(() => {
    ;(async () => {
      try {
        // /api/me and /api/models are independent — fetch them in parallel so
        // the model picker isn't gated behind the identity round-trip (the two
        // latencies used to stack, worsening the picker's "pop-in").
        const [me, m] = await Promise.all([getJSON('/api/me'), getJSON('/api/models')])
        setEmail(me.email)
        setIsAdmin(!!me.isAdmin)
        setModels(m.models)
        setSupportedExt(m.supported_extensions)
        setMediaExt(m.media_extensions || [])
        // a saved preference can point at an endpoint that no longer exists in
        // the catalog (ids change as models are updated) — drop it so the UI
        // doesn't sit on a phantom id (which would silently fall back to
        // MODELS[0] server-side on every turn)
        setModel((prev) => (prev && m.models.some((x) => x.id === prev) ? prev : m.models[0]?.id))
        // image-generation models (Settings → image model). Best-effort and
        // non-blocking — the chat picker must never wait on this.
        getJSON('/api/image-models')
          .then((im) => {
            setImageModels(im.models || [])
            setImageModelDefaultId(im.defaultId || null)
            // prefer the server-persisted selection; fall back to the local one
            if (im.selected) setImageModel(im.selected)
          })
          .catch(() => {})
        // org tool policy (which tool groups the admin left enabled). Best-effort;
        // absent keys mean enabled, so a failure leaves everything available.
        getJSON('/api/tool-policy')
          .then((tp) => setToolPolicy(tp.policy || {}))
          .catch(() => {})
        const list = await loadSessions()
        // apply a deep-linked hash (#/history or #/chat/<id>) once sessions
        // are known — `list` is passed explicitly since `sessions` state
        // wouldn't be updated yet within this same closure invocation
        const { view: v, sessionId } = parseHash()
        if (v === 'history') setView('history')
        else if (sessionId) await loadSession(sessionId, list)
      } catch (e) {
        pushToast(e.message)
      } finally {
        setSessionsLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      const r = await getJSON('/api/sessions')
      setSessions(r.sessions)
      return r.sessions
    } catch (e) {
      pushToast(e.message)
      return []
    }
  }, [])

  // refetch the enabled-model catalog — called on boot and again after an admin
  // edits an endpoint in Settings, so the picker's names/blurbs/availability
  // update live instead of only after a page reload
  const refreshModels = useCallback(async () => {
    try {
      const m = await getJSON('/api/models')
      setModels(m.models)
      setSupportedExt(m.supported_extensions)
      setMediaExt(m.media_extensions || [])
      // drop a selected id that no longer exists in the refreshed catalog
      setModel((prev) => (prev && m.models.some((x) => x.id === prev) ? prev : m.models[0]?.id))
      return m.models
    } catch (e) {
      pushToast(e.message)
      return []
    }
  }, [])

  // handles browser back/forward — always re-registered with fresh closures
  // via a ref so it never acts on stale `sessions`/`currentId`/`streaming`
  const popHandlerRef = useRef(() => {})
  useEffect(() => {
    const handler = () => popHandlerRef.current()
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // "Stick to bottom" driven by user intent, not by content: a scroll
  // listener releases the auto-follow the moment the user moves away from the
  // bottom and re-engages it when they come back. The jump itself is instant
  // (never smooth) — a smooth animation still in flight drags the view down
  // WHILE the user is wheeling up, re-sticking them against their will.
  const STICK_TO_BOTTOM_THRESHOLD = 120
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [view])
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // pure state transitions — no URL side effects, safe to call from the
  // popstate handler (which must never push a *new* history entry back)
  // An open artifact Studio (deck/spreadsheet/document) is scoped to the
  // conversation it was opened from — it must NOT bleed into a new chat or a
  // different session the user switches to. Close all three whenever the active
  // conversation changes.
  const closeStudios = () => {
    setDeckStudioId(null)
    setSpreadsheetStudioId(null)
    setDocumentStudioId(null)
  }

  const resetToNewChat = () => {
    if (streaming) return
    setCurrentId(null)
    setMessages([])
    setSystemPrompt('')
    setEnabledTools([{ kind: 'genie-one' }, { kind: 'image-gen' }])
    setInput('')
    setFiles([])
    setSidebarOpen(false)
    closeStudios()
    setView('chat')
  }

  const loadSession = async (id, sessionsOverride) => {
    if (streaming || loadingSession) return
    setSidebarOpen(false)
    setView('chat')
    if (id === currentId) return
    setCurrentId(id)
    setMessages([])
    closeStudios() // a Studio from the previous session must not carry over
    setLoadingSession(true)
    try {
      const r = await getJSON(`/api/sessions/${id}/messages`)
      stickToBottomRef.current = true // a freshly opened session starts at its tail
      setMessages(r.messages)
      const s = (sessionsOverride || sessions).find((x) => x.id === id)
      if (s) {
        setModel(s.model)
        setSystemPrompt(s.system_prompt || '')
        setEnabledTools(s.enabled_tools || [])
      }
    } catch (e) {
      pushToast(e.message)
    } finally {
      setLoadingSession(false)
    }
  }

  // navigating wrappers — used by explicit user actions (sidebar, history
  // page); these push a URL so the browser's back/forward buttons work
  const newChat = () => {
    if (streaming) return
    resetToNewChat()
    pushHash('#/chat')
  }

  // "Create with Claude" from the Skills settings tab: close Settings, start a
  // fresh chat, and pre-fill the composer with a prompt that kicks off a
  // guided skill-authoring conversation (same pattern as claude.ai — it drops
  // you into a new chat pre-seeded, rather than a bespoke generation flow).
  const startSkillCreator = () => {
    if (streaming) return
    setSettingsOpen(false)
    setSettingsTab(null)
    resetToNewChat()
    pushHash('#/chat')
    setInput(t('skillCreator.prompt'))
  }

  const openSession = async (id) => {
    if (streaming || loadingSession) return
    await loadSession(id)
    pushHash('#/chat/' + id)
  }

  const openHistory = () => {
    setView('history')
    pushHash('#/history')
  }

  const closeHistory = () => {
    setView('chat')
    pushHash(currentId ? '#/chat/' + currentId : '#/chat')
  }

  popHandlerRef.current = () => {
    const { view: v, sessionId } = parseHash()
    if (v === 'history') setView('history')
    else if (sessionId) loadSession(sessionId)
    else resetToNewChat()
  }

  const removeSession = async (id) => {
    setDeletingId(id)
    try {
      await del(`/api/sessions/${id}`)
      if (id === currentId) newChat()
      setSessions((prev) => prev.filter((s) => s.id !== id))
    } catch (e) {
      pushToast(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  const renameSession = async (id, title) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    try {
      await patchJSON(`/api/sessions/${id}`, { title })
    } catch (e) {
      pushToast(e.message)
    }
  }

  const doSearch = useCallback(async (q) => {
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
      pushToast(e.message)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  const onChangeModel = async (id) => {
    setModel(id)
    if (currentId) {
      try {
        await patchJSON(`/api/sessions/${currentId}`, { model: id })
      } catch {}
    }
  }

  const onChangeTools = async (tools) => {
    setEnabledTools(tools)
    if (currentId) {
      try {
        await patchJSON(`/api/sessions/${currentId}`, { enabled_tools: tools })
      } catch {}
    }
  }

  // core: send a turn, stream the answer, resolve with final text (for voice)
  const sendMessage = useCallback(
    async (text, fileList = [], opts = {}) => {
      const prompt = (text || '').trim()
      if ((!prompt && fileList.length === 0) || streaming) return ''

      const userMsg = {
        role: 'user',
        content: prompt,
        // the ORIGINAL filenames are what the user sees (chunking is an
        // implementation detail); keep them for the attachment chips
        attachments: fileList.length ? JSON.stringify(fileList.map((f) => f.name)) : null,
      }
      const asstMsg = { role: 'assistant', content: '', model, streaming: true }
      // sending a message is an explicit "take me to the conversation tail"
      stickToBottomRef.current = true
      setMessages((prev) => [...prev, userMsg, asstMsg])
      setInput('')
      setFiles([])
      setStreaming(true)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const accRef = { value: '' }
      let createdId = null

      // patch the last message (the streaming assistant bubble)
      const setLast = (patch) =>
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          next[next.length - 1] = typeof patch === 'function' ? patch(last) : { ...last, ...patch }
          return next
        })

      // Long audio/video (1h+ meetings) exceeds the per-request media cap, so
      // oversized recordings are segmented in the browser into sub-cap WAV
      // chunks (Web Audio API — no server ffmpeg) before upload; each chunk is
      // transcribed in order by the multimodal model. Small media/video within
      // budget and non-media files pass through untouched. Progress surfaces in
      // the assistant bubble's thinking hint so a long segmentation isn't silent.
      let uploadFiles = fileList
      try {
        uploadFiles = await prepareMediaFiles(fileList, ({ name, done, total }) =>
          setLast({ reasoning: t('composer.segmenting', { name, done, total }) })
        )
      } catch {
        uploadFiles = fileList // any failure → send originals; server notes limits
      }

      const fd = new FormData()
      fd.append(
        'payload',
        JSON.stringify({
          sessionId: currentId,
          model,
          imageModel: imageModel || undefined,
          systemPrompt,
          responseLang,
          uiLang,
          prompt,
          enabledTools,
        })
      )
      for (const f of uploadFiles) fd.append('files', f)

      const sseHandler = makeSSEHandler({
        setTarget: setLast,
        accRef,
        pushToast,
        setDeckStudioId,
        setStreamingDeck,
        onMeta: (ev) => {
          createdId = ev.sessionId
          if (ev.isNew) {
            setCurrentId(ev.sessionId)
            // gives the freshly-created session a URL without adding a
            // back-button entry — the user didn't "navigate" here, the
            // page they're already looking at just now has an id
            replaceHash('#/chat/' + ev.sessionId)
          }
        },
        onTitle: (ev) =>
          setSessions((prev) => prev.map((s) => (s.id === ev.sessionId ? { ...s, title: ev.title } : s))),
      })
      try {
        await streamChat(fd, sseHandler, ctrl.signal)
      } catch (e) {
        if (e.name !== 'AbortError') pushToast(e.message)
      } finally {
        sseHandler.finalize()
        setMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = { ...next[next.length - 1], streaming: false }
          return next
        })
        setStreaming(false)
        abortRef.current = null
        notifyTurnDone(notify, t)
        await loadSessions()
        if (createdId) setCurrentId((c) => c || createdId)
        // reload the thread so the just-streamed user + assistant rows pick up
        // their server-assigned ids (and blocks/tool_calls/variants). Without
        // this, the locally-appended messages have no id, so a later edit/
        // regenerate would POST to /messages/undefined/* — the server then
        // queries `WHERE id = 'undefined'` and Postgres throws
        // "invalid input syntax for type bigint". Mirrors regenerateMessage.
        const reloadId = createdId || currentId
        if (reloadId) {
          try {
            const r = await getJSON(`/api/sessions/${reloadId}/messages`)
            setMessages(r.messages)
          } catch {}
        }
      }
      return accRef.value
    },
    [currentId, model, systemPrompt, responseLang, enabledTools, notify, streaming, loadSessions]
  )

  // Regenerates one assistant turn in place: the slot keeps its position in
  // the thread, the old answer becomes a browsable version instead of being
  // discarded, and a follow-up reload picks up the server-assigned id +
  // full variants list (simpler and less error-prone than reconstructing it
  // client-side from SSE events alone).
  const regenerateMessage = useCallback(
    async (messageId) => {
      if (streaming || !currentId) return
      const exists = messagesRef.current.some((m) => m.id === messageId)
      if (!exists) return

      const setTarget = (patch) =>
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === messageId)
          if (i === -1) return prev
          const next = [...prev]
          next[i] = typeof patch === 'function' ? patch(next[i]) : { ...next[i], ...patch }
          return next
        })

      setTarget({ content: '', blocks: undefined, toolCalls: undefined, activeSkills: undefined, reasoning: undefined, streaming: true })
      setStreaming(true)

      const ctrl = new AbortController()
      abortRef.current = ctrl
      const accRef = { value: '' }

      const sseHandler = makeSSEHandler({ setTarget, accRef, pushToast, setDeckStudioId, setStreamingDeck })
      try {
        await streamRegenerate(
          currentId,
          messageId,
          { model, imageModel: imageModel || undefined, systemPrompt, responseLang, uiLang, enabledTools },
          sseHandler,
          ctrl.signal
        )
      } catch (e) {
        if (e.name !== 'AbortError') pushToast(e.message)
      } finally {
        sseHandler.finalize()
        setStreaming(false)
        abortRef.current = null
        try {
          const r = await getJSON(`/api/sessions/${currentId}/messages`)
          setMessages(r.messages)
        } catch (e) {
          pushToast(e.message)
        }
      }
    },
    [currentId, model, systemPrompt, responseLang, enabledTools, streaming, pushToast]
  )

  // Recovery for a session that ends on an unanswered user message (server
  // crashed / token expired mid-turn, so the assistant reply was never
  // created). There's no assistant bubble to regenerate, so this appends a
  // fresh streaming one and asks the server to produce the missing reply.
  const continueMessage = useCallback(async () => {
    if (streaming || !currentId) return
    const asstMsg = { role: 'assistant', content: '', model, streaming: true }
    stickToBottomRef.current = true
    setMessages((prev) => [...prev, asstMsg])
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    const accRef = { value: '' }
    const setLast = (patch) =>
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = typeof patch === 'function' ? patch(last) : { ...last, ...patch }
        return next
      })

    const sseHandler = makeSSEHandler({ setTarget: setLast, accRef, pushToast, setDeckStudioId, setStreamingDeck })
    try {
      await streamContinue(
        currentId,
        { model, imageModel: imageModel || undefined, systemPrompt, responseLang, uiLang, enabledTools },
        sseHandler,
        ctrl.signal
      )
    } catch (e) {
      if (e.name !== 'AbortError') pushToast(e.message)
    } finally {
      sseHandler.finalize()
      setStreaming(false)
      abortRef.current = null
      try {
        const r = await getJSON(`/api/sessions/${currentId}/messages`)
        setMessages(r.messages)
      } catch (e) {
        pushToast(e.message)
      }
    }
  }, [currentId, model, systemPrompt, responseLang, enabledTools, streaming, pushToast])

  // Browses to a stored variant without regenerating — persists the choice
  // server-side so it's what a new message (or a session reload) continues from.
  const switchVariant = useCallback(
    async (messageId, targetId) => {
      if (streaming) return
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId)
        if (i === -1) return prev
        const variant = prev[i].variants?.find((v) => v.id === targetId)
        if (!variant) return prev
        const next = [...prev]
        next[i] = { ...variant, variants: prev[i].variants }
        return next
      })
      try {
        await patchJSON(`/api/messages/${targetId}/activate`, {})
      } catch (e) {
        pushToast(e.message)
      }
    },
    [streaming, pushToast]
  )

  // Edits a previously-sent prompt, then regenerates whatever assistant reply
  // followed it — the regenerate call's own refetch picks up both the edited
  // prompt's variants and the new answer in one go.
  const editUserMessage = useCallback(
    async (messageId, newText) => {
      if (streaming || !currentId || messageId == null) return
      const idx = messagesRef.current.findIndex((m) => m.id === messageId)
      if (idx === -1) return
      const nextMsg = messagesRef.current[idx + 1]

      try {
        const r = await postJSON(`/api/sessions/${currentId}/messages/${messageId}/edit`, { content: newText })
        setMessages((prev) => {
          const next = [...prev]
          const i = next.findIndex((m) => m.id === messageId)
          if (i !== -1) next[i] = { ...next[i], id: r.id, content: newText }
          return next
        })
        if (nextMsg?.role === 'assistant') await regenerateMessage(nextMsg.id)
      } catch (e) {
        pushToast(e.message)
      }
    },
    [currentId, streaming, pushToast, regenerateMessage]
  )

  // Deck-questions answers: persist them into the block (so the box shows the
  // history on reload and stays editable), then either send the follow-up as a
  // new turn (first submit) or, when editing an already-answered box, edit the
  // follow-up user message and regenerate — reusing the existing edit flow.
  const submitQuestionAnswers = useCallback(
    async (text, { msgId, answers, isEdit } = {}) => {
      // persist answers into the block (best-effort — the turn still proceeds)
      let updatedBlocks = null
      if (msgId != null && currentId) {
        try {
          const r = await postJSON(
            `/api/sessions/${currentId}/messages/${msgId}/question-answers`,
            { answers }
          )
          updatedBlocks = r.blocks
        } catch (e) {
          pushToast(e.message)
        }
      }
      // reflect the persisted answers on the block locally
      if (updatedBlocks) {
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, blocks: updatedBlocks } : m))
        )
      }
      if (isEdit) {
        // find the follow-up user message right after this block's message and
        // edit it → that regenerates the assistant turn built from the answers
        const idx = messagesRef.current.findIndex((m) => m.id === msgId)
        const followUp = idx >= 0 ? messagesRef.current.slice(idx + 1).find((m) => m.role === 'user') : null
        if (followUp) await editUserMessage(followUp.id, text)
        else await sendMessage(text, []) // no follow-up existed yet — just send
      } else {
        await sendMessage(text, [])
      }
    },
    [currentId, pushToast, editUserMessage, sendMessage]
  )

  const stop = () => {
    abortRef.current?.abort()
    setStreaming(false)
  }

  // Stable across renders so memo(Message) can skip re-rendering finished
  // bubbles while another message streams (see the message list below).
  const speakText = useCallback((t) => speak(plainForSpeech(t), { lang: 'pt-BR' }), [])
  const openDeck = useCallback((deckId) => setDeckStudioId(deckId), [])
  const openSpreadsheet = useCallback((id) => setSpreadsheetStudioId(id), [])
  const openDocument = useCallback((id) => setDocumentStudioId(id), [])

  const currentTitle = sessions.find((s) => s.id === currentId)?.title

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        email={email}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        currentId={currentId}
        onNew={newChat}
        onSelect={openSession}
        onDelete={removeSession}
        deletingId={deletingId}
        onRename={renameSession}
        onClose={() => setSidebarOpen(false)}
        onOpenHistory={openHistory}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
        // expanded studio leaves only a narrow chat column — expanding the
        // sidebar there overlays the chat instead of squeezing it further;
        // with the studio in normal (split) mode it opens in-flow and the
        // chat simply shrinks
        overlay={!!deckStudioId && deckFocus}
      />

      {view === 'history' ? (
        <HistoryPage
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          currentId={currentId}
          onSelect={openSession}
          onNew={newChat}
          onDelete={removeSession}
          deletingId={deletingId}
          onRename={renameSession}
          onBack={closeHistory}
          onSearch={doSearch}
          searchResults={searchResults}
          searching={searching}
        />
      ) : (
      <main
        className={`flex-1 flex flex-col min-w-0 ${
          // manual HTML Edit mode hides the chat entirely so the slide gets the
          // full row (the Studio spans everything)
          deckEditFullscreen ? 'hidden' : ''
        } ${
          // focus mode: the chat column scales with the window (32%) instead
          // of a fixed 380px, so the composer isn't cramped on big screens
          deckStudioId && deckFocus ? 'md:flex-none md:w-[clamp(400px,32%,560px)] md:border-r md:border-[var(--border)]' : ''
        }`}
      >
        {/* top bar */}
        {/* relative z-40: backdrop-blur makes this header a stacking context;
            without an explicit z-index the ToolsPicker dropdown inside it gets
            painted UNDER later DOM siblings (messages, Deck Studio) */}
        <header className="relative z-40 h-14 shrink-0 flex items-center gap-3 px-3 md:px-5 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
          >
            <Icon.Menu size={20} />
          </button>
          <ModelPicker models={models} value={model} onChange={onChangeModel} disabled={streaming} />
          <ToolsPicker
            modelSupportsTools={models.find((m) => m.id === model)?.tools !== false}
            enabledTools={enabledTools}
            onChange={onChangeTools}
            disabled={streaming}
            toolPolicy={toolPolicy}
            onOpenMcpSettings={() => {
              setSettingsTab('mcp')
              setSettingsOpen(true)
            }}
          />
          {/* absolutely centered on the header (= visual center of the chat
              column) — as a flex child it would center in the leftover space
              right of the pickers and sit visibly off-center */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 max-w-[36%] text-sm font-medium truncate text-[var(--muted)] pointer-events-none hidden ${
              deckStudioId && deckFocus ? '' : 'md:block'
            }`}
          >
            {currentTitle || ''}
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] ml-auto"
            title={t('settings.title')}
          >
            <Icon.Settings size={19} />
          </button>
        </header>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {loadingSession ? (
            <SessionSkeleton />
          ) : messages.length === 0 ? (
            <Welcome />
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {messages.map((m, i) => (
                <Message
                  // stable id keys keep React from re-mounting bubbles as the
                  // list grows; fall back to index only for locally-appended
                  // rows that don't yet have a server id (streaming turn)
                  key={m.id ?? `local-${i}`}
                  msg={m}
                  models={models}
                  streaming={m.streaming}
                  onSpeak={speakText}
                  canRegenerate={!streaming && m.role === 'assistant'}
                  onRegenerate={regenerateMessage}
                  onSwitchVariant={switchVariant}
                  onEditUser={editUserMessage}
                  onOpenDeck={openDeck}
                  onOpenSpreadsheet={openSpreadsheet}
                  onOpenDocument={openDocument}
                  isLatest={i === messages.length - 1 && !streaming}
                  onSubmitAnswers={submitQuestionAnswers}
                />
              ))}
              {/* Recovery: the thread ends on a user message with no assistant
                  reply (server crashed / token expired mid-generation). There's
                  no assistant bubble to regenerate, so offer to produce the
                  missing answer instead of leaving the user stuck. */}
              {!streaming && messages[messages.length - 1]?.role === 'user' && (
                <div className="flex flex-col items-center gap-2 py-2 text-center animate-fade-in">
                  <p className="text-sm text-[var(--muted)]">
                    {t('chat.unanswered')}
                  </p>
                  <button
                    onClick={continueMessage}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-sm font-semibold hover:brightness-110 transition"
                  >
                    <Icon.Regenerate size={15} /> {t('chat.generateAnswer')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* composer */}
        <div className="shrink-0 pb-2">
          <div className="max-w-3xl mx-auto">
            <Composer
              value={input}
              onChange={setInput}
              onSend={(t, f) => sendMessage(t, f)}
              onStop={stop}
              streaming={streaming}
              files={files}
              setFiles={setFiles}
              supportedExt={supportedExt}
              mediaExt={mediaExt}
              onOpenVoice={() => setVoiceOpen(true)}
            />
          </div>
        </div>
      </main>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          setSettingsTab(null)
        }}
        initialTab={settingsTab}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        isAdmin={isAdmin}
        onModelsChanged={refreshModels}
        onCreateWithClaude={startSkillCreator}
        personal={{ theme, setTheme, uiLang, setUiLang, responseLang, setResponseLang, notify, setNotify, imageModel, setImageModel, imageModels, imageModelDefaultId }}
      />

      <VoiceOverlay
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onSend={(t) => sendMessage(t, [], { viaVoice: true })}
      />

      <DeckStudio
        open={!!deckStudioId}
        deckId={deckStudioId === 'streaming' ? null : deckStudioId}
        streamingDeck={deckStudioId === 'streaming' ? streamingDeck : null}
        onClose={() => {
          setDeckStudioId(null)
          setStreamingDeck(null)
        }}
        pushToast={pushToast}
        focus={deckFocus}
        onToggleFocus={() => setDeckFocus((f) => !f)}
        onEditModeChange={setDeckEditFullscreen}
        onDeckSession={setDeckSessionId}
        models={models}
        model={model}
      />

      <SpreadsheetStudio
        open={!!spreadsheetStudioId}
        spreadsheetId={spreadsheetStudioId}
        onClose={() => setSpreadsheetStudioId(null)}
        pushToast={pushToast}
        models={models}
        model={model}
      />

      <DocumentStudio
        open={!!documentStudioId}
        documentId={documentStudioId}
        onClose={() => setDocumentStudioId(null)}
        pushToast={pushToast}
        models={models}
        model={model}
      />

      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="flex items-start gap-2 rounded-xl bg-[var(--surface-3)] border border-[var(--border)] px-3.5 py-3 text-sm shadow-xl shadow-black/20 animate-slide-in-right"
            >
              <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--accent)]" />
              <span className="flex-1 min-w-0 break-words text-[var(--text)]">{toast.message}</span>
              <button
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 p-0.5 rounded-md text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition"
                title={t('common.dismiss')}
              >
                <Icon.Close size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
