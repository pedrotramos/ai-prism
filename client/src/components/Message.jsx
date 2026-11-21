import { memo, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import Logo from './Logo.jsx'
import BlockRenderer from './blocks/BlockRenderer.jsx'
import { BlockErrorBoundary } from '../app/ErrorBoundary.jsx'
import LoadingChip from './blocks/LoadingChip.jsx'
import Markdown from './message/Markdown.jsx'
import ToolCallChip from './message/ToolCallChip.jsx'
import ReasoningTrace from './message/ReasoningTrace.jsx'
import ThinkingIndicator from './message/ThinkingIndicator.jsx'
import NoticeCard from './message/NoticeCard.jsx'
import ActionButton from './message/ActionButton.jsx'
import CopyButton from './message/CopyButton.jsx'
import { coerceAttachments, splitTrailingNotice, showThinkingRow, showActionToolbar } from './message/logic.js'
import './message/message.css'
import { exportMessageToPdf } from '../pdfExport.ts'
import { useT, useI18n } from '../lib/i18n.jsx'
import { localizedSkill } from '../lib/systemSkills.ts'
import { shortMessageDate } from '../lib/date.ts'
import CostBadge, { fmtCost, estimateCost } from './CostBadge.jsx'

const MARKER = '\n\n--- ANEXOS ---'
const FENCE_START = '```prism-block'
const PLACEHOLDER_RE = /\{\{(block:\d+|toolcall:[^}]+)\}\}/g

function stripAttachments(content) {
  const s = typeof content === 'string' ? content : ''
  const i = s.indexOf(MARKER)
  return i >= 0 ? s.slice(0, i) : s
}

// Scans one prose chunk for a still-typing ```prism-block fence (only
// possible while streaming — resolved fences never appear raw, they're
// swapped for a {{block:N}} placeholder in one shot) and emits a loading
// chip in its place instead of the raw, meaningless JSON fence text.
// Sniffs the artifact kind out of a still-typing ```prism-block fence so the
// loading chip can name it precisely ("Preparando gráfico" vs "…apresentação").
// The fence body is partial JSON, so we can't JSON.parse it — a tolerant regex
// on the "type" field is enough, and we map deck→apresentação, chart→gráfico,
// etc. Falls back to the generic label when the type hasn't been emitted yet.
function sniffFenceKind(fenceText) {
  const m = /"type"\s*:\s*"([a-z-]+)"/i.exec(fenceText)
  return m ? m[1] : null
}

// Finds the end of the JSON object that starts at/after `from` by counting
// braces (respecting string literals + escapes), so a ``` inside the block's
// JSON (fenced code in a document's markdown) doesn't end the scan early — the
// same reason the server scans by balance. Returns the index just past the
// closing `}`, or -1 if the object isn't complete yet (still streaming).
function jsonObjectEnd(s, from) {
  let i = from
  while (i < s.length && s[i] !== '{') i++
  if (i >= s.length) return -1
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i + 1
  }
  return -1
}

function pushProse(segments, s, streaming) {
  if (!streaming) {
    if (s.trim()) segments.push({ kind: 'md', text: s })
    return
  }
  let i = 0
  while (true) {
    const start = s.indexOf(FENCE_START, i)
    if (start === -1) {
      const tail = s.slice(i)
      if (tail.trim()) segments.push({ kind: 'md', text: tail })
      break
    }
    const before = s.slice(i, start)
    if (before.trim()) segments.push({ kind: 'md', text: before })
    // Locate the JSON object's real end by brace balance (``` -agnostic).
    const jsonEnd = jsonObjectEnd(s, start + FENCE_START.length)
    const fenceText = s.slice(start, jsonEnd === -1 ? undefined : jsonEnd)
    segments.push({ kind: 'loading', blockType: sniffFenceKind(fenceText) })
    if (jsonEnd === -1) break // JSON not closed yet — model is still typing it
    // skip past the JSON and an optional closing ``` fence
    let end = jsonEnd
    const tail = s.slice(end).match(/^[ \t]*\r?\n?```/)
    if (tail) end += tail[0].length
    // drop a stray run of JSON structural punctuation (e.g. an over-closing "]}")
    // the model sometimes appends after the fence — mirrors extractPrismBlocks so
    // it doesn't flash as prose while streaming.
    const orphan = s.slice(end).match(/^[ \t]*[\]})\s,]*[\]})][ \t]*(?=\r?\n|$)/)
    if (orphan) end += orphan[0].length
    i = end
  }
}

/**
 * Splits message text into an ordered list of renderable segments — markdown
 * prose, resolved chart/insight blocks, tool-call chips, and (while
 * streaming) loading chips right where the model is mid-way through emitting
 * a ```prism-block fence — so everything lands exactly where it happened in
 * the conversation instead of piling up in separate groups.
 *
 * Both `{{block:N}}` and `{{toolcall:ID}}` are inline position markers the
 * backend writes into `content` (mirrored client-side during live streaming
 * — see the `tool_call` SSE handler in App.jsx) — never shown to the model,
 * purely so this renderer can reconstruct the original order.
 */
function splitSegments(text, blocks, toolCalls, streaming) {
  const segments = []
  let last = 0
  let m
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(text))) {
    pushProse(segments, text.slice(last, m.index), streaming)
    const [kind, ref] = m[1].split(':')
    if (kind === 'block') {
      const block = blocks?.[Number(ref)]
      if (block) segments.push({ kind: 'block', block })
    } else {
      const tc = toolCalls?.find((t) => String(t.id) === ref)
      if (tc) segments.push({ kind: 'toolcall', tc })
    }
    last = PLACEHOLDER_RE.lastIndex
  }
  pushProse(segments, text.slice(last), streaming)
  return segments
}

// Which built-in artifact a turn is generating, from the active-skill names the
// router emits (see server SYSTEM_SKILLS). Used to turn a long, silent
// "Thinking…" into a purposeful "Designing your deck…" so a heavy generation
// (which streams no prose until the block is ready) never reads as frozen.
const BUILDING_LABEL = {
  'deck-generation': 'message.building.deck',
  'pptx-adjust': 'message.building.deck',
  'spreadsheet-generation': 'message.building.spreadsheet',
  'document-generation': 'message.building.document',
  'image-generation': 'message.building.image',
}
function buildingKeyFrom(activeSkills) {
  for (const sk of activeSkills || []) {
    if (BUILDING_LABEL[sk?.name]) return BUILDING_LABEL[sk.name]
  }
  return null
}

// `msg.error` (set by the shell on a failed /chat, /continue or /regenerate)
// is a string or { message, prompt }.
function errorInfo(error) {
  if (!error) return null
  if (typeof error === 'string') return { message: error, prompt: null }
  return { message: error.message || String(error), prompt: error.prompt || null }
}

/**
 * One chat row. Props beyond the original set (all optional, wired by the
 * shell): `onRetry(msg)` re-runs a failed turn that has no server id yet,
 * `onContinue(msg)` continues a turn that stopped early. Without them, Retry
 * falls back to `onRegenerate(msg.id)` for persisted rows.
 */
function Message({ msg, models, onSpeak, onRegenerate, onRetry, onContinue, onSwitchVariant, onEditUser, onOpenDeck, onOpenSpreadsheet, onOpenDocument, canRegenerate, streaming, isLatest, onSubmitAnswers, author }) {
  const t = useT()
  const { locale } = useI18n()
  const isUser = msg.role === 'user'
  const text = stripAttachments(msg.content)
  // a trailing ⚠️/ℹ️ paragraph (truncation, stopped early, stream error)
  // becomes a notice card with its recovery action, not a line of prose
  const { body, notice } = isUser ? { body: text, notice: null } : splitTrailingNotice(text)
  const toolCalls = msg.toolCalls || msg.tool_calls
  const segments = isUser ? [] : splitSegments(body, msg.blocks, toolCalls, streaming)
  // which heavy artifact (if any) this turn is generating — turns a silent
  // "Thinking…" into a purposeful "Designing your deck…" during long generations
  const buildingKey = buildingKeyFrom(msg.activeSkills)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [actionsOpen, setActionsOpen] = useState(false)
  const exportRef = useRef(null)
  // legacy safety net: messages persisted before {{toolcall:ID}} markers
  // existed have tool calls but no matching marker in their content — show
  // those (only those) the old way, grouped above the answer
  const referencedToolCallIds = new Set(segments.filter((s) => s.kind === 'toolcall').map((s) => s.tc.id))
  const unreferencedToolCalls = (toolCalls || []).filter((tc) => !referencedToolCallIds.has(tc.id))
  // for copy/speak: plain prose only, placeholders (and any dangling live
  // fence) stripped since they're not meant to be read/copied literally
  const plainText = body
    .replace(PLACEHOLDER_RE, '')
    .replace(/```prism-block[\s\S]*?(```|$)/g, '')
    .trim()
  const attachments = coerceAttachments(msg.attachments)

  const variants = msg.variants
  const variantIndex = variants ? variants.findIndex((v) => v.id === msg.id) : -1
  const hasVariants = variants && variants.length > 1 && variantIndex !== -1

  const meta = models.find((m) => m.id === msg.model)
  const pt = msg.prompt_tokens
  const ct = msg.completion_tokens
  // only estimate when the model actually has list prices — an uncurated,
  // unpriced endpoint has meta.in/out undefined, which would render "$NaN".
  const cost = estimateCost({ prompt_tokens: pt, completion_tokens: ct }, meta)

  if (isUser) {
    const commitEdit = () => {
      const trimmed = draft.trim()
      setEditing(false)
      if (trimmed && trimmed !== text) onEditUser(msg.id, trimmed)
      else setDraft(text)
    }

    if (editing) {
      return (
        <div data-msg-role="user" className="flex justify-end animate-fade-in">
          <div className="max-w-[85%] md:max-w-[75%] w-full">
            <textarea
              autoFocus
              aria-label={t('common.edit')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitEdit()
                }
                if (e.key === 'Escape') {
                  setEditing(false)
                  setDraft(text)
                }
              }}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              className="w-full rounded-card rounded-tr-badge bg-bubble-user px-4 py-2.5 text-body leading-relaxed border border-accent resize-none"
            />
            <div className="flex justify-end gap-2 mt-1.5">
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setDraft(text)
                }}
                className="tap-target text-label px-3 rounded-control hover:bg-surface-3 text-muted transition-colors duration-fast"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={commitEdit}
                className="tap-target text-label px-3 rounded-control bg-accent-strong text-on-accent font-semibold hover:brightness-110 transition duration-fast"
              >
                {t('message.saveAndRegenerate')}
              </button>
            </div>
          </div>
        </div>
      )
    }

    const msgDate = shortMessageDate(msg.created_at, locale)

    return (
      <div data-msg-role="user" data-actions-open={actionsOpen} className="msg-row flex justify-end animate-fade-in">
        <div className="max-w-[85%] md:max-w-[75%]">
          {/* shared (project) chat: who sent it (sent_by); a legacy row has none */}
          {author && (
            <p data-msg-author className="mb-1 text-right text-caption font-medium text-muted truncate" title={author}>
              {author}
            </p>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end mb-1.5">
              {attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1 text-caption bg-surface-3 text-muted rounded-badge px-2 py-1 max-w-full">
                  <Icon.File size={12} className="shrink-0" /> <span className="truncate">{a}</span>
                </span>
              ))}
            </div>
          )}
          <div
            data-msg-bubble
            // touch has no hover: a tap on the bubble reveals (or hides) its actions
            onPointerUp={(e) => {
              if (e.pointerType !== 'mouse') setActionsOpen((o) => !o)
            }}
            className="rounded-card rounded-tr-badge bg-bubble-user px-4 py-2.5 text-body leading-relaxed whitespace-pre-wrap"
          >
            {text}
          </div>
          {/* Discreet action row UNDER the bubble: the date and actions reveal on
              hover or keyboard focus, and on touch after a tap on the bubble. */}
          <div data-msg-actions className="flex items-center justify-end gap-0.5 mt-1 text-caption text-faint">
            {msgDate && (
              <span className="msg-reveal mr-1" title={new Date(msg.created_at).toLocaleString(locale)}>
                {msgDate}
              </span>
            )}
            {onEditUser && !streaming && (
              <ActionButton
                className="msg-reveal"
                label={t('common.edit')}
                onClick={() => {
                  setDraft(text)
                  setEditing(true)
                }}
              >
                <Icon.Pencil size={14} />
              </ActionButton>
            )}
            <CopyButton className="msg-reveal" text={text} label={t('message.copyPrompt')} />
          </div>
        </div>
      </div>
    )
  }

  const err = errorInfo(msg.error)
  // an empty, finished row (the request failed before any token arrived) gets
  // an inline notice instead of a bare avatar with dead actions
  const emptyRow = !streaming && !err && !notice && segments.length === 0 && unreferencedToolCalls.length === 0 && !msg.reasoning
  const retry = onRetry ? () => onRetry(msg) : canRegenerate && msg.id != null ? () => onRegenerate(msg.id) : null
  const cont = onContinue && !streaming ? () => onContinue(msg) : null
  const toolbar = showActionToolbar({ streaming, error: err || emptyRow, notice, plainText, segments })
  // the model / tokens / cost line stays on a failed partial answer (its spend
  // is real); only the actions go away
  const footer = !streaming && !emptyRow && Boolean(toolbar || meta || pt || ct)
  const last = segments[segments.length - 1]

  return (
    <div data-msg-role="assistant" className="flex gap-3 animate-fade-in">
      <div className="shrink-0 mt-0.5 w-8 h-8 rounded-control bg-surface-2 border border-border grid place-items-center text-fg" aria-hidden>
        <Logo size={18} />
      </div>
      <div className="min-w-0 flex-1">
        {/* ephemeral skill badge: which authored skill(s) the router activated
            for this turn. Only while streaming — not persisted. */}
        {streaming && msg.activeSkills?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 animate-fade-in">
            {msg.activeSkills.map((sk) => (
              <span
                key={sk.name}
                title={localizedSkill(t, sk).description}
                className="inline-flex items-center gap-1.5 text-caption font-medium text-accent-text bg-accent-soft rounded-pill pl-1.5 pr-2.5 py-1"
              >
                <Icon.SkillGlyph size={13} className="shrink-0" />
                {localizedSkill(t, sk).title}
              </span>
            ))}
          </div>
        )}
        {/* the answer region: announced politely, and only once complete
            (aria-busy while tokens stream) */}
        <div ref={exportRef} aria-live="polite" aria-busy={streaming ? 'true' : 'false'}>
          {unreferencedToolCalls.length > 0 && (
            <div>
              {unreferencedToolCalls.map((tc, i) => (
                <ToolCallChip key={tc.id || i} tc={tc} />
              ))}
            </div>
          )}
          {msg.reasoning && <ReasoningTrace text={msg.reasoning} hasAnswer={segments.some((s) => s.kind === 'md')} />}
          <div className="prose-chat">
            {segments.map((seg, i) => {
              if (seg.kind === 'md') return <Markdown key={i} text={seg.text} streaming={!!streaming} />
              if (seg.kind === 'block')
                // one malformed block becomes an inline block card; the prose
                // and the other blocks of this message keep rendering. A new
                // block object (regenerate, reload) gets a fresh attempt.
                return (
                  <BlockErrorBoundary key={i} blockType={seg.block?.type} resetKey={seg.block}>
                    <BlockRenderer
                      blocks={[seg.block]}
                      msgId={msg.id}
                      models={models}
                      onOpenDeck={onOpenDeck}
                      onOpenSpreadsheet={onOpenSpreadsheet}
                      onOpenDocument={onOpenDocument}
                      isLatest={isLatest}
                      onSubmitAnswers={onSubmitAnswers}
                    />
                  </BlockErrorBoundary>
                )
              if (seg.kind === 'toolcall') return <ToolCallChip key={i} tc={seg.tc} />
              if (seg.kind === 'loading') return <LoadingChip key={i} blockType={seg.blockType} />
              return null
            })}
            {/* one progress signal at a time (showThinkingRow): the cursor while
                prose streams, the chip while a tool runs or a block is typed,
                the Thinking row only when nothing else shows the turn is alive */}
            {streaming && last?.kind === 'md' && <span className="stream-cursor" />}
            {showThinkingRow({ streaming, segments }) && (
              <div className={segments.length ? 'mt-2' : ''}>
                <ThinkingIndicator buildingKey={buildingKey} />
              </div>
            )}
          </div>
          {err ? (
            <NoticeCard kind="error" text={err.message} onRetry={retry} prompt={err.prompt} />
          ) : notice ? (
            <NoticeCard kind={notice.kind} text={notice.text} onRetry={streaming ? null : retry} onContinue={notice.kind === 'stopped' ? cont : null} />
          ) : emptyRow ? (
            <NoticeCard kind="error" text={t('message.emptyAnswer')} onRetry={retry} />
          ) : null}
        </div>

        {footer && (
          // two cohesive groups that wrap: when the chat column narrows (studio
          // focus mode) the buttons stay on one line and the model/token/cost
          // info drops to its own line — never overflowing
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 mt-2 text-caption text-faint">
            {toolbar && (
              <span data-msg-actions role="toolbar" aria-label={t('message.actions')} className="inline-flex items-center gap-0.5">
                {hasVariants && (
                  <span className="inline-flex items-center gap-0.5 mr-0.5">
                    <ActionButton
                      label={t('message.previousVersion')}
                      disabled={variantIndex === 0}
                      onClick={() => onSwitchVariant(msg.id, variants[variantIndex - 1].id)}
                    >
                      <Icon.ChevronLeft size={14} />
                    </ActionButton>
                    <span className="tabular-nums px-0.5">
                      {variantIndex + 1}/{variants.length}
                    </span>
                    <ActionButton
                      label={t('message.nextVersion')}
                      disabled={variantIndex === variants.length - 1}
                      onClick={() => onSwitchVariant(msg.id, variants[variantIndex + 1].id)}
                    >
                      <Icon.ChevronRight size={14} />
                    </ActionButton>
                    <span className="mx-1 w-px h-3 bg-border" aria-hidden />
                  </span>
                )}
                <CopyButton text={plainText} />
                <ActionButton label={t('message.listenResponse')} onClick={() => onSpeak(plainText)}>
                  <Icon.Speaker size={15} />
                </ActionButton>
                <ActionButton label={t('message.exportPdf')} onClick={() => exportMessageToPdf(exportRef.current, t('message.pdfTitle'))}>
                  <Icon.FileText size={15} />
                </ActionButton>
                {canRegenerate && (
                  <ActionButton label={t('message.regenerate')} onClick={() => onRegenerate(msg.id)}>
                    <Icon.Regenerate size={15} />
                  </ActionButton>
                )}
              </span>
            )}
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {meta && <span className="font-medium text-muted">{meta.label}</span>}
              {(pt || ct) && (
                <span title={t('message.tokensInOut')}>
                  · {pt ?? '–'}↑ {ct ?? '–'}↓
                </span>
              )}
              {cost != null && <span title={t('message.estimatedCost')}>· ~{fmtCost(cost)}</span>}
            </span>
            {/* Two-model media pipeline disclosure: the audio/video was read by a
                different model (Gemini) than the one that wrote this answer. */}
            {msg.media_processing?.model && (
              <span
                className="inline-flex items-center gap-1 whitespace-nowrap"
                title={t('message.mediaProcessedTitle', {
                  files: (msg.media_processing.files || []).join(', '),
                })}
              >
                <Icon.Waveform size={12} className="shrink-0 opacity-70" />
                {t('message.mediaProcessedBy', {
                  model: models.find((m) => m.id === msg.media_processing.model)?.label || 'Gemini',
                })}
                {msg.media_processing.usage && (
                  <>
                    {' · '}
                    <CostBadge usage={msg.media_processing.usage} model={msg.media_processing.model} models={models} />
                  </>
                )}
              </span>
            )}
            {/* Intent-classifier disclosure: a cheap/fast model read the
                request's intent before the answer; its spend is shown. */}
            {msg.intent_classify?.usage && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap" title={t('message.intentClassifyTitle')}>
                <Icon.Sparkle size={12} className="shrink-0 opacity-70" />
                {t('message.intentClassifyBy', {
                  model: models.find((m) => m.id === msg.intent_classify.model)?.label || 'Haiku',
                })}
                {' · '}
                <CostBadge usage={msg.intent_classify.usage} model={msg.intent_classify.model} models={models} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized: while one bubble streams, the parent re-renders the whole message
// list every frame. Completed messages receive identical props (referentially
// stable via useCallback in the parent + a stable `msg` object), so memo skips
// re-rendering them entirely — the streaming bubble is the only one whose props
// actually change. Default shallow comparison is correct here because the
// parent no longer allocates fresh callbacks/objects per render.
export default memo(Message)
