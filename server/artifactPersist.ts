// The per-turn stage of the artifacts a tool creates (W2-12).
//
// The staging rule (ADR-W2-2-c): an artifact tool (server/artifactTools.js)
// never writes a row while it runs. It hands its finished, sanitized block to
// the turn's stage, which lives in memory only. When the tool loop ends,
// finishTurn (server/turn.js) writes every staged block into the answer as a
// ```prism-block fence right after its tool-call marker, so the one path that
// persists artifacts (extractPrismBlocks → commitTurnAnswer, a single
// transaction with the cancel check as its last step) persists these too. A
// cancelled turn drops the stage with the rest of the answer: no artifact row
// from a tool call ever exists without its committed answer.
//
// No duplicate artifact per turn:
//   - the same tool call (same key: tool + arguments) staged twice is one
//     artifact; the caller is told it already exists;
//   - a second create of the same family with the same title, or a second
//     update of the same source (same `sameAs`), REPLACES the first staged
//     version in place (a model re-issuing a call with a small change gets one
//     artifact, the latest);
//   - once a tool staged an artifact of a family (deck / spreadsheet /
//     document), a fence of that family the model ALSO wrote in its text is
//     dropped (the tool result told it the artifact is attached). For decks this
//     includes a `deck-outline` plan, fenced or bare, which would otherwise be
//     materialized into a second deck.
// This module is pure: no database, no gateway, no SSE.
import { extractDeckOutline } from './blocks.ts'

export const MAX_STAGED_ARTIFACTS = 6

// block type → the family a staged artifact suppresses in the model's text
// a sanitized prism block as the artifact tools hand it over (only `type` is read here)
interface StagedBlock {
  type?: string
  [field: string]: unknown
}
interface StagedEntry {
  ref: string
  toolCallId: string
  block: StagedBlock
}

const FAMILY: Record<string, string> = {
  'deck-html': 'deck',
  'deck-outline': 'deck',
  spreadsheet: 'spreadsheet',
  document: 'document',
}

class ArtifactStage {
  #items: StagedEntry[] = []
  #byKey = new Map<unknown, StagedEntry>()

  get size() {
    return this.#items.length
  }

  #bySame = new Map<unknown, StagedEntry>()

  /** The staged entry for `key`, if this turn already made it. */
  find(key: unknown): StagedEntry | null {
    return this.#byKey.get(key) || null
  }

  /**
   * Whether staging an artifact identified by `sameAs` would be refused by the
   * per-turn limit — checked BEFORE a tool spends on generating it.
   */
  wouldExceed(sameAs?: unknown): boolean {
    if (sameAs != null && this.#bySame.has(sameAs)) return false
    return this.#items.length >= MAX_STAGED_ARTIFACTS
  }

  /**
   * Stages `block` (a sanitized prism block: deck-html / spreadsheet / document)
   * for the tool call `toolCallId`. Returns { ref, duplicate, replaced }. A key
   * already staged returns its first entry, unchanged; a `sameAs` already staged
   * gets its block replaced (same ref, same position). Throws past the limit.
   */
  stage(toolCallId: unknown, block: StagedBlock, key?: unknown, { sameAs = null }: { sameAs?: unknown } = {}): { ref: string; duplicate: boolean; replaced: boolean } {
    const hit = key != null ? this.#byKey.get(key) : null
    if (hit) return { ref: hit.ref, duplicate: true, replaced: false }
    const same = sameAs != null ? this.#bySame.get(sameAs) : null
    if (same) {
      same.block = structuredClone(block)
      if (key != null) this.#byKey.set(key, same)
      return { ref: same.ref, duplicate: false, replaced: true }
    }
    if (this.#items.length >= MAX_STAGED_ARTIFACTS) {
      throw new Error(`artifact limit reached: at most ${MAX_STAGED_ARTIFACTS} artifacts per answer`)
    }
    const entry = { ref: `artifact_${this.#items.length + 1}`, toolCallId: String(toolCallId ?? ''), block: structuredClone(block) }
    this.#items.push(entry)
    if (key != null) this.#byKey.set(key, entry)
    if (sameAs != null) this.#bySame.set(sameAs, entry)
    return { ref: entry.ref, duplicate: false, replaced: false }
  }

  /** The staged entries, in staging order (copies). */
  entries(): StagedEntry[] {
    return this.#items.map((e) => ({ ...e, block: structuredClone(e.block) }))
  }
}

export function createArtifactStage() {
  return new ArtifactStage()
}

const FENCE_OPEN_RE = /```prism-block[ \t]*\r?\n?/g

// The balanced JSON object starting at (whitespace before) `start`, as in
// blocks.js: brace counting that respects string literals and escapes.
function scanObject(text: string, start: number): { json: string; end: number } | null {
  let i = start
  while (i < text.length && text[i] !== '{') {
    if (!/\s/.test(text[i] as string)) return null // i < text.length here
    i++
  }
  if (i >= text.length) return null
  const from = i
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < text.length; i++) {
    const ch = text[i] as string // i < text.length here
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return { json: text.slice(from, i + 1), end: i + 1 }
  }
  return null
}

// Removes every fenced prism-block whose family is in `families`. A fence whose
// JSON does not parse is left alone (extractPrismBlocks degrades it as before).
// An UNBALANCED opener (truncated/malformed object) is cut from the opener to
// the end of the text — exactly what extractPrismBlocks would drop anyway — so
// it cannot swallow a staged fence inserted after it (the markers it removes
// make those fences append at the end instead).
function dropFencedFamilies(text: string, families: Set<string>): string {
  let out = ''
  let cursor = 0
  FENCE_OPEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_OPEN_RE.exec(text)) !== null) {
    const scanned = scanObject(text, m.index + m[0].length)
    if (!scanned) return out + text.slice(cursor, m.index)
    let type: string | null | undefined = null
    try {
      type = JSON.parse(scanned.json)?.type // JSON.parse is untyped; a non-string type matches no family
    } catch {
      /* not JSON: keep */
    }
    let end = scanned.end
    const drop = families.has(FAMILY[type as string] as string) // an unknown type maps to undefined, which is never in the set
    // a dropped fence takes its closing ``` even after blank lines (an orphan ```
    // would open a code block over the rest of the answer); a kept fence keeps
    // extractPrismBlocks' own rule. Never a ``` that opens the next fence.
    const tail = text.slice(end).match(drop ? /^\s*```(?![\w-])/ : /^[ \t]*\r?\n?```(?![\w-])/)
    if (tail) end += tail[0].length
    FENCE_OPEN_RE.lastIndex = end
    if (!drop) continue
    out += text.slice(cursor, m.index)
    cursor = end
  }
  return out + text.slice(cursor)
}

// The `"type":"deck-outline"` declaration extractDeckOutline looks for.
const OUTLINE_TYPE_RE = /(["'])type\1\s*:\s*(["'])deck-outline\2/g

// Once a deck is staged, NO deck plan may reach finishTurn's materialization
// (materializeDeckOutline → extractDeckOutline), whatever the count. Bare
// (unfenced) outlines are cut out while each cut makes progress — every pass
// removes at least one character, so the loop ends for any input — and any
// declaration left (a span the extractor cannot delimit) is neutralized, so
// extractDeckOutline's own marker test can no longer match. Invariant on return:
// extractDeckOutline(text) === null.
function suppressDeckOutlines(text: string): string {
  for (let found = extractDeckOutline(text); found; found = extractDeckOutline(text)) {
    if (!(found.end > found.start)) break
    text = text.slice(0, found.start) + text.slice(found.end)
  }
  return text.replace(OUTLINE_TYPE_RE, '"type":"deck-outline-suppressed"')
}

const fenceOf = (block: StagedBlock) => '```prism-block\n' + JSON.stringify(block) + '\n```'

/**
 * Writes the staged artifacts of a turn into its answer (see the header). An
 * empty or missing stage returns `answer` itself, so a turn without artifact
 * tools is byte-for-byte unchanged.
 */
export function applyStagedArtifacts(answer: string, stage?: { entries?: () => StagedEntry[] } | null): string {
  const entries = stage?.entries?.() || []
  if (!entries.length) return answer
  let text = String(answer ?? '')

  const families = new Set(entries.map((e) => FAMILY[e.block?.type as string]).filter(Boolean) as string[])
  text = dropFencedFamilies(text, families)
  if (families.has('deck')) {
    text = suppressDeckOutlines(text)
  }

  for (const e of entries) {
    const fence = `\n\n${fenceOf(e.block)}\n\n`
    const marker = `{{toolcall:${e.toolCallId}}}`
    const at = e.toolCallId ? text.indexOf(marker) : -1
    if (at >= 0) {
      const after = at + marker.length
      text = text.slice(0, after) + fence + text.slice(after)
    } else {
      text = `${text}${fence}`
    }
  }
  return text
}
