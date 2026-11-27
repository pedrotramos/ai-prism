// What changed between two saved versions of an agent. Pure, no I/O, no DOM: the history panel, the admin review card and the
// tests all call it, so "what changed" has one definition.
//
// A version is { name, description, definition }. `definition` is an open payload on purpose: today it is the recipe of
// server/agents/definition.ts (instructions, prompt, model, reasoningEffort, tools, schedule, lang); a later flow graph rides in
// the same column. The recipe fields get the readable treatment (a line diff for the long texts, a set diff for the tools); any
// other top-level key of the payload is compared as a whole and reported as `{ field: <key>, kind: 'value' }`, so a payload this
// module has not learned yet still shows up as "changed" instead of being silently dropped.
//
// Values are normalised before they are compared ('' / null / undefined are the same "absent", object keys sort), so a value that
// went through a form (an emptied field, keys in another order) never reads as an edit.

export interface VersionContent {
  name: string
  description: string
  definition: Record<string, unknown>
}

export type LineOp = 'same' | 'add' | 'del'
export interface DiffLine {
  op: LineOp
  text: string
}

/** How a change is shown: `text` (a line diff), `set` (added / removed items), `value` (before and after). */
export type ChangeKind = 'text' | 'set' | 'value'

export interface FieldChange {
  field: string
  kind: ChangeKind
  before: unknown
  after: unknown
  /** kind 'text': the line diff, `same` lines kept only next to a change */
  lines?: DiffLine[]
  /** kind 'set': items in `after` but not in `before`, and the reverse */
  added?: string[]
  removed?: string[]
  /** kind 'set': the same members in another order */
  reordered?: boolean
}

export interface VersionDiff {
  changes: FieldChange[]
  isEmpty: boolean
}

/** Fields of the recipe, in display order, with how each one is shown. */
const RECIPE_FIELDS: readonly { field: string; kind: ChangeKind }[] = [
  { field: 'instructions', kind: 'text' },
  { field: 'prompt', kind: 'text' },
  { field: 'model', kind: 'value' },
  { field: 'reasoningEffort', kind: 'value' },
  { field: 'tools', kind: 'set' },
  { field: 'schedule', kind: 'value' },
  { field: 'lang', kind: 'value' },
]
const KNOWN = new Set(['name', 'description', ...RECIPE_FIELDS.map((f) => f.field)])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function normalize(v: unknown): unknown {
  if (v === '' || v === undefined || v === null) return undefined
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim()
  if (Array.isArray(v)) return v.map(normalize)
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const n = normalize(v[k])
      if (n !== undefined) out[k] = n
    }
    return out
  }
  return v
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))

// A line diff is O(n·m); a text near the limits of the recipe (8,000 characters) is a few hundred lines at most, but a payload that
// is not the recipe could be bigger, so past this many cells the two texts are shown whole (all removed, then all added).
const MAX_CELLS = 250_000
const CONTEXT = 2

/** Line-level diff of two texts (longest common subsequence). `same` lines far from a change are dropped. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let all: DiffLine[]
  if (a.length * b.length > MAX_CELLS) {
    all = [...a.map((text): DiffLine => ({ op: 'del', text })), ...b.map((text): DiffLine => ({ op: 'add', text }))]
  } else {
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
      }
    }
    all = []
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        all.push({ op: 'same', text: a[i]! })
        i++
        j++
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        all.push({ op: 'del', text: a[i++]! })
      } else {
        all.push({ op: 'add', text: b[j++]! })
      }
    }
    while (i < a.length) all.push({ op: 'del', text: a[i++]! })
    while (j < b.length) all.push({ op: 'add', text: b[j++]! })
  }
  // keep a few lines of context around each change
  const keep = new Array<boolean>(all.length).fill(false)
  all.forEach((l, idx) => {
    if (l.op === 'same') return
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(all.length - 1, idx + CONTEXT); k++) keep[k] = true
  })
  return all.filter((_, idx) => keep[idx])
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : '')
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * The changes from `prev` to `next`. `prev === null` (the first version) has nothing to compare with: `isEmpty` and no
 * changes, and the caller says "first version" itself.
 */
export function diffVersions(prev: VersionContent | null, next: VersionContent): VersionDiff {
  if (!prev) return { changes: [], isEmpty: true }
  const changes: FieldChange[] = []
  for (const field of ['name', 'description'] as const) {
    if (!same(prev[field], next[field])) changes.push({ field, kind: 'value', before: prev[field], after: next[field] })
  }
  const pd = prev.definition ?? {}
  const nd = next.definition ?? {}
  for (const { field, kind } of RECIPE_FIELDS) {
    if (same(pd[field], nd[field])) continue
    if (kind === 'text') {
      changes.push({ field, kind, before: pd[field] ?? '', after: nd[field] ?? '', lines: lineDiff(asText(pd[field]), asText(nd[field])) })
    } else if (kind === 'set') {
      const a = asList(pd[field])
      const b = asList(nd[field])
      const added = b.filter((x) => !a.includes(x))
      const removed = a.filter((x) => !b.includes(x))
      changes.push({ field, kind, before: a, after: b, added, removed, ...(added.length === 0 && removed.length === 0 ? { reordered: true } : {}) })
    } else {
      changes.push({ field, kind, before: pd[field] ?? null, after: nd[field] ?? null })
    }
  }
  // any other key of the payload (a flow graph, say): changed or not, as a whole
  const extra = [...new Set([...Object.keys(pd), ...Object.keys(nd)])].filter((k) => !KNOWN.has(k)).sort()
  for (const field of extra) {
    if (!same(pd[field], nd[field])) changes.push({ field, kind: 'value', before: pd[field] ?? null, after: nd[field] ?? null })
  }
  return { changes, isEmpty: changes.length === 0 }
}
