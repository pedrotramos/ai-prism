// Pure rules behind the chat message UI (Message.jsx and message/*.jsx). Kept
// free of React so node --test can pin them (logic.test.js).

/**
 * The attachment names of a user message, always as strings. The column holds
 * a JSON list of file names, but older or hand-written rows can hold objects
 * ({ name, size }) or nulls; an object rendered as a React child throws
 * (minified error #31) and, without a boundary, blanks the whole app.
 */
export function coerceAttachments(raw: unknown): string[] {
  let list: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (item == null) continue
    if (typeof item === 'string') out.push(item)
    else if (typeof item === 'number' || typeof item === 'boolean') out.push(String(item))
    else if (typeof item === 'object') {
      const o = item as { name?: unknown; filename?: unknown; title?: unknown }
      const name = o.name ?? o.filename ?? o.title
      if (typeof name === 'string' && name) out.push(name)
    }
  }
  return out
}

// Notices the server (and the client's `error` SSE handler) append as the last
// paragraph of an answer: ⚠️ = something went wrong (truncated output, gateway
// error); ℹ️ = the turn stopped early on a loop, round or time limit.
// longest first: the emoji form (with U+FE0F) before the bare symbol
export type NoticeKind = 'error' | 'stopped'
export interface Notice {
  kind: NoticeKind
  text: string
}
const NOTICE_KINDS: Record<string, NoticeKind> = { '⚠️': 'error', 'ℹ️': 'stopped', '⚠': 'error', 'ℹ': 'stopped' }
const PARA_BREAK = /\n[ \t]*\n/g

/** Splits a trailing ⚠️/ℹ️ notice paragraph off the answer text. */
export function splitTrailingNotice(text: unknown): { body: string; notice: Notice | null } {
  const s = (typeof text === 'string' ? text : '').trimEnd()
  let start = 0
  for (const m of s.matchAll(PARA_BREAK)) start = m.index! + m[0].length
  const last = s.slice(start).trimStart()
  const marker = Object.keys(NOTICE_KINDS).find((k) => last.startsWith(k))
  if (!marker) return { body: s.trim(), notice: null }
  return {
    body: s.slice(0, start).trim(),
    notice: { kind: NOTICE_KINDS[marker]!, text: last.slice(marker.length).trim() },
  }
}

const REASON_MAX = 120

export interface ToolCallState {
  status?: string
  elapsedMs?: number | null
  durationMs?: number | null
  result?: unknown
}

export interface ToolCallView {
  state: 'running' | 'failed' | 'done'
  seconds: string | null
  reason: string | null
}

/** A rendered piece of an assistant message; only the fields the rules read are typed. */
export interface Segment {
  kind: string
  tc?: ToolCallState | null
}

/**
 * What a tool-call chip shows: `running` with the live elapsed seconds,
 * `done` with its duration, or `failed` with the duration and a one-line
 * reason taken from the result, so the failure reads without expanding.
 */
export function toolCallView(tc: ToolCallState | null | undefined): ToolCallView {
  const status = tc?.status
  if (status === 'running') {
    return { state: 'running', seconds: tc!.elapsedMs != null ? `${Math.round(tc!.elapsedMs / 1000)}s` : null, reason: null }
  }
  const seconds = tc?.durationMs != null ? `${(tc.durationMs / 1000).toFixed(1)}s` : null
  if (status === 'error') {
    const first = String(tc!.result ?? '').split('\n').find((l) => l.trim()) || ''
    const line = first.trim()
    const reason = line.length > REASON_MAX ? line.slice(0, REASON_MAX - 1) + '…' : line
    return { state: 'failed', seconds, reason: reason || null }
  }
  return { state: 'done', seconds, reason: null }
}

/**
 * Whether the "Thinking…" row shows under a streaming answer. One progress
 * signal at a time: the live cursor while prose streams, the tool chip's
 * spinner while a tool runs, the loading chip while a block is typed, and the
 * Thinking row only when nothing else says the turn is alive.
 */
export function showThinkingRow({ streaming, segments }: { streaming?: boolean; segments?: Segment[] | null }): boolean {
  if (!streaming) return false
  const last = segments?.[segments.length - 1]
  if (!last) return true
  if (last.kind === 'md' || last.kind === 'loading') return false
  if (last.kind === 'toolcall' && last.tc?.status === 'running') return false
  return true
}

/**
 * Whether the Copy / Listen / PDF / Regenerate toolbar shows. Not while
 * streaming, not on a failed row — an `error`, or a trailing error notice
 * even after partial prose: there Retry in the notice is the one way
 * forward, and Copy/Regenerate beside it would compete with it (the partial
 * text stays selectable) — and not on an empty row, where every action would
 * act on nothing. A stopped-early notice keeps the toolbar: that answer is
 * usable.
 */
export function showActionToolbar({
  streaming,
  error,
  notice,
  plainText,
  segments,
}: {
  streaming?: boolean
  error?: unknown
  notice?: Notice | null
  plainText?: string | null
  segments?: Segment[] | null
}): boolean {
  if (streaming || error || notice?.kind === 'error') return false
  if (plainText && plainText.trim()) return true
  return (segments || []).some((s) => s.kind === 'block' || s.kind === 'toolcall')
}
