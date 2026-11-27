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

// --- W1-2: the reasoning card (steps timeline) ---------------------------

/** The family a tool call belongs to; drives its icon, the header chips and the reveal link. */
export type StepKind = 'python' | 'genie' | 'genieOne' | 'vector' | 'mcp' | 'web' | 'image' | 'uc'

export function stepKind(name: string | null | undefined): StepKind {
  if (!name) return 'uc'
  if (name === 'execute_python') return 'python'
  if (name === 'ask_genie_one') return 'genieOne'
  if (name.startsWith('genie__')) return 'genie'
  if (name.startsWith('vs__')) return 'vector'
  // `mcp_` = current naming; `mcpext__` = tool calls persisted before the rename
  if (name.startsWith('mcp_') || name.startsWith('mcpext__')) return 'mcp'
  if (name === 'web_search' || name === 'web_fetch') return 'web'
  if (name === 'generate_image') return 'image'
  return 'uc'
}

const SQL_FENCE = /```sql[^\S\n]*\n([\s\S]*?)\n?```/i

/** The SQL a Genie tool result carries in its ```sql fence (server/genie.ts), or null. */
export function extractSql(result: unknown): string | null {
  if (typeof result !== 'string') return null
  const m = SQL_FENCE.exec(result)
  const sql = m?.[1]?.trim()
  return sql ? sql : null
}

/** The result text without its SQL fence and the "SQL executed by Genie:" line that introduces it. */
export function stripSqlFence(result: unknown): string {
  const s = typeof result === 'string' ? result : ''
  if (!SQL_FENCE.test(s)) return s
  return s
    .replace(/(^|\n)[^\n]*SQL[^\n]*:[ \t]*\n(?=```sql)/i, '$1')
    .replace(SQL_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A tool call as the steps rules read it. */
export interface StepCall extends ToolCallState {
  id?: string | number
  name?: string
}

/** An assistant row's pieces, with each run of tool calls folded into one steps group. */
export type SegmentItem =
  | { type: 'seg'; seg: Segment; index: number }
  | { type: 'steps'; calls: StepCall[]; tail: boolean; lead: boolean }

/**
 * Folds consecutive tool-call segments into one `steps` group where they
 * happened, so a turn that calls tools first reads as one card above the
 * answer. `leading` holds calls older rows persisted without a position marker,
 * and `hasReasoning` the model's native reasoning; either opens (or joins) a
 * lead group before the first prose. `tail` marks the group that ends the row,
 * the one a streaming turn is still working in. Callers read the original
 * segment back with `segments[item.index]`.
 */
export function groupSegments(
  segments: Array<Segment & { tc?: StepCall | null }>,
  { leading, hasReasoning }: { leading: StepCall[]; hasReasoning: boolean }
): SegmentItem[] {
  const out: SegmentItem[] = []
  segments.forEach((seg, index) => {
    if (seg.kind === 'toolcall' && seg.tc) {
      const prev = out[out.length - 1]
      if (prev?.type === 'steps') prev.calls.push(seg.tc)
      else out.push({ type: 'steps', calls: [seg.tc], tail: false, lead: false })
    } else {
      out.push({ type: 'seg', seg, index })
    }
  })
  if (leading.length > 0 || hasReasoning) {
    const first = out[0]
    if (first?.type === 'steps') {
      first.calls.unshift(...leading)
      first.lead = true
    } else {
      out.unshift({ type: 'steps', calls: [...leading], tail: false, lead: true })
    }
  }
  const last = out[out.length - 1]
  if (last?.type === 'steps') last.tail = true
  return out
}

export interface StepsSummary {
  count: number
  totalMs: number
  running: boolean
  failed: number
}

/** What the card header says: how many steps, the time they took, whether one still runs. */
export function stepsSummary(calls: StepCall[]): StepsSummary {
  let totalMs = 0
  let failed = 0
  let running = false
  for (const c of calls) {
    if (c.status === 'running') {
      running = true
      totalMs += c.elapsedMs ?? 0
    } else {
      totalMs += c.durationMs ?? 0
      if (c.status === 'error') failed++
    }
  }
  return { count: calls.length, totalMs, running, failed }
}

/** One entry per tool family, in first-seen order: the chips of the header and the AI line "with …". */
export function toolKindCounts(calls: Array<{ name?: string }>): Array<{ kind: StepKind; count: number }> {
  const order: StepKind[] = []
  const counts = new Map<StepKind, number>()
  for (const c of calls) {
    const k = stepKind(c.name)
    if (!counts.has(k)) order.push(k)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return order.map((kind) => ({ kind, count: counts.get(kind)! }))
}

/** "4.2s" under 10 s, "18s" above; null when there is nothing to show. */
export function formatSeconds(ms: number | null | undefined): string | null {
  if (ms == null || !(ms > 0)) return null
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}
