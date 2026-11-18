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
//   - the same tool call (same key: tool + sanitized arguments) staged twice is
//     one artifact; the caller is told it already exists;
//   - once a tool staged an artifact of a family (deck / spreadsheet /
//     document), a fence of that family the model ALSO wrote in its text is
//     dropped (the tool result told it the artifact is attached). For decks this
//     includes a `deck-outline` plan, fenced or bare, which would otherwise be
//     materialized into a second deck.
// This module is pure: no database, no gateway, no SSE.
import { extractDeckOutline } from './blocks.js'

export const MAX_STAGED_ARTIFACTS = 6

// block type → the family a staged artifact suppresses in the model's text
const FAMILY = {
  'deck-html': 'deck',
  'deck-outline': 'deck',
  spreadsheet: 'spreadsheet',
  document: 'document',
}

class ArtifactStage {
  #items = []
  #byKey = new Map()

  get size() {
    return this.#items.length
  }

  /** The staged entry for `key`, if this turn already made it. */
  find(key) {
    return this.#byKey.get(key) || null
  }

  /**
   * Stages `block` (a sanitized prism block: deck-html / spreadsheet / document)
   * for the tool call `toolCallId`. Returns { ref, duplicate }. A key already
   * staged returns its first entry, unchanged. Throws past the per-turn limit.
   */
  stage(toolCallId, block, key) {
    const hit = key != null ? this.#byKey.get(key) : null
    if (hit) return { ref: hit.ref, duplicate: true }
    if (this.#items.length >= MAX_STAGED_ARTIFACTS) {
      throw new Error(`artifact limit reached: at most ${MAX_STAGED_ARTIFACTS} artifacts per answer`)
    }
    const entry = { ref: `artifact_${this.#items.length + 1}`, toolCallId: String(toolCallId ?? ''), block: structuredClone(block) }
    this.#items.push(entry)
    if (key != null) this.#byKey.set(key, entry)
    return { ref: entry.ref, duplicate: false }
  }

  /** The staged entries, in staging order (copies). */
  entries() {
    return this.#items.map((e) => ({ ...e, block: structuredClone(e.block) }))
  }
}

export function createArtifactStage() {
  return new ArtifactStage()
}

const FENCE_OPEN_RE = /```prism-block[ \t]*\r?\n?/g

// The balanced JSON object starting at (whitespace before) `start`, as in
// blocks.js: brace counting that respects string literals and escapes.
function scanObject(text, start) {
  let i = start
  while (i < text.length && text[i] !== '{') {
    if (!/\s/.test(text[i])) return null
    i++
  }
  if (i >= text.length) return null
  const from = i
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < text.length; i++) {
    const ch = text[i]
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

// Removes every fenced prism-block whose family is in `families`. A fence that
// does not parse is left alone (extractPrismBlocks degrades it as before).
function dropFencedFamilies(text, families) {
  let out = ''
  let cursor = 0
  FENCE_OPEN_RE.lastIndex = 0
  let m
  while ((m = FENCE_OPEN_RE.exec(text)) !== null) {
    const scanned = scanObject(text, m.index + m[0].length)
    if (!scanned) break
    let type = null
    try {
      type = JSON.parse(scanned.json)?.type
    } catch {
      /* not JSON: keep */
    }
    let end = scanned.end
    const tail = text.slice(end).match(/^[ \t]*\r?\n?```/)
    if (tail) end += tail[0].length
    FENCE_OPEN_RE.lastIndex = end
    if (!families.has(FAMILY[type])) continue
    out += text.slice(cursor, m.index)
    cursor = end
  }
  return out + text.slice(cursor)
}

const fenceOf = (block) => '```prism-block\n' + JSON.stringify(block) + '\n```'

/**
 * Writes the staged artifacts of a turn into its answer (see the header). An
 * empty or missing stage returns `answer` itself, so a turn without artifact
 * tools is byte-for-byte unchanged.
 */
export function applyStagedArtifacts(answer, stage) {
  const entries = stage?.entries?.() || []
  if (!entries.length) return answer
  let text = String(answer ?? '')

  const families = new Set(entries.map((e) => FAMILY[e.block?.type]).filter(Boolean))
  text = dropFencedFamilies(text, families)
  if (families.has('deck')) {
    // a bare (unfenced) deck-outline would still be materialized: drop it too
    for (let found = extractDeckOutline(text), guard = 0; found && guard < 8; found = extractDeckOutline(text), guard++) {
      text = text.slice(0, found.start) + text.slice(found.end)
    }
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
