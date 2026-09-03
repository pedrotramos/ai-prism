import { memo, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import * as Icon from './Icons.jsx'
import Logo from './Logo.jsx'
import BlockRenderer from './blocks/BlockRenderer.jsx'
import LoadingChip from './blocks/LoadingChip.jsx'
import { exportMessageToPdf } from '../pdfExport.js'
import { useT, useI18n } from '../lib/i18n.jsx'
import { shortMessageDate } from '../lib/date.js'
import CostBadge, { fmtCost, estimateCost } from './CostBadge.jsx'

const MARKER = '\n\n--- ANEXOS ---'
const FENCE_START = '```prism-block'
const PLACEHOLDER_RE = /\{\{(block:\d+|toolcall:[^}]+)\}\}/g

function stripAttachments(content) {
  const i = content.indexOf(MARKER)
  return i >= 0 ? content.slice(0, i) : content
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

// Collapsible trace of one tool call — mirrors the Databricks Playground
// pattern of showing "used tool X" above the answer, expandable to inspect
// exactly what was sent/returned (handy for verifying the model's math).
// Shown while the assistant is streaming but hasn't produced visible text yet —
// i.e. it's "thinking": on the first round the model is reading context and
// deciding whether to call a tool, and between tool rounds it's deciding what
// to do with a result. Without this the UI showed only a bare blinking cursor,
// which reads as a frozen/failed request. A single stable "Pensando" label +
// the animated dots — no cycling through fabricated phrases (they never
// reflected what the model was actually doing).
//
// An honest, cheap signal so a long post-tool reasoning pause never reads as
// frozen (the model can spend 1–2 min reasoning after a Genie call before it
// narrates the next step): an elapsed-seconds counter that starts ticking once
// the wait passes a threshold. Real, never fabricated; self-updates on a 1s
// interval only while mounted. The model's live reasoning, when the endpoint
// streams it, is shown in ReasoningTrace — it is NOT echoed here (that would
// duplicate the same text in two places).
function useElapsedSeconds(active) {
  const [now, setNow] = useState(() => Date.now())
  const startRef = useRef(Date.now())
  useEffect(() => {
    if (!active) return
    startRef.current = Date.now()
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return Math.floor((now - startRef.current) / 1000)
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

function ThinkingIndicator({ compact = false, buildingKey }) {
  const t = useT()
  const secs = useElapsedSeconds(true)
  // A short, honest label: the artifact being built when a heavy silent
  // generation is running (keeps the wait legible), else a plain "Thinking…".
  // The model's live reasoning lives in ReasoningTrace, never here.
  const label = buildingKey ? t(buildingKey) : t('message.thinking')
  return (
    <span className="inline-flex items-center gap-2 text-[var(--muted)] text-sm min-w-0">
      <span className="inline-flex gap-1 shrink-0" aria-hidden>
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      {!compact && (
        <span className="inline-flex items-center gap-2 min-w-0">
          <span className="truncate">{label}</span>
          {secs >= 3 && <span className="text-[var(--faint)] tabular-nums shrink-0">{secs}s</span>}
        </span>
      )}
    </span>
  )
}

// Collapsible view of the model's native reasoning/thinking tokens. While the
// model is still reasoning (no answer prose yet) it stays open so the user sees
// the chain of thought live; once the answer starts streaming it auto-collapses
// to a single line (reopenable). The trace is persisted with the message, so it
// stays available for later inspection — collapsed by default on reload.
function ReasoningTrace({ text, hasAnswer }) {
  const t = useT()
  const [manual, setManual] = useState(null) // null = follow auto; true/false = user override
  const open = manual == null ? !hasAnswer : manual
  const bodyRef = useRef(null)
  // keep the newest reasoning in view while it streams and stays open
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [text, open])
  if (!text) return null
  return (
    <div className="mb-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 overflow-hidden">
      <button
        onClick={() => setManual(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)]"
      >
        <Icon.Sparkle size={12} className={hasAnswer ? '' : 'animate-pulse text-[var(--accent)]'} />
        <span className="font-medium">{hasAnswer ? t('reasoning.done') : t('reasoning.thinking')}</span>
        <Icon.ChevronDown size={13} className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="px-3 pb-2 max-h-48 overflow-y-auto text-xs leading-relaxed text-[var(--muted)] whitespace-pre-wrap"
        >
          {text}
        </div>
      )}
    </div>
  )
}

function ToolCallChip({ tc }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const running = tc.status === 'running'
  const error = tc.status === 'error'
  const isPython = tc.name === 'execute_python'
  const isImageGen = tc.name === 'generate_image'
  const isGenie = tc.name?.startsWith('genie__')
  const isGenieOne = tc.name === 'ask_genie_one'
  const isVectorSearch = tc.name?.startsWith('vs__')
  const isMcpExternal = tc.name?.startsWith('mcpext__')
  const richResult = !isPython
  const code = isPython ? tc.args?.code : null

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] mb-2 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <Icon.ChevronRight
          size={13}
          className={`shrink-0 text-[var(--faint)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {isPython ? (
          <Icon.Terminal size={14} className="shrink-0" />
        ) : isImageGen ? (
          <Icon.Image size={15} className="shrink-0 text-[var(--accent)]" />
        ) : isGenie ? (
          <Icon.GenieSpaces size={16} />
        ) : isGenieOne ? (
          <Icon.GenieOne size={16} />
        ) : isVectorSearch ? (
          <Icon.VectorSearch size={16} />
        ) : isMcpExternal ? (
          <Icon.McpExternal size={16} />
        ) : (
          <Icon.UcFunctions size={16} />
        )}
        <span className="font-semibold flex-1 min-w-0 leading-snug line-clamp-2 break-words text-left">{tc.label || tc.name}</span>
        {running && tc.elapsedMs != null && (
          <span className="text-[var(--faint)] shrink-0 tabular-nums">{Math.round(tc.elapsedMs / 1000)}s</span>
        )}
        {running && (
          <span className="block w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin shrink-0" />
        )}
        {!running && error && <Icon.AlertTriangle size={14} className="text-red-400 shrink-0" />}
        {!running && !error && <Icon.Check size={14} className="text-[var(--accent)] shrink-0" />}
        {!running && tc.durationMs != null && (
          <span className="text-[var(--faint)] shrink-0">{(tc.durationMs / 1000).toFixed(1)}s</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-xs">
          {code ? (
            <div className="prose-chat text-xs [&_pre]:my-0">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {'```python\n' + code + '\n```'}
              </Markdown>
            </div>
          ) : (isGenie || isGenieOne) && tc.args?.question ? (
            // Genie's question is natural language, often long — render it in
            // full as rich text instead of a truncated font-mono key:value line.
            <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-[var(--faint)] mb-1">{t('message.question')}</div>
              <div className="prose-chat text-xs">
                <Markdown remarkPlugins={[remarkGfm]}>{tc.args.question}</Markdown>
              </div>
            </div>
          ) : isImageGen ? (
            // the image prompt sent to the model is an internal detail (english,
            // model-facing) — don't surface it; the rendered image block is the
            // meaningful output. Args are hidden entirely for this tool.
            null
          ) : (
            tc.args &&
            Object.keys(tc.args).length > 0 && (
              <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-2.5 space-y-1 font-mono">
                {Object.entries(tc.args).map(([k, v]) => (
                  <div key={k} className="break-words whitespace-pre-wrap">
                    <span className="text-[var(--faint)]">{k}:</span> {String(v)}
                  </div>
                ))}
              </div>
            )
          )}
          {/* image-gen: only show the result box on error (the success text is a
              model-facing instruction, and the image renders as its own block) */}
          {tc.result != null && !(isImageGen && !error) && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--faint)] mb-1">
                {error ? t('message.error') : t('message.result')}
              </div>
              {richResult && !error ? (
                // These tools answer in markdown (prose, tables, a SQL fence,
                // links) — render it properly instead of dumping raw ** and |
                // characters into a plain <pre> block.
                <div className="prose-chat text-xs rounded-lg bg-[var(--surface)] border border-[var(--border)] p-2.5 overflow-x-auto">
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {tc.result}
                  </Markdown>
                </div>
              ) : (
                <pre
                  className={`rounded-lg border p-2.5 overflow-x-auto whitespace-pre-wrap ${
                    error
                      ? 'bg-red-500/10 border-red-500/30 text-red-300'
                      : 'bg-[var(--surface)] border-[var(--border)]'
                  }`}
                >
                  {tc.result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CopyBtn({ text, label }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
      className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)] transition"
      title={label ?? t('message.copy')}
    >
      {done ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
    </button>
  )
}

// Recursively flattens a React node tree to its plain text — used to recover
// the raw source of a code block for copying. After rehypeHighlight runs the
// code is nested in <span> tokens, so we can't read a single string child; the
// leaf text nodes are still strings, and this concatenates them in order.
function nodeToText(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  if (node.props) return nodeToText(node.props.children)
  return ''
}

// Extracts the language from the `language-xxx` class react-markdown puts on the
// <code> child of a fenced block. Returns '' for a bare ``` fence.
function langFromClass(className) {
  const m = /language-([\w+-]+)/.exec(className || '')
  return m ? m[1] : ''
}

// A fenced code block with a header: language label (left) + copy button
// (right), over the highlighted code. Replaces the default <pre> in the chat
// markdown so code reads like an IDE snippet and is one click to copy. The
// header is skipped for a plain string child that isn't a code element (rare,
// but keeps the override safe for any <pre> the parser emits).
function CodeBlock({ children }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const codeEl = Array.isArray(children) ? children[0] : children
  const className = codeEl?.props?.className || ''
  const lang = langFromClass(className)
  const raw = nodeToText(codeEl).replace(/\n$/, '')
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{lang || 'texto'}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(raw)
            setDone(true)
            setTimeout(() => setDone(false), 1400)
          }}
          className="code-block-copy"
          title={t('message.copyCode')}
        >
          {done ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
          <span>{done ? t('message.copied') : t('message.copy')}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

// Custom renderers passed to <Markdown> for the assistant answer: only `pre` is
// overridden (fenced code blocks). Inline `code` keeps the default rendering.
const MARKDOWN_COMPONENTS = { pre: CodeBlock }

function Message({ msg, models, onSpeak, onRegenerate, onSwitchVariant, onEditUser, onOpenDeck, onOpenSpreadsheet, onOpenDocument, canRegenerate, streaming, isLatest, onSubmitAnswers }) {
  const t = useT()
  const { locale } = useI18n()
  const isUser = msg.role === 'user'
  const text = stripAttachments(msg.content)
  const toolCalls = msg.toolCalls || msg.tool_calls
  const segments = isUser ? [] : splitSegments(text, msg.blocks, toolCalls, streaming)
  // which heavy artifact (if any) this turn is generating — turns a silent
  // "Thinking…" into a purposeful "Designing your deck…" during long generations
  const buildingKey = buildingKeyFrom(msg.activeSkills)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const exportRef = useRef(null)
  // legacy safety net: messages persisted before {{toolcall:ID}} markers
  // existed have tool calls but no matching marker in their content — show
  // those (only those) the old way, grouped above the answer
  const referencedToolCallIds = new Set(
    segments.filter((s) => s.kind === 'toolcall').map((s) => s.tc.id)
  )
  const unreferencedToolCalls = (toolCalls || []).filter((tc) => !referencedToolCallIds.has(tc.id))
  // for copy/speak: plain prose only, placeholders (and any dangling live
  // fence) stripped since they're not meant to be read/copied literally
  const plainText = text
    .replace(PLACEHOLDER_RE, '')
    .replace(/```prism-block[\s\S]*?(```|$)/g, '')
    .trim()
  let attachments = []
  try {
    if (msg.attachments) attachments = JSON.parse(msg.attachments)
  } catch {}

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
        <div className="flex justify-end animate-fade-in">
          <div className="max-w-[85%] md:max-w-[75%] w-full">
            <textarea
              autoFocus
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
              className="w-full rounded-2xl rounded-tr-md bg-[var(--bubble-user)] px-4 py-2.5 text-[0.95rem] leading-relaxed outline-none border border-[var(--accent)] resize-none"
            />
            <div className="flex justify-end gap-2 mt-1.5">
              <button
                onClick={() => {
                  setEditing(false)
                  setDraft(text)
                }}
                className="text-xs px-3 py-1.5 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] transition"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={commitEdit}
                className="text-xs px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white font-semibold hover:brightness-110 transition"
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
      <div className="flex justify-end animate-fade-in group/msg">
        <div className="max-w-[85%] md:max-w-[75%]">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end mb-1.5">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[11px] bg-[var(--surface-3)] text-[var(--muted)] rounded-md px-2 py-1"
                >
                  <Icon.File size={12} /> {a}
                </span>
              ))}
            </div>
          )}
          <div className="rounded-2xl rounded-tr-md bg-[var(--bubble-user)] px-4 py-2.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap">
            {text}
          </div>
          {/* Discreet action row UNDER the bubble (Claude-style): the date sits
              at the left of the row and the actions reveal on hover, so the
              message reads cleanly at rest. */}
          <div className="flex items-center justify-end gap-0.5 mt-1 pr-0.5 text-[11px] text-[var(--faint)]">
            {msgDate && (
              <span className="mr-1 opacity-0 group-hover/msg:opacity-100 transition" title={new Date(msg.created_at).toLocaleString(locale)}>
                {msgDate}
              </span>
            )}
            {onEditUser && !streaming && (
              <button
                onClick={() => {
                  setDraft(text)
                  setEditing(true)
                }}
                className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] opacity-0 group-hover/msg:opacity-100 transition"
                title={t('common.edit')}
              >
                <Icon.Pencil size={13} />
              </button>
            )}
            <span className="opacity-0 group-hover/msg:opacity-100 transition">
              <CopyBtn text={text} label={t('message.copyPrompt')} />
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="shrink-0 mt-0.5 w-8 h-8 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] grid place-items-center text-[var(--text)]">
        <Logo size={18} />
      </div>
      <div className="min-w-0 flex-1">
        {/* ephemeral skill badge: shows which authored skill(s) the router
            activated for this turn. Only while streaming — it's not persisted,
            so it disappears once the turn finishes (and never on reload). */}
        {streaming && msg.activeSkills?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 animate-fade-in">
            {msg.activeSkills.map((sk) => (
              <span
                key={sk.name}
                title={sk.description}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--accent)] bg-[var(--accent-soft)] border border-[var(--accent)]/30 rounded-full pl-1.5 pr-2.5 py-1"
              >
                <Icon.SkillGlyph size={13} className="shrink-0" />
                {sk.title}
              </span>
            ))}
          </div>
        )}
        <div ref={exportRef}>
          {unreferencedToolCalls.length > 0 && (
            <div>
              {unreferencedToolCalls.map((tc, i) => (
                <ToolCallChip key={tc.id || i} tc={tc} />
              ))}
            </div>
          )}
          {/* Native reasoning trace. Persisted with the message, so it stays
              available after the turn ends — open while streaming pre-answer,
              collapsed once there's answer prose (and on reload). */}
          {msg.reasoning && (
            <ReasoningTrace text={msg.reasoning} hasAnswer={segments.some((s) => s.kind === 'md')} />
          )}
          <div className="prose-chat">
            {segments.length ? (
              segments.map((seg, i) => {
                if (seg.kind === 'md') {
                  // Syntax highlight is purely cosmetic and rehype-highlight
                  // re-runs over the ENTIRE code block on every render. During
                  // streaming the text grows each frame, so highlighting live is
                  // O(n²) for no benefit (nobody reads highlighted code as it's
                  // typed). Skip it while streaming; apply it once on finalize.
                  return (
                    <Markdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={streaming ? [] : [rehypeHighlight]} components={MARKDOWN_COMPONENTS}>
                      {seg.text}
                    </Markdown>
                  )
                }
                if (seg.kind === 'block') return <BlockRenderer key={i} blocks={[seg.block]} msgId={msg.id} models={models} onOpenDeck={onOpenDeck} onOpenSpreadsheet={onOpenSpreadsheet} onOpenDocument={onOpenDocument} isLatest={isLatest} onSubmitAnswers={onSubmitAnswers} />
                if (seg.kind === 'toolcall') return <ToolCallChip key={i} tc={seg.tc} />
                if (seg.kind === 'loading') return <LoadingChip key={i} blockType={seg.blockType} />
                return null
              })
            ) : streaming ? (
              <ThinkingIndicator buildingKey={buildingKey} />
            ) : null}
            {/* Streaming indicator keyed off the LAST segment, not `text` —
                `text` still contains the {{toolcall:ID}} markers, so it's
                truthy the moment any tool runs and can't distinguish "typing
                prose" from "just finished a tool call". When the trailing
                segment is prose the model is actively writing → a live cursor.
                When it's a tool chip (or there's no segment yet), the model is
                between/after tool rounds deciding what's next → a full thinking
                indicator so the wait never reads as frozen. */}
            {streaming && segments.length > 0 && segments[segments.length - 1].kind === 'md' && (
              <span className="stream-cursor" />
            )}
            {streaming && segments.length > 0 && segments[segments.length - 1].kind !== 'md' && (
              <div className="mt-2"><ThinkingIndicator buildingKey={buildingKey} /></div>
            )}
          </div>
        </div>

        {!streaming && (
          // flex-wrap in two cohesive groups: when the chat column narrows
          // (Studio focus mode) the buttons stay on one line and the
          // model/token/cost info drops to its own line — never overflowing
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 mt-2 text-[11px] text-[var(--faint)]">
          <span className="inline-flex items-center gap-1">
            {hasVariants && (
              <span className="inline-flex items-center gap-0.5 mr-0.5">
                <button
                  disabled={variantIndex === 0}
                  onClick={() => onSwitchVariant(msg.id, variants[variantIndex - 1].id)}
                  className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent transition"
                  title={t('message.previousVersion')}
                >
                  <Icon.ChevronLeft size={13} />
                </button>
                <span className="tabular-nums px-0.5">
                  {variantIndex + 1}/{variants.length}
                </span>
                <button
                  disabled={variantIndex === variants.length - 1}
                  onClick={() => onSwitchVariant(msg.id, variants[variantIndex + 1].id)}
                  className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent transition"
                  title={t('message.nextVersion')}
                >
                  <Icon.ChevronRight size={13} />
                </button>
                <span className="mx-1 w-px h-3 bg-[var(--border)]" />
              </span>
            )}
            <CopyBtn text={plainText} />
            <button
              onClick={() => onSpeak(plainText)}
              className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition"
              title={t('message.listenResponse')}
            >
              <Icon.Speaker size={14} />
            </button>
            <button
              onClick={() => exportMessageToPdf(exportRef.current, t('message.pdfTitle'))}
              className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition"
              title={t('message.exportPdf')}
            >
              <Icon.FileText size={14} />
            </button>
            {canRegenerate && (
              <button
                onClick={() => onRegenerate(msg.id)}
                className="p-1 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition"
                title={t('message.regenerate')}
              >
                <Icon.Regenerate size={14} />
              </button>
            )}
          </span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            {meta && <span className="font-medium text-[var(--muted)]">{meta.label}</span>}
            {(pt || ct) && (
              <span title={t('message.tokensInOut')}>
                · {pt ?? '–'}↑ {ct ?? '–'}↓
              </span>
            )}
            {cost != null && (
              <span title={t('message.estimatedCost')}>· ~{fmtCost(cost)}</span>
            )}
          </span>
          {/* Two-model media pipeline disclosure: the audio/video was read by a
              different model (Gemini) than the one that wrote this answer. Shown
              so the media step + its token spend aren't invisible. */}
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
          {/* Intent-classifier disclosure: a cheap/fast model read the request's
              intent before the answer (routing which tools/capabilities the turn
              needs). Shown so its small token spend is visible, not hidden. */}
          {msg.intent_classify?.usage && (
            <span
              className="inline-flex items-center gap-1 whitespace-nowrap"
              title={t('message.intentClassifyTitle')}
            >
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
