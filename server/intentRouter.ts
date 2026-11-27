// Intent router (router-design.md). Decides what a turn is about — deck / document / spreadsheet /
// image / company data — and hints at web search and enabled tools, behind the INTENT_ROUTER flag:
//
//   haiku   (default) the Haiku classifier alone: classifyIntent in llm.ts, untouched.
//   shadow  Haiku decides exactly as before; OpenJev (Qwen3.5 4B on System One) runs in parallel, is
//           NEVER awaited on the turn's path, and only feeds the intent_router telemetry event.
//   race    OpenJev and Haiku start together. When OpenJev is confident (resolveRoutes) its rules
//           decide and Haiku is aborted; otherwise (or when OpenJev failed) Haiku decides. Latency
//           is never the sum of the two. Both failing returns null, so the regexes decide, as today.
//
// OpenJev answers one batched request of yes/no (`noul`) questions: one per route and one per
// enabled tool. On its own it lost in-sample (13/21 vs the regex 16/21), so resolveRoutes layers
// rules over the probabilities and the regex signal. The router never removes an enabled tool or
// web search: tool and web verdicts are hints (and telemetry), nothing else.
//
// Everything here degrades: classifyIntentOpenJev never throws, a workspace without the endpoint
// falls back to haiku with one log line, and the turn only ever sees the same shape classifyIntent
// returns ({ intents, usage }, plus optional source/hints).
import { classifyIntent, host, reportUsage } from './llm.ts'
import { detectCapabilities, hasDataIntent } from './blocks.ts'
import { logger } from './log.ts'
import { startSpan, finishSpan, withSpan } from './telemetry.ts'

type Loose = any

export type PreviousArtifact = 'deck' | 'document' | 'spreadsheet' | 'image'
export interface EnabledTool {
  id: string
  name: string
  description: string
}
export interface RouteIntents {
  deck: boolean
  spreadsheet: boolean
  image: boolean
  document: boolean
  data: boolean
}
export interface OpenJevResult {
  probs: Record<string, number>
  usage: { input_tokens: number; output_tokens: number } | null
  model: string | null
}
export interface ResolvedRoutes {
  intents: RouteIntents
  webHint: boolean
  toolHints: string[]
  confident: boolean
}
export interface RoutedIntent {
  intents: RouteIntents
  usage: Loose
  source?: 'openjev' | 'haiku'
  hints?: { webHint: boolean; toolHints: string[] }
}

export const OPENJEV_DEFAULT_ENDPOINT = 'system.ai.openjev-qwen35-4b'
export const OPENJEV_TIMEOUT_MS = 1500
export const QUESTIONS_VERSION = 'v1'
const MAX_MESSAGE_CHARS = 6000
const MAX_TOOL_QUESTIONS = 24
const UNAVAILABLE_MS = 10 * 60 * 1000

const ARTIFACTS = ['deck', 'document', 'spreadsheet', 'image'] as const
type Artifact = (typeof ARTIFACTS)[number]
const ROUTE_KEYS = [...ARTIFACTS, 'web', 'data'] as const

// ---- resolveRoutes (pure) ---------------------------------------------------------------------

const BAND_LO = 0.35
const BAND_HI = 0.65
const inBand = (p: number) => p >= BAND_LO && p < BAND_HI

/**
 * Probabilities + regex signal -> routes. Rules (tuned on the 40-item eval, so optimistic until the
 * held-out eval): the top artifact at p >= 0.5; another at p >= 0.85, or >= 0.5 when the regex
 * agrees; any artifact the regex flagged at p >= 0.2 (rescue: the regex wins unless the model is
 * sure); data at p >= 0.5. Not confident when an artifact or data sits in [0.35, 0.65) or the regex
 * and the rules disagree on the artifact set. web >= 0.85 and tool >= 0.5 are hints only.
 * `previousArtifact` is accepted for the contract; the regex signal already carries the sticky
 * artifact, so the rules do not read it.
 */
export function resolveRoutes(input: { probs: Record<string, number>; regex: RouteIntents; previousArtifact?: string | null }): ResolvedRoutes {
  const probs = input.probs || {}
  const p = (k: string): number => {
    const v = probs[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const regex = input.regex
  let top: Artifact = 'deck'
  for (const a of ARTIFACTS) if (p(a) > p(top)) top = a
  const on = new Set<Artifact>()
  if (p(top) >= 0.5) on.add(top)
  for (const a of ARTIFACTS) {
    if (a === top) continue
    if (p(a) >= 0.85 || (p(a) >= 0.5 && regex[a])) on.add(a)
  }
  for (const a of ARTIFACTS) if (regex[a] && p(a) >= 0.2) on.add(a)
  const data = p('data') >= 0.5
  const regexSet = ARTIFACTS.filter((a) => regex[a])
  const agree = regexSet.length === on.size && regexSet.every((a) => on.has(a))
  const unsure = ARTIFACTS.some((a) => inBand(p(a))) || inBand(p('data')) || !agree
  const toolHints = Object.keys(probs)
    .filter((k) => k.startsWith('tool_') && p(k) >= 0.5)
    .map((k) => k.slice(5))
  return {
    intents: { deck: on.has('deck'), spreadsheet: on.has('spreadsheet'), image: on.has('image'), document: on.has('document'), data },
    webHint: p('web') >= 0.85,
    toolHints,
    confident: !unsure,
  }
}

// ---- OpenJev client ---------------------------------------------------------------------------

function nq(instructions: string, t: string, f: string) {
  return { type: 'noul', instructions, criteria: { true: t, false: f } }
}

/** The v1 question set: one noul per route (text pinned from the eval harness) and one per tool. */
export function openjevQuestions(tools: { key: string; name: string; description: string }[] = []): Record<string, Loose> {
  const q: Record<string, Loose> = {
    deck: nq(
      'Does the user ask, in this message, to create or change a slide deck / presentation?',
      'The user wants slides, a deck, a presentation or a pitch produced or edited now, including a follow-up edit when previous_artifact is "deck".',
      'No deck is requested now; slides or presentations are at most mentioned as a topic or as narrative content.'
    ),
    document: nq(
      'Does the user ask, in this message, to create or change a written document artifact?',
      'The user wants a document (report, article, memo, letter, contract, proposal, specification) produced or edited now, including a follow-up edit when previous_artifact is "document".',
      'No document artifact: a chat answer, explanation, short post or poem, or documents only mentioned as content.'
    ),
    spreadsheet: nq(
      'Does the user ask, in this message, to create or change a spreadsheet?',
      'The user wants a spreadsheet, .xlsx, financial model, budget sheet or workbook produced or edited now.',
      'No spreadsheet is requested; a table inside a chat answer is not a spreadsheet.'
    ),
    image: nq(
      'Does the user ask, in this message, to generate or edit an image?',
      'The user wants a picture, illustration, logo, icon, banner or cover image generated or edited now.',
      'No image generation is requested.'
    ),
    web: nq(
      'Does a good answer need a live web search for current public information?',
      'It needs fresh public facts: news, prices, quotes, exchange rates, weather, recent events, regulations, competitor information.',
      "General knowledge, a calculation, the user's own company data, or content that needs no fresh public facts."
    ),
    data: nq(
      "Does a good answer need the user's OWN company data from their workspace (Genie One data query)?",
      'It must query their internal tables or metrics: their revenue, customers, sales, churn, KPIs, orders.',
      'No internal data is needed: business terms are only the subject or narrative, or the question is general or public.'
    ),
  }
  for (const t of tools) {
    const desc = `${t.name}${t.description ? `: ${t.description}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 240)
    q[`tool_${t.key}`] = nq(
      `Does fulfilling this message require the enabled tool described here? Tool: ${desc}`,
      'The user asks for an action or information that this specific tool provides.',
      'This tool is not needed for this message.'
    )
  }
  return q
}

/** `[a-z0-9_]` question key for a tool id; collisions get a numeric suffix. */
export function toolKeys(tools: EnabledTool[]): { key: string; id: string; name: string; description: string }[] {
  const seen = new Set<string>()
  const out: { key: string; id: string; name: string; description: string }[] = []
  for (const t of tools.slice(0, MAX_TOOL_QUESTIONS)) {
    const base = String(t.id || t.name || 'tool').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
    let key = base
    for (let n = 2; seen.has(key); n++) key = `${base}_${n}`
    seen.add(key)
    out.push({ key, id: t.id, name: t.name || t.id, description: t.description || '' })
  }
  return out
}

/** The turn's enabled tool refs (opts.enabledToolRefs) as name/description pairs for the questions. */
export function toolsFromRefs(refs: unknown): EnabledTool[] {
  if (!Array.isArray(refs)) return []
  const out: EnabledTool[] = []
  for (const r of refs as Loose[]) {
    if (!r || typeof r !== 'object' || r.off) continue
    const id = String(r.connectionName || r.name || r.fullName || r.function || r.id || r.spaceId || r.kind || '').trim()
    if (!id) continue
    out.push({ id, name: String(r.displayName || r.title || r.connectionName || r.name || r.fullName || id), description: String(r.comment || r.description || '') })
  }
  return out
}

function configuredEndpoint(): string | null {
  const v = process.env.INTENT_OPENJEV_ENDPOINT
  if (v === undefined) return OPENJEV_DEFAULT_ENDPOINT
  return v.trim() || null
}

let unavailableUntil = 0
const logged = new Set<string>()
function logOnce(key: string, msg: string): void {
  if (logged.has(key)) return
  logged.add(key)
  logger.warn(msg)
}
export function resetIntentRouterForTests(): void {
  unavailableUntil = 0
  logged.clear()
}

/**
 * One batched System One request for the turn. Never throws: HTTP != 200, 422, a timeout, invalid
 * JSON, missing answers or a cancel are all null. A 404 (the endpoint does not exist in this
 * workspace) also parks OpenJev for ten minutes and logs once, so deploys without it stay on Haiku.
 */
export async function classifyIntentOpenJev(
  token: string,
  userText: string,
  opts: { previousArtifact?: PreviousArtifact | null; enabledTools?: EnabledTool[]; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<OpenJevResult | null> {
  try {
    const text = String(userText || '').slice(0, MAX_MESSAGE_CHARS)
    const model = configuredEndpoint()
    if (!text.trim() || !model || Date.now() < unavailableUntil) return null
    return await withSpan('llm.call', { 'gen_ai.request.model': model }, (span) => openjevRaw(token, text, model, opts, span))
  } catch {
    return null
  }
}

async function openjevRaw(token: string, text: string, model: string, opts: Loose, span: Loose): Promise<OpenJevResult | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? OPENJEV_TIMEOUT_MS)
  try {
    const tools = toolKeys(opts.enabledTools || [])
    const body = {
      model,
      state: { message: text, previous_artifact: opts.previousArtifact || 'none' },
      questions: openjevQuestions(tools),
    }
    const res = await fetch(`${host()}/ai-gateway/typesafe/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal,
    })
    if (res.status === 404) {
      unavailableUntil = Date.now() + UNAVAILABLE_MS
      logOnce('404', 'intent router: OpenJev endpoint not found in this workspace; using the Haiku classifier')
      return null
    }
    if (!res.ok) return null
    const json: Loose = await res.json()
    const answers = json?.answers
    if (!answers || typeof answers !== 'object') return null
    const probs: Record<string, number> = {}
    for (const [k, v] of Object.entries<Loose>(answers)) if (typeof v?.noul === 'number' && Number.isFinite(v.noul)) probs[k] = v.noul
    if (!ROUTE_KEYS.every((k) => k in probs)) return null
    const input = Number(json.usage?.input_tokens ?? json.usage?.prompt_tokens)
    const output = Number(json.usage?.output_tokens ?? json.usage?.completion_tokens ?? 0)
    const usage = Number.isFinite(input) ? { input_tokens: input, output_tokens: Number.isFinite(output) ? output : 0 } : null
    if (usage) reportUsage('intent_openjev', model, { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens }, undefined, span)
    return { probs, usage, model: typeof json.model === 'string' ? json.model : null }
  } finally {
    clearTimeout(timer)
  }
}

// ---- routeIntent ------------------------------------------------------------------------------

type Mode = 'haiku' | 'shadow' | 'race'

function effectiveMode(): Mode {
  const raw = String(process.env.INTENT_ROUTER || 'haiku').trim().toLowerCase()
  if (raw !== 'shadow' && raw !== 'race') return 'haiku'
  if (!configuredEndpoint()) {
    logOnce('empty', 'intent router: INTENT_OPENJEV_ENDPOINT is empty; OpenJev is off, using the Haiku classifier')
    return 'haiku'
  }
  return Date.now() < unavailableUntil ? 'haiku' : raw
}

const BLOCK_ARTIFACT: Record<string, PreviousArtifact> = {
  deck: 'deck',
  'deck-html': 'deck',
  'deck-questions': 'deck',
  document: 'document',
  spreadsheet: 'spreadsheet',
  image: 'image',
}
function previousArtifactOf(history: Loose): PreviousArtifact | null {
  for (let i = (history?.length || 0) - 1; i >= 0; i--) {
    const blocks = history[i]?.blocks
    if (!Array.isArray(blocks)) continue
    for (let j = blocks.length - 1; j >= 0; j--) {
      const a = BLOCK_ARTIFACT[blocks[j]?.type]
      if (a) return a
    }
  }
  return null
}

function regexSignals(userText: string, history: Loose, classifyOpts: Loose): RouteIntents {
  const { classifier: _c, ...rest } = classifyOpts || {}
  const caps = detectCapabilities(userText, history, rest)
  return { deck: !!caps.deck, document: !!caps.document, spreadsheet: !!caps.spreadsheet, image: !!caps.image, data: hasDataIntent(userText) }
}

interface OpenJevRun {
  o: OpenJevResult | null
  ms: number
  resolved: ResolvedRoutes | null
}

/** Never rejects. Maps the tool hints back from question keys to the original tool ids. */
async function runOpenJev(req: Loose, userText: string, history: Loose, classifyOpts: Loose, regex: RouteIntents, signal?: AbortSignal): Promise<OpenJevRun> {
  const started = performance.now()
  const previousArtifact = previousArtifactOf(history)
  const enabledTools = toolsFromRefs(classifyOpts?.enabledToolRefs)
  const o = await classifyIntentOpenJev(req.token, userText, { previousArtifact, enabledTools, signal })
  const ms = Math.round(performance.now() - started)
  if (!o) return { o, ms, resolved: null }
  const resolved = resolveRoutes({ probs: o.probs, regex, previousArtifact })
  const byKey = new Map(toolKeys(enabledTools).map((t) => [t.key, t.id]))
  resolved.toolHints = resolved.toolHints.map((k) => byKey.get(k) ?? k)
  return { o, ms, resolved }
}

interface HaikuRun {
  r: Loose
  ms: number
}

function emitEvent(a: Record<string, string | number | boolean>): void {
  try {
    finishSpan(startSpan('intent_router', a), null)
  } catch {
    // telemetry never breaks the turn
  }
}

const intentsOf = (r: Loose): RouteIntents | null => (r?.intents ? { deck: !!r.intents.deck, spreadsheet: !!r.intents.spreadsheet, image: !!r.intents.image, document: !!r.intents.document, data: !!r.intents.data } : null)

/**
 * Drop-in for classifyIntent at the turn: same arguments' meaning, same result shape. Never throws.
 * `classifyOpts` is the turn's (hasPptxAttachment, ...) plus `enabledToolRefs` for the tool questions.
 */
export async function routeIntent(req: Loose, userText: string, history: Loose, classifyOpts: Loose = {}, signal?: AbortSignal): Promise<RoutedIntent | null> {
  const mode = effectiveMode()
  if (mode === 'haiku') return (await classifyIntent(req.token, userText, { signal }).catch(() => null)) as RoutedIntent | null

  const regex = regexSignals(userText, history, classifyOpts)
  const hCtrl = new AbortController()
  const hSignal = signal ? AbortSignal.any([hCtrl.signal, signal]) : hCtrl.signal
  let hAborted = false
  const hStarted = performance.now()
  const hP: Promise<HaikuRun> = classifyIntent(req.token, userText, { signal: mode === 'race' ? hSignal : signal })
    .catch(() => null)
    .then((r) => ({ r: r as Loose, ms: Math.round(performance.now() - hStarted) }))
  const oP = runOpenJev(req, userText, history, classifyOpts, regex, signal)

  // the event, written once both sides have settled — never on the turn's path
  const record = (chosen: 'openjev' | 'haiku' | 'regex') =>
    void Promise.all([oP, hP]).then(([o, h]) => {
      const h_ints = intentsOf(h.r)
      emitEvent({
        mode,
        gate: true,
        regex: JSON.stringify(regex),
        haiku: JSON.stringify(h_ints),
        openjev_probs: JSON.stringify(o.o?.probs ?? null),
        resolved: JSON.stringify(o.resolved?.intents ?? null),
        confident: !!o.resolved?.confident,
        web_hint: !!o.resolved?.webHint,
        tool_hints: JSON.stringify(o.resolved?.toolHints ?? []),
        chosen_source: chosen,
        ms_openjev: o.ms,
        ms_haiku: hAborted ? -1 : h.ms,
        haiku_empty: !h.r && !hAborted && !signal?.aborted,
        questions_version: QUESTIONS_VERSION,
      })
    })

  if (mode === 'shadow') {
    const h = await hP
    record(h.r ? 'haiku' : 'regex')
    return h.r
  }

  // race
  const fromOpenJev = (run: OpenJevRun): RoutedIntent => ({
    intents: run.resolved!.intents,
    usage: null,
    source: 'openjev',
    hints: { webHint: run.resolved!.webHint, toolHints: run.resolved!.toolHints },
  })
  const fromHaiku = (h: HaikuRun, o?: OpenJevRun): RoutedIntent => ({ ...h.r, source: 'haiku', ...(o?.resolved ? { hints: { webHint: o.resolved.webHint, toolHints: o.resolved.toolHints } } : {}) })
  const first = await Promise.race([oP.then((v) => ({ k: 'o' as const, v })), hP.then((v) => ({ k: 'h' as const, v }))])
  if (first.k === 'o') {
    if (first.v.resolved?.confident) {
      hAborted = true
      hCtrl.abort()
      record('openjev')
      return fromOpenJev(first.v)
    }
    const h = await hP
    record(h.r ? 'haiku' : 'regex')
    return h.r ? fromHaiku(h, first.v) : null
  }
  if (first.v.r) {
    record('haiku')
    return fromHaiku(first.v)
  }
  const o = await oP
  if (o.resolved?.confident) {
    record('openjev')
    return fromOpenJev(o)
  }
  record('regex')
  return null
}
