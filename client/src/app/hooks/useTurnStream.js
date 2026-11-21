import { useCallback, useRef } from 'react'
import { getJSON, patchJSON, postJSON, streamChat, streamContinue, streamRegenerate } from '../../api.ts'
import { prepareMediaFiles } from '../../lib/mediaChunk.ts'
import { replaceHash } from '../../lib/hashRouter.ts'
import { insertCompactionDivider, parseCompactCommand } from '../../lib/compaction.ts'
import { reasoningEffortFor } from '../../lib/reasoningEffort.ts'

// The three turn routes (send = POST /api/chat, continue, regenerate) and the
// actions built on them (edit, question answers, retry). They share one SSE
// handler and one failure path, so a failed turn looks the same whichever
// route produced it: the user's prompt stays in the thread, the assistant row
// carries `error` and the chat shows an inline error with Retry.

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

// Shared SSE event handler for the three streaming flows (send / regenerate /
// continue). They differ only in HOW they locate & patch the target message
// (`setTarget`) and in a couple of flow-specific events (meta/title on send);
// everything else — tokens, tool chips, skill badges, blocks, errors — is
// identical, so it lives here once. `accRef` holds the running text buffer
// (mutable so token/blocks can rewrite it). `opts` supplies flow-specific
// hooks: onMeta, onTitle. Returns an (ev) => void for the stream consumer.
//   setTarget(patch): patch may be an object (merged) or a fn (prev => next).
// `onError(text)` reports a stream `error` event (and the deck failure notice);
// the events are also kept in `handler.streamErrors` for detectTurnFailure.
export function makeSSEHandler({ setTarget, accRef, onError, setDeckStudioId, setStreamingDeck, onMeta, onTitle, deckFailMsg }) {
  // Deck streaming lifecycle guard: `deck_stream_start` opens the Studio in a live
  // "Building the slides…" state, and normally the `blocks` event (carrying the
  // persisted deck) supersedes it. If the turn ends WITHOUT ever delivering a deck
  // — the model's outline came back truncated/unparseable (common with
  // reasoning-heavy models that spend the token budget on thinking), the stream
  // errored, or was aborted — nothing would otherwise clear the streaming state and
  // the Studio spins forever (the reported bug). We track both edges and, in
  // finalize (run in every stream `finally`), tear the streaming deck down and
  // surface an honest error instead of leaving a dead spinner.
  let deckStreamStarted = false
  let deckDelivered = false
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
  const streamErrors = []
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
        // `total` (slides planned) drives "Building slide N of M"; absent when the
        // model writes the deck inline and the count is unknown until it ends
        setStreamingDeck?.({ title: ev.title || '', total: Number.isInteger(ev.total) ? ev.total : null, slides: [], meta: { format: 'html' }, streaming: true })
        setDeckStudioId?.('streaming')
        deckStreamStarted = true
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
            deckDelivered = true
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
        streamErrors.push(ev.error)
        onError?.(ev.error)
        accRef.value += (accRef.value ? '\n\n' : '') + `⚠️ ${ev.error}`
        setTarget({ content: accRef.value })
        break
      default:
        break
    }
  }
  handler.streamErrors = streamErrors
  handler.text = () => accRef.value
  // Cancel any scheduled frame and paint the final accumulated text once, so
  // the last tokens land even if the stream ends between frames. Callers invoke
  // this before their authoritative reload.
  handler.finalize = () => {
    if (rafId != null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    setTarget({ content: accRef.value })
    // Streaming deck announced but never delivered → tear down the "Building the
    // slides…" state so the Studio doesn't spin forever, and tell the user why.
    if (deckStreamStarted && !deckDelivered) {
      setStreamingDeck?.(null)
      setDeckStudioId?.((id) => (id === 'streaming' ? null : id))
      if (deckFailMsg) onError?.(deckFailMsg)
    }
  }
  return handler
}

const NOTICE_RE = /(^|\n\n)⚠️ [^\n]*/g

/**
 * Did the turn fail (as opposed to finishing with a notice)? A thrown error
 * other than an abort always counts; stream `error` events count only when no
 * answer came with them (a truncation notice after half an answer is part of
 * the answer). Returns `{ error }` (the raw message) or null.
 */
export function detectTurnFailure({ thrown, streamErrors = [], text = '' }) {
  if (thrown) return thrown.name === 'AbortError' ? null : { error: thrown.message || String(thrown) }
  if (!streamErrors.length) return null
  return stripNotices(text) ? null : { error: streamErrors[streamErrors.length - 1] }
}

/** The streamed answer without the inline `⚠️ …` notices the handler appends. */
export function stripNotices(text = '') {
  return text.replace(NOTICE_RE, '').trim()
}

const failedRow = ({ partial, model, error, retry }) => ({ role: 'assistant', content: partial || '', model, local: true, error: { message: error, retry } })

/**
 * The thread after a failed turn, built on the server's copy of it (the reload
 * gives the stored rows their ids). `failure.route` is the route that failed:
 * - send: the prompt may or may not have been stored. Stored prompt → an error
 *   row after it (retry = continue); stored answer → that answer is marked
 *   (retry = regenerate); nothing stored → the local prompt comes back, then the
 *   error row (retry = send again, with the same files).
 * - continue: the error row goes after the unanswered prompt.
 * - regenerate: the regenerated message is marked (its old answer stays).
 */
export function reconcileFailedTurn(serverMessages, failure) {
  const list = serverMessages || []
  const { route, prompt, attachments, files, error, partial, model, messageId, knownIds } = failure
  // rows that existed before this turn never belong to it (a repeated prompt
  // must not mark the previous answer, or hide the new prompt)
  const known = new Set((knownIds || []).map(String))
  const isNew = (m) => m && (m.id == null || !known.has(String(m.id)))
  const last = list[list.length - 1]
  const mark = (i, retry) => list.map((m, j) => (j === i ? { ...m, error: { message: error, retry } } : m))
  if (route === 'regenerate') {
    const i = list.findIndex((m) => m.id === messageId)
    return i === -1 ? list : mark(i, { route: 'regenerate', messageId })
  }
  const prev = list[list.length - 2]
  if (last?.role === 'assistant' && last.id != null && isNew(last) && prev?.role === 'user' && (route === 'continue' || prev.content === prompt)) {
    return mark(list.length - 1, { route: 'regenerate', messageId: last.id })
  }
  if (route === 'continue' || (last?.role === 'user' && last.content === prompt && isNew(last))) {
    return [...list, failedRow({ partial, model, error, retry: { route: 'continue' } })]
  }
  return [
    ...list,
    { role: 'user', content: prompt, attachments, local: true },
    failedRow({ partial, model, error, retry: { route: 'send', prompt, files: files || [] } }),
  ]
}

/**
 * What Retry does for the failed row at `index`:
 * `{ route: 'send', prompt, files, keep }` / `{ route: 'continue', keep }` —
 * keep the first `keep` rows, drop the failed ones, run the route — or
 * `{ route: 'regenerate', messageId }`. null when the row did not fail.
 */
export function retryPlan(messages, index) {
  const retry = messages?.[index]?.error?.retry
  if (!retry) return null
  if (retry.route === 'regenerate') return { route: 'regenerate', messageId: retry.messageId }
  if (retry.route === 'continue') return { route: 'continue', keep: index }
  return { route: 'send', prompt: retry.prompt, files: retry.files || [], keep: Math.max(0, index - 1) }
}

/**
 * The turn actions. `s` = useSessions(), `cfg` = useSettingsState(),
 * `studios` = useStudios(); `notifyError` shows a friendly toast.
 */
export function useTurnStream({ s, cfg, studios, notifyError, pushToast, t, uiLang }) {
  const abortRef = useRef(null)
  const { currentId, streaming, setStreaming, setMessages, messagesRef, stickToBottomRef, setCurrentId, setSessions, loadSessions, systemPrompt, enabledTools, setInput, setFiles } = s
  const { model, imageModel, responseLang, notify } = cfg
  const { setDeckStudioId, setStreamingDeck } = studios
  // `reasoning_effort` is a getter on purpose: the send/regenerate/continue callbacks are memoized on
  // other deps, and the effort lives in a store, so it must be read when the body is serialized.
  const turnBody = {
    model,
    imageModel: imageModel || undefined,
    systemPrompt,
    responseLang,
    uiLang,
    enabledTools,
    get reasoning_effort() {
      return reasoningEffortFor(cfg.models, model)
    },
  }

  const handlerFor = (setTarget, extra = {}) =>
    makeSSEHandler({ setTarget, accRef: { value: '' }, onError: notifyError, setDeckStudioId, setStreamingDeck, deckFailMsg: t('message.deck.failed'), ...extra })

  // shared tail of the three routes: paint the last tokens, reload the thread
  // (server ids, blocks, variants) and, if the turn failed, rebuild the failure
  // on top of the reloaded thread
  const finishTurn = async (handler, { thrown, sessionId, failure, beforeReload }) => {
    const knownIds = failure.knownIds
    handler.finalize()
    setStreaming(false)
    abortRef.current = null
    await beforeReload?.()
    const failed = detectTurnFailure({ thrown, streamErrors: handler.streamErrors, text: handler.text() })
    const id = typeof sessionId === 'function' ? sessionId() : sessionId
    let reloaded = null
    if (id) {
      try {
        reloaded = (await getJSON(`/api/sessions/${id}/messages`)).messages
      } catch (e) {
        if (!failed) notifyError(e)
      }
    }
    if (failed) {
      setMessages((prev) => {
        // no reload (a new chat that failed before it got an id, or the reload
        // failed too): the thread is what we showed, minus the rows this turn
        // appended (send: prompt + bubble; continue: bubble)
        const drop = { send: 2, continue: 1 }[failure.route] || 0
        const base = reloaded || prev.slice(0, prev.length - drop).map((m) => (m.streaming ? { ...m, streaming: false } : m))
        if (failure.route === 'regenerate' && !base.some((m) => m.id === failure.messageId)) notifyError(failed.error)
        return reconcileFailedTurn(base, { ...failure, knownIds, error: failed.error, partial: stripNotices(handler.text()), model })
      })
    } else if (reloaded) {
      setMessages(reloaded)
    } else {
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)))
    }
  }

  // /compactar: fold the conversation so far into a summary (server/compaction.js).
  // Not a turn: no message is sent to the model; the divider appears in the thread.
  const compactCurrentConversation = useCallback(
    async (instructions = '') => {
      if (!currentId) return pushToast(t('compaction.nothingYet'))
      try {
        const r = await postJSON(`/api/sessions/${currentId}/compact`, { model, instructions })
        setMessages((prev) => insertCompactionDivider(prev, r.compaction))
        pushToast(t('compaction.done'))
      } catch (e) {
        if (e.message === 'nothing_to_compact') pushToast(t('compaction.nothingToCompact'))
        else pushToast({ message: t('compaction.failed'), detail: e.message, tone: 'error' })
      }
    },
    [currentId, model, pushToast, t, setMessages]
  )

  // core: send a turn, stream the answer, resolve with final text (for voice)
  const sendMessage = useCallback(
    async (text, fileList = [], { keepDraft = false } = {}) => {
      const prompt = (text || '').trim()
      if ((!prompt && fileList.length === 0) || streaming) return ''
      const compactInstructions = fileList.length === 0 ? parseCompactCommand(prompt) : null
      if (compactInstructions !== null) {
        setInput('')
        await compactCurrentConversation(compactInstructions)
        return ''
      }
      // the ORIGINAL filenames are what the user sees (chunking is an
      // implementation detail); keep them for the attachment chips
      const attachments = fileList.length ? JSON.stringify(fileList.map((f) => f.name)) : null
      const userMsg = { role: 'user', content: prompt, attachments }
      const asstMsg = { role: 'assistant', content: '', model, streaming: true }
      const knownIds = messagesRef.current.filter((m) => m.id != null).map((m) => m.id)
      // sending a message is an explicit "take me to the conversation tail"
      stickToBottomRef.current = true
      setMessages((prev) => [...prev, userMsg, asstMsg])
      // a Retry must not wipe what the user started typing meanwhile
      if (!keepDraft) {
        setInput('')
        setFiles([])
      }
      setStreaming(true)

      const ctrl = new AbortController()
      abortRef.current = ctrl
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
      // `ephemeral` is read by the server only when this message creates the chat (W3-6)
      const startsTemporary = !currentId && s.pendingEphemeral === true
      // `projectId` too: a new chat started from a project's "new chat" lives in that project (W3-2).
      // A temporary chat can never be in a project, so it never carries one.
      const inProject = !currentId && !startsTemporary && s.pendingProjectId ? { projectId: s.pendingProjectId } : {}
      fd.append('payload', JSON.stringify({ sessionId: currentId, ...(startsTemporary ? { ephemeral: true } : {}), ...inProject, ...turnBody, prompt }))
      for (const f of uploadFiles) fd.append('files', f)

      const handler = handlerFor(setLast, {
        onMeta: (ev) => {
          createdId = ev.sessionId
          if (ev.isNew) {
            if (startsTemporary) s.markTemporary?.(ev.sessionId)
            s.clearPendingProject?.()
            setCurrentId(ev.sessionId)
            // gives the freshly-created session a URL without adding a
            // back-button entry — the user didn't "navigate" here, the
            // page they're already looking at just now has an id
            replaceHash('#/chat/' + ev.sessionId)
          }
        },
        onTitle: (ev) => setSessions((prev) => prev.map((x) => (x.id === ev.sessionId ? { ...x, title: ev.title } : x))),
      })
      let thrown = null
      try {
        await streamChat(fd, handler, ctrl.signal)
      } catch (e) {
        thrown = e
      }
      // reload the thread so the just-streamed user + assistant rows pick up
      // their server-assigned ids (and blocks/tool_calls/variants). Without
      // this, the locally-appended messages have no id, so a later edit/
      // regenerate would POST to /messages/undefined/* — the server then
      // queries `WHERE id = 'undefined'` and Postgres throws
      // "invalid input syntax for type bigint".
      await finishTurn(handler, {
        thrown,
        sessionId: () => createdId || currentId,
        failure: { route: 'send', prompt, attachments, files: fileList, knownIds },
        beforeReload: async () => {
          notifyTurnDone(notify, t)
          await loadSessions()
          if (createdId) setCurrentId((c) => c || createdId)
        },
      })
      return handler.text()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentId, s.pendingEphemeral, s.markTemporary, model, imageModel, systemPrompt, responseLang, uiLang, enabledTools, notify, streaming, loadSessions, compactCurrentConversation]
  )

  // Regenerates one assistant turn in place: the slot keeps its position in
  // the thread, the old answer becomes a browsable version instead of being
  // discarded, and a follow-up reload picks up the server-assigned id +
  // full variants list (simpler and less error-prone than reconstructing it
  // client-side from SSE events alone).
  const regenerateMessage = useCallback(
    async (messageId) => {
      if (streaming || !currentId) return
      if (!messagesRef.current.some((m) => m.id === messageId)) return
      const setTarget = (patch) =>
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === messageId)
          if (i === -1) return prev
          const next = [...prev]
          next[i] = typeof patch === 'function' ? patch(next[i]) : { ...next[i], ...patch }
          return next
        })
      setTarget({ content: '', blocks: undefined, toolCalls: undefined, activeSkills: undefined, reasoning: undefined, error: undefined, streaming: true })
      setStreaming(true)
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const handler = handlerFor(setTarget)
      let thrown = null
      try {
        await streamRegenerate(currentId, messageId, turnBody, handler, ctrl.signal)
      } catch (e) {
        thrown = e
      }
      await finishTurn(handler, { thrown, sessionId: currentId, failure: { route: 'regenerate', messageId } })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentId, model, imageModel, systemPrompt, responseLang, uiLang, enabledTools, streaming, notifyError]
  )

  // Recovery for a session that ends on an unanswered user message (server
  // crashed / token expired mid-turn, so the assistant reply was never
  // created). There's no assistant bubble to regenerate, so this appends a
  // fresh streaming one and asks the server to produce the missing reply.
  const continueMessage = useCallback(async () => {
    if (streaming || !currentId) return
    const knownIds = messagesRef.current.filter((m) => m.id != null).map((m) => m.id)
    stickToBottomRef.current = true
    setMessages((prev) => [...prev, { role: 'assistant', content: '', model, streaming: true }])
    setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const setLast = (patch) =>
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = typeof patch === 'function' ? patch(last) : { ...last, ...patch }
        return next
      })
    const handler = handlerFor(setLast)
    let thrown = null
    try {
      await streamContinue(currentId, turnBody, handler, ctrl.signal)
    } catch (e) {
      thrown = e
    }
    await finishTurn(handler, { thrown, sessionId: currentId, failure: { route: 'continue', knownIds } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, model, imageModel, systemPrompt, responseLang, uiLang, enabledTools, streaming, notifyError])

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
        notifyError(e)
      }
    },
    [streaming, notifyError, setMessages]
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
        notifyError(e)
      }
    },
    [currentId, streaming, notifyError, regenerateMessage, setMessages, messagesRef]
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
          const r = await postJSON(`/api/sessions/${currentId}/messages/${msgId}/question-answers`, { answers })
          updatedBlocks = r.blocks
        } catch (e) {
          notifyError(e)
        }
      }
      if (updatedBlocks) setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, blocks: updatedBlocks } : m)))
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
    [currentId, notifyError, editUserMessage, sendMessage, setMessages, messagesRef]
  )

  // Retry on an inline turn error (ChatView): drop the failed rows, run the
  // route that failed again (see retryPlan).
  const retryTurn = useCallback(
    async (index) => {
      if (streaming) return
      const plan = retryPlan(messagesRef.current, index)
      if (!plan) return
      if (plan.route === 'regenerate') return regenerateMessage(plan.messageId)
      setMessages((prev) => prev.slice(0, plan.keep))
      if (plan.route === 'continue') return continueMessage()
      return sendMessage(plan.prompt, plan.files, { keepDraft: true })
    },
    [streaming, regenerateMessage, continueMessage, sendMessage, setMessages, messagesRef]
  )

  const stop = () => {
    abortRef.current?.abort()
    setStreaming(false)
  }

  return { sendMessage, regenerateMessage, continueMessage, switchVariant, editUserMessage, submitQuestionAnswers, retryTurn, stop, compactCurrentConversation }
}
