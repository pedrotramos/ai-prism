// Artifact tools through function-calling (W2-12): the model creates and updates
// decks, spreadsheets and documents by calling a tool, over the Prism engines —
// the per-slide HTML deck generator (deckHtmlGenerate.js), the spreadsheet model
// (blocks.js sanitizeSpreadsheet + shared/sheetModel materializeWorkbook, the
// same model the .xlsx export renders) and the document model (sanitizeDocument
// + docx-export.js renderDocx). No brand path: the deck uses the user's selected
// design system exactly as the text-authored deck does.
//
// Staging (ADR-W2-2-c): a tool NEVER writes a row. It stages its sanitized block
// in the turn's stage (server/artifactPersist.js); the answer commit
// (server/db/turnCommit.js) persists it in the answer's one transaction. A
// cancelled turn persists no artifact from a tool call.
//
// update_* never mutates the source row: it reads the caller's own artifact
// (owner-scoped getters: another user's id reads as "not found") and stages a
// NEW artifact with the change applied. History stays immutable (the earlier
// answer keeps what it showed) and a regenerated update cannot apply twice.
//
// Errors: invalid arguments and not-found are thrown as plain errors, which the
// turn loop records as tool_result status 'error' without failing the turn; a
// cancel rejects with the signal's own AbortError and ends the turn.
import { sanitizeDeckOutline, sanitizeHtmlDeck, sanitizeSpreadsheet, sanitizeDocument } from './blocks.js'
import { materializeWorkbook } from '../shared/sheetModel.js'
import { renderDocx } from './docx-export.js'
import { generateDeckFromOutline } from './deckHtmlGenerate.js'
import { MAX_STAGED_ARTIFACTS } from './artifactPersist.ts'
import type { createArtifactStage } from './artifactPersist.ts'
import { getDeck, getSpreadsheet, getDocument, getSelectedDeckTemplate } from './db.js'

export const ARTIFACT_TOOL_KIND = 'artifact'
// the usage_ledger kind of the model calls an artifact tool makes
export const ARTIFACT_USAGE_KIND = 'artifact'

// The serialized arguments of one artifact tool call: the model writes them, so
// they are bounded before any sanitizer iterates them or any generation is spent.
// Above the sanitizers' own caps (document 200k chars, deck 40 slides of 8k, a
// workbook of 8 sheets x 500 rows x 20 columns) with room for JSON overhead.
export const MAX_ARTIFACT_ARGS_CHARS = 2_000_000

type ArtifactKind = 'deck' | 'spreadsheet' | 'document'
interface KnownArtifact {
  id: string
  title: string
}
interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
}
// model-supplied tool arguments (JSON), validated field by field in each tool
type ToolArgs = Record<string, unknown>
// the turn's tool context (see invokeArtifactTool)
interface ToolCtx {
  email?: string
  model?: string
  signal?: AbortSignal
  send?: (event: unknown) => void
  artifacts?: ReturnType<typeof createArtifactStage>
  toolCallId?: unknown
}
interface Made {
  block: Record<string, unknown>
  usage?: Usage | null
  summary: string
}
interface Resolver {
  toolName?: string
  action?: string
  artifact?: string
}

const defaultDeps = { getDeck, getSpreadsheet, getDocument, getSelectedDeckTemplate, generateDeckFromOutline }

// ---------------------------------------------------------------- definitions

const SLIDE_BRIEF = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['cover', 'divider', 'content', 'cards', 'kpi', 'comparison', 'timeline', 'chart', 'architecture', 'closing'],
      description: 'The slide archetype.',
    },
    kicker: { type: 'string', description: 'Short eyebrow above the headline.' },
    headline: { type: 'string', description: 'The slide title, written as its conclusion.' },
    support: { type: 'string', description: 'One supporting line under the headline.' },
    content: { type: 'string', description: 'The editorial content of the slide: points, figures, labels. Real data only.' },
    footnote: { type: 'string', description: 'Source or footnote.' },
  },
}

const ATTACHED =
  'The server attaches the artifact to your answer where you called the tool; do NOT write a ```prism-block``` for it ' +
  'and do not paste its content. Afterwards tell the user in one or two sentences what you made.'

const DEFS = {
  create_deck: {
    artifact: 'deck',
    action: 'create',
    label: 'Create deck',
    description:
      'Creates a slide deck (presentation) in the user\'s selected design system. Give the plan: a title and one brief ' +
      'per slide; the server writes each slide\'s HTML and streams it to the user. Use when the user asks for a ' +
      'presentation, deck or slides. ' + ATTACHED,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The deck title.' },
        audience: { type: 'string', description: 'Audience or footer line (optional).' },
        author: { type: 'string', description: 'Author for the cover (optional).' },
        slides: { type: 'array', items: SLIDE_BRIEF, description: 'One brief per slide, in order (at most 40).' },
      },
      required: ['title', 'slides'],
    },
  },
  update_deck: {
    artifact: 'deck',
    action: 'update',
    label: 'Update deck',
    description:
      'Revises a deck from this chat (its id is listed below). Only the slides you list are rewritten; ' +
      'the others are kept. A slide with an index past the end is appended. Creates a new version of the deck. ' + ATTACHED,
    parameters: {
      type: 'object',
      properties: {
        deck_id: { type: 'string', description: 'The id of the deck to revise.' },
        title: { type: 'string', description: 'A new title (optional).' },
        slides: {
          type: 'array',
          items: { ...SLIDE_BRIEF, properties: { index: { type: 'integer', description: '0-based slide index to replace.' }, ...SLIDE_BRIEF.properties } },
          description: 'The slides to rewrite, each with its index.',
        },
      },
      required: ['deck_id'],
    },
  },
  create_spreadsheet: {
    artifact: 'spreadsheet',
    action: 'create',
    label: 'Create spreadsheet',
    description:
      'Creates an Excel workbook. Each sheet has a name and blocks: {kind:"title"|"section"|"note", text} or ' +
      '{kind:"table", columns:[{header, format?}], rows:[[...]]}; formulas are strings starting with "=". ' + ATTACHED,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The workbook title.' },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, purpose: { type: 'string' }, blocks: { type: 'array', items: { type: 'object' } } },
            required: ['name', 'blocks'],
          },
        },
        instructions: { type: 'array', items: { type: 'string' }, description: 'How to use the workbook (optional).' },
      },
      required: ['title', 'sheets'],
    },
  },
  update_spreadsheet: {
    artifact: 'spreadsheet',
    action: 'update',
    label: 'Update spreadsheet',
    description:
      'Revises a workbook from this chat (its id is listed below). A sheet you send replaces the ' +
      'sheet with the same name; a new name adds a sheet; the others are kept. Creates a new version. ' + ATTACHED,
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string' },
        title: { type: 'string' },
        sheets: { type: 'array', items: { type: 'object' } },
        instructions: { type: 'array', items: { type: 'string' } },
      },
      required: ['spreadsheet_id'],
    },
  },
  create_document: {
    artifact: 'document',
    action: 'create',
    label: 'Create document',
    description: 'Creates a text document (report, memo, brief) written in Markdown, exportable to DOCX and PDF. ' + ATTACHED,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        markdown: { type: 'string', description: 'The full document in Markdown.' },
      },
      required: ['title', 'markdown'],
    },
  },
  update_document: {
    artifact: 'document',
    action: 'update',
    label: 'Update document',
    description:
      'Revises a document from this chat (its id is listed below): send the full revised Markdown. ' +
      'Creates a new version. ' + ATTACHED,
    parameters: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string', description: 'The full revised document in Markdown.' },
      },
      required: ['document_id', 'markdown'],
    },
  },
}

const ID_FIELD: Record<ArtifactKind, string> = { deck: 'deckId', spreadsheet: 'spreadsheetId', document: 'documentId' }
const BLOCK_TYPE: Record<ArtifactKind, string> = { deck: 'deck-html', spreadsheet: 'spreadsheet', document: 'document' }
export const MAX_KNOWN_ARTIFACTS = 8

/**
 * The artifacts of this chat the update tools can revise, newest first, per
 * kind: { deck: [{ id, title }], spreadsheet: [...], document: [...] }. Read
 * from the owner-scoped history's stored blocks (the replay the model sees
 * strips block ids, so the update tools list them in their description). The
 * list is a hint only: update_* re-reads the row through the owner-scoped getter.
 */
export function knownArtifacts(history: { blocks?: unknown }[] = []): Record<ArtifactKind, KnownArtifact[]> {
  const out: Record<ArtifactKind, KnownArtifact[]> = { deck: [], spreadsheet: [], document: [] }
  const seen = new Set()
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const blocks = history[i]?.blocks
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      for (const [kind, field] of Object.entries(ID_FIELD) as [ArtifactKind, string][]) {
        if (b?.type !== BLOCK_TYPE[kind] || b[field] == null) continue
        const id = String(b[field])
        if (seen.has(`${kind}:${id}`) || out[kind].length >= MAX_KNOWN_ARTIFACTS) continue
        seen.add(`${kind}:${id}`)
        out[kind].push({ id, title: String(b.title || '').replace(/\s+/g, ' ').slice(0, 80) })
      }
    }
  }
  return out
}

function withKnown(description: string, list: KnownArtifact[], artifact: string): string {
  const lines = list.map((a) => `- ${artifact} id ${a.id}: ${JSON.stringify(a.title)}`).join('\n')
  return `${description}\nThe ${artifact}s of this chat, newest first:\n${lines}`
}

/**
 * The artifact tools offered on a turn, for each artifact capability the turn
 * has (caps.deck / caps.spreadsheet / caps.document): create_X always, update_X
 * only when the chat already has an X (caps.known, see knownArtifacts), whose
 * ids its description lists. Returns [{ def, resolver }] in a stable order.
 */
export function artifactToolDefs(caps: { known?: Record<string, KnownArtifact[] | undefined>; [cap: string]: unknown } = {}) {
  const out = []
  for (const [name, d] of Object.entries(DEFS)) {
    if (!caps?.[d.artifact]) continue
    const known = caps.known?.[d.artifact] || []
    if (d.action === 'update' && !known.length) continue
    const description = d.action === 'update' ? withKnown(d.description, known, d.artifact) : d.description
    out.push({
      def: { type: 'function', function: { name, description, parameters: d.parameters } },
      resolver: { kind: ARTIFACT_TOOL_KIND, artifact: d.artifact, action: d.action, ref: { name: d.label } },
    })
  }
  return out
}

// ---------------------------------------------------------------- invocation

class NotFound extends Error {
  declare status: number // assigned in the constructor, as before (no emitted field)
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`)
    this.status = 404
  }
}

const BIGINT_MAX = 9223372036854775807n

// ids are BIGSERIAL. The canonical decimal form (no sign, no leading zeros) is
// THE id at this boundary: "7", "007", " 7 " and 7 are the same row, so the
// owner-scoped getter and the stage key both see "7" (QA r1 #2). Anything that
// is not a BIGINT is not one of the caller's rows and never reaches the database.
export function canonicalRowId(raw?: unknown): string | null {
  const text = typeof raw === 'number' ? (Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : '') : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,40}$/.test(text)) return null
  const n = BigInt(text)
  return n <= BIGINT_MAX ? n.toString() : null
}

function rowId(raw: unknown, what: string): string {
  const id = canonicalRowId(raw)
  if (id == null) throw new NotFound(what, JSON.stringify(String(raw ?? '')).slice(0, 40))
  return id
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

const slideHtml = (s: unknown): string =>
  typeof s === 'string' ? s : typeof (s as { html?: unknown } | null)?.html === 'string' ? (s as { html: string }).html : ''

function addUsage(acc: Usage | null | undefined, u?: Usage | null): Usage | null | undefined {
  if (!u) return acc
  return {
    prompt_tokens: (acc?.prompt_tokens || 0) + (u.prompt_tokens || u.input_tokens || 0),
    completion_tokens: (acc?.completion_tokens || 0) + (u.completion_tokens || u.output_tokens || 0),
  }
}

// Materializes `outline` through the Prism deck engine; slide j streams as index
// targets[j] (identity for a new deck). Rejects with the abort reason on cancel.
async function buildSlides(
  token: string | null | undefined,
  ctx: ToolCtx,
  deps: ArtifactDeps,
  outline: unknown,
  { targets, onTitle }: { targets?: number[]; onTitle: (title: string, total: number) => void }
) {
  const template = await deps.getSelectedDeckTemplate(ctx.email, token).catch(() => null)
  const built = await deps.generateDeckFromOutline(token, ctx.model, outline, {
    template,
    signal: ctx.signal,
    usageKind: ARTIFACT_USAGE_KIND,
    onTitle,
    onSlide: (html: string, j: number) => ctx.send?.({ type: 'deck_slide', html, index: targets ? targets[j] : j }),
  })
  if (built?.cancelled || ctx.signal?.aborted) throw abortError(ctx.signal)
  return built
}

async function createDeck(token: string | null | undefined, args: ToolArgs, ctx: ToolCtx, deps: ArtifactDeps): Promise<Made> {
  const outline = sanitizeDeckOutline(args)
  if (!outline) throw new Error('create_deck needs a title and at least one slide with a headline or content in slides')
  const built = await buildSlides(token, ctx, deps, outline, { onTitle: (title, total) => ctx.send?.({ type: 'deck_stream_start', title, total }) })
  const deck = sanitizeHtmlDeck({ title: outline.title, audience: outline.audience, author: outline.author, slides: built.slides || [] })
  if (!deck) throw new Error('the deck generation produced no slide')
  return { block: { type: 'deck-html', ...deck }, usage: addUsage(null, built.usage), summary: `Deck "${deck.title}" (${deck.slides.length} slides)` }
}

async function updateDeck(token: string | null | undefined, args: ToolArgs, ctx: ToolCtx, deps: ArtifactDeps): Promise<Made> {
  const id = rowId(args.deck_id, 'deck')
  const source = await deps.getDeck(ctx.email, token, id)
  if (!source) throw new NotFound('deck', id)
  const base: string[] = (source.slides || []).map(slideHtml)
  if (!base.length || base.some((h) => !h)) throw new Error(`deck ${id} is in an old format that cannot be revised; create a new deck`)
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : source.title
  const briefs: unknown[] = []
  const targets: number[] = []
  let appendAt = base.length
  for (const s of (Array.isArray(args.slides) ? args.slides : []).slice(0, 40)) {
    const one = sanitizeDeckOutline({ title, slides: [s] })
    if (!one) continue
    const idx = Number.isInteger(s?.index) && s.index >= 0 && s.index < base.length ? s.index : appendAt++
    // the same index twice: the later brief wins, generated once
    const prev = targets.indexOf(idx)
    if (prev >= 0) {
      briefs[prev] = one.slides[0]
      continue
    }
    briefs.push(one.slides[0])
    targets.push(idx)
  }
  if (!briefs.length && title === source.title) throw new Error('update_deck needs slides to rewrite or a new title')
  const slides = [...base]
  let usage: ReturnType<typeof addUsage> = null
  // the live build shows the whole revised deck: the kept slides first, then each rewritten one
  ctx.send?.({ type: 'deck_stream_start', title, total: appendAt })
  base.forEach((html, i) => {
    if (!targets.includes(i)) ctx.send?.({ type: 'deck_slide', html, index: i })
  })
  if (briefs.length) {
    const built = await buildSlides(token, ctx, deps, { title, audience: source.audience, author: source.author, slides: briefs }, { targets, onTitle: () => {} })
    targets.forEach((t, j) => {
      if (built.slides?.[j]) slides[t] = built.slides[j]
    })
    usage = addUsage(null, built.usage)
  }
  const deck = sanitizeHtmlDeck({ title, audience: source.audience, author: source.author, slides: slides.filter(Boolean) })
  if (!deck) throw new Error('the revised deck has no slide')
  return { block: { type: 'deck-html', ...deck }, usage, summary: `Deck "${deck.title}" revised (${deck.slides.length} slides, ${briefs.length} rewritten)` }
}

function checkWorkbook(spec: Parameters<typeof materializeWorkbook>[0]): void {
  try {
    materializeWorkbook(spec)
  } catch (e) {
    throw new Error(`the workbook cannot be built: ${String((e as { message?: unknown } | null)?.message || e).slice(0, 200)}`)
  }
}

function createSpreadsheet(args: ToolArgs): Made {
  const spec = sanitizeSpreadsheet(args)
  if (!spec) throw new Error('create_spreadsheet needs at least one sheet with a valid block (title/section/note text or a table with columns)')
  checkWorkbook(spec)
  return { block: { type: 'spreadsheet', ...spec }, summary: `Spreadsheet "${spec.title}" (${spec.sheets.length} sheet${spec.sheets.length === 1 ? '' : 's'})` }
}

async function updateSpreadsheet(token: string | null | undefined, args: ToolArgs, ctx: ToolCtx, deps: ArtifactDeps): Promise<Made> {
  const id = rowId(args.spreadsheet_id, 'spreadsheet')
  const source = await deps.getSpreadsheet(ctx.email, token, id)
  if (!source) throw new NotFound('spreadsheet', id)
  const incoming = Array.isArray(args.sheets) ? args.sheets.filter((s) => s && typeof s === 'object') : []
  const title = typeof args.title === 'string' && args.title.trim() ? args.title : source.title
  if (!incoming.length && title === source.title && !Array.isArray(args.instructions)) {
    throw new Error('update_spreadsheet needs sheets, a new title or new instructions')
  }
  const key = (s: unknown) => String((s as { name?: unknown } | null | undefined)?.name || '').trim().toLowerCase()
  const byName = new Map(incoming.map((s) => [key(s), s]))
  const merged = (source.sheets || []).map((s: unknown) => {
    const repl = byName.get(key(s))
    if (repl) byName.delete(key(s))
    return repl || s
  })
  merged.push(...byName.values())
  const spec = sanitizeSpreadsheet({ title, sheets: merged, instructions: Array.isArray(args.instructions) ? args.instructions : source.instructions })
  if (!spec) throw new Error('the revised workbook has no valid sheet')
  checkWorkbook(spec)
  return { block: { type: 'spreadsheet', ...spec }, summary: `Spreadsheet "${spec.title}" revised (${spec.sheets.length} sheets)` }
}

async function checkDocument(doc: unknown): Promise<void> {
  try {
    await renderDocx(doc)
  } catch (e) {
    throw new Error(`the document cannot be exported: ${String((e as { message?: unknown } | null)?.message || e).slice(0, 200)}`)
  }
}

async function createDocument(args: ToolArgs): Promise<Made> {
  const doc = sanitizeDocument({ title: args.title, markdown: args.markdown })
  if (!doc) throw new Error('create_document needs a non-empty markdown')
  await checkDocument(doc)
  return { block: { type: 'document', ...doc }, summary: `Document "${doc.title}"` }
}

async function updateDocument(token: string | null | undefined, args: ToolArgs, ctx: ToolCtx, deps: ArtifactDeps): Promise<Made> {
  const id = rowId(args.document_id, 'document')
  const source = await deps.getDocument(ctx.email, token, id)
  if (!source) throw new NotFound('document', id)
  const title = typeof args.title === 'string' && args.title.trim() ? args.title : source.title
  const doc = sanitizeDocument({ title, markdown: args.markdown })
  if (!doc) throw new Error('update_document needs the full revised markdown')
  await checkDocument(doc)
  return { block: { type: 'document', ...doc }, summary: `Document "${doc.title}" revised` }
}

const ID_ARG: Record<string, string> = { deck: 'deck_id', spreadsheet: 'spreadsheet_id', document: 'document_id' }

// What makes two calls "the same artifact" within one answer
function sameArtifactKey(resolver: Resolver, args: ToolArgs): string | null {
  if (resolver.action === 'update') {
    const id = canonicalRowId(args[ID_ARG[resolver.artifact as string] as string]) // an unknown artifact reads args['undefined'], as before
    return id != null ? `${resolver.artifact}:update:${id}` : null
  }
  const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim().toLowerCase() : ''
  return title ? `${resolver.artifact}:create:${title}` : null
}

const RUN: Record<string, (token: string | null | undefined, args: ToolArgs, ctx: ToolCtx, deps: ArtifactDeps) => Made | Promise<Made>> = {
  'deck:create': (token, args, ctx, deps) => createDeck(token, args, ctx, deps),
  'deck:update': updateDeck,
  'spreadsheet:create': (token, args) => createSpreadsheet(args),
  'spreadsheet:update': updateSpreadsheet,
  'document:create': (token, args) => createDocument(args),
  'document:update': updateDocument,
}

/**
 * Runs an artifact tool call and stages its artifact. `ctx` is the turn's tool
 * context: { email, model, signal, send, artifacts (the stage), toolCallId }.
 * Returns { resultText, chartCandidates: [], usage? } — `usage` is the token
 * spend of the generation (already in the ledger as kind 'artifact'), so the
 * turn can fold it into the answer's shown cost.
 */
export async function invokeArtifactTool(
  token: string | null | undefined,
  resolver: Resolver | null | undefined,
  args: unknown,
  ctx: ToolCtx = {},
  deps: ArtifactDeps = defaultDeps
) {
  const stage = ctx.artifacts
  if (!stage) throw new Error('artifact tools run only inside a chat turn')
  ctx.signal?.throwIfAborted()
  const name = resolver?.toolName || `${resolver?.action}_${resolver?.artifact}`
  const run = RUN[`${resolver?.artifact}:${resolver?.action}`]
  if (!run) throw new Error(`unknown artifact tool ${name}`)
  const res = resolver as Resolver // `run` exists only for a resolver, so it is set past the check above
  const a = (args && typeof args === 'object' ? args : {}) as ToolArgs
  const serialized = JSON.stringify(a)
  if (serialized.length > MAX_ARTIFACT_ARGS_CHARS) {
    throw new Error(`${name} arguments are too large (${serialized.length.toLocaleString('en-US')} characters; the limit is ${MAX_ARTIFACT_ARGS_CHARS.toLocaleString('en-US')}). Send less content, or split it across several sheets/slides/calls.`)
  }
  const key = `${name}:${serialized}`
  const already = stage.find(key)
  if (already) {
    return { resultText: `This ${res.artifact} was already created in this answer (${already.ref}); it is attached once. ${ATTACHED}`, chartCandidates: [] }
  }
  // the same artifact again in this answer (same title for a create, same source
  // for an update): the new version replaces the staged one, never a second artifact
  const sameAs = sameArtifactKey(res, a)
  // refused before any generation is spent
  if (stage.wouldExceed(sameAs)) throw new Error(`artifact limit reached: at most ${MAX_STAGED_ARTIFACTS} artifacts per answer`)
  const made = await run(token, a, ctx, deps)
  // a cancel that landed while the engine finished: nothing is staged
  ctx.signal?.throwIfAborted()
  const { ref, replaced } = stage.stage(ctx.toolCallId, made.block, key, { sameAs })
  const verb = replaced ? 'replaces the earlier version in this answer' : 'created'
  const out: { resultText: string; chartCandidates: never[]; usage?: Usage } = { resultText: `${made.summary} ${verb} (${ref}). ${ATTACHED}`, chartCandidates: [] }
  if (made.usage) out.usage = made.usage
  return out
}

type ArtifactDeps = typeof defaultDeps
