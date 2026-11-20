// Taxímetro: the server-side cost ledger. Every gateway call reports its token
// usage through llm.js's reportUsage() sink → recordUsage() here, which prices
// it, stamps who/which session from the request scope and writes one
// usage_ledger row. The meter (GET /api/usage/summary) sums those rows.
//
// Why a request scope (AsyncLocalStorage) instead of threading req through:
// the calls live deep in llm.js/transcribe.js/tools.js (title, embeddings,
// intent classifier, image tool…) and none of them sees `req`. The auth
// middleware opens the scope; routes only add what they learn later (the
// sessionId once the conversation exists, kind:'tweak' in the studios).
import { AsyncLocalStorage } from 'node:async_hooks'
import { insertUsageLedger, usageTotals } from './db.js'
import { resolvePrice } from './serving.ts'
import type { PriceOverrides } from './serving.ts'
import { logger } from './log.js'

/** One usage_ledger row as insertUsageLedger (db.js) takes it. */
interface UsageRow {
  sessionId: string | null
  kind: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  estimated: boolean
  costUsd: number | null
}

/** Per-request store opened by openUsageScope; also kept on req.usageScope. */
interface UsageScope {
  email?: string
  token?: string
  sessionId: string | null
  kind: string | null
  held: UsageRow[] | null
  turnRows: UsageRow[] | null
  dropTurn: boolean
}

// the slice of an Express req/res/next the scope middleware touches
interface ScopeReq {
  email?: string
  token?: string
  usageScope?: UsageScope
}

/** Gateway usage payload (OpenAI-style plus the cache/image extras); every field optional. */
interface GatewayUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
  image_output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null
  [extra: string]: unknown
}

interface NormalizedUsage {
  prompt: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type Price = { in: number; out: number }
type Env = Record<string, string | undefined>

const scope = new AsyncLocalStorage<UsageScope>()

// Run `fn` (an Express `next`) inside a fresh usage scope for this request.
// The store object is also kept on req so a middleware that loses the async
// context (multer parses multipart on stream events) can re-enter it — see
// rebindUsageScope.
export function openUsageScope(req: ScopeReq, res: { on(event: 'close', cb: () => void): unknown }, next: () => void): void {
  const store: UsageScope = { email: req.email, token: req.token, sessionId: null, kind: null, held: null, turnRows: null, dropTurn: false }
  req.usageScope = store
  // rows held for a session that never materialized (the turn failed before
  // creating it) still count toward the month — written session-less at the end
  res.on('close', () => flushHeld(store))
  scope.run(store, next)
}
export function rebindUsageScope(req: ScopeReq, res: unknown, next: () => void): void {
  if (req.usageScope) scope.run(req.usageScope, next)
  else next()
}
export function setUsageSession(sessionId: unknown): void {
  const s = scope.getStore()
  if (!s || sessionId == null) return
  s.sessionId = String(sessionId)
  flushHeld(s)
}
// A brand-new chat spends BEFORE its session exists (media transcription,
// the intent classifier). Holding those rows until setUsageSession lets them
// land on the conversation instead of floating session-less.
export function holdUsageUntilSession(): void {
  const s = scope.getStore()
  if (s && !s.sessionId) s.held = []
}
function flushHeld(s: UsageScope): void {
  const rows = s.held
  s.held = null
  for (const row of rows || []) writeRow(s, { ...row, sessionId: s.sessionId })
}
// A chat turn's own rows (server/turn.js): buffered from the moment the turn
// works on an existing session, written when the turn commits its answer — or
// ends without a cancel (a failed turn still spent) — and dropped when the
// client cancelled it, so a cancelled turn leaves no row at any stage. Rows
// recorded after the turn committed (title, embeddings) are written as usual;
// rows recorded after a drop are dropped too. Each takes the request's scope
// store (req.usageScope): the turn's cancel handler runs outside the request's
// async context.
export function bufferTurnUsage(store?: UsageScope | null): void {
  if (!store || store.dropTurn) return
  store.turnRows ??= []
}
export function flushTurnUsage(store?: UsageScope | null): void {
  if (!store?.turnRows) return
  const rows = store.turnRows
  store.turnRows = null
  for (const row of rows) emitRow(store, row)
}
export function dropTurnUsage(store?: UsageScope | null): void {
  if (!store) return
  store.turnRows = null
  store.dropTurn = true
}

export function setUsageKind(kind: string | null): void {
  const s = scope.getStore()
  if (s) s.kind = kind
}

// ---- pricing ---------------------------------------------------------------
// Admin overrides, refreshed by index.js whenever it reloads the catalog
// (getUserModels, 30s TTL). Until the first load the curated/family prices apply.
let priceOverrides: PriceOverrides = {}
export function setPriceOverrides(overrides?: PriceOverrides | null): void {
  priceOverrides = overrides || {}
}

// Prompt-cache billing relative to the input price, per family. Sondado ao vivo
// (nov/2026): `prompt_tokens` INCLUDES the cached tokens on every family, so the
// discount is applied to that slice only. Anthropic bills reads at 0.1× and
// writes at 1.25×; OpenAI reads at ≤0.1× (we use 0.1, the conservative end).
// Other families report cache fields inconsistently → no discount (full price).
function cacheRates(model?: string | null): { read: number; write: number } {
  const s = (model || '').toLowerCase()
  if (s.includes('claude')) return { read: 0.1, write: 1.25 }
  if (s.includes('gpt')) return { read: 0.1, write: 1 }
  return { read: 1, write: 1 }
}

// Normalizes the many usage shapes the gateway returns into billable counts.
// Output = max(completion, total − prompt): Gemini (and the image endpoint)
// report reasoning/image tokens OUTSIDE completion_tokens but inside
// total_tokens — sondado: Gemini 3.6 Flash completion 3, reasoning 119, total
// 136; Nano Banana completion 0, total 522. Those tokens are billed as output.
export function normalizeUsage(u?: GatewayUsage | null): NormalizedUsage | null {
  if (!u) return null
  const prompt = Number(u.prompt_tokens) || 0
  const completion = (Number(u.completion_tokens) || 0) + (Number(u.image_output_tokens) || 0)
  const total = Number(u.total_tokens) || 0
  const output = Math.max(completion, total ? total - prompt : 0)
  const cacheRead = Number(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0
  const cacheWrite = Number(u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_write_tokens) || 0
  if (!prompt && !output) return null
  return { prompt, output, cacheRead: Math.min(cacheRead, prompt), cacheWrite: Math.min(cacheWrite, prompt) }
}

// USD for a normalized usage at a {in,out} price (USD per 1M tokens), or null
// when the model has no known price.
export function costOf(n: NormalizedUsage | null, price: Price | null, model?: string | null): number | null {
  if (!n || !price) return null
  const r = cacheRates(model)
  const fresh = Math.max(0, n.prompt - n.cacheRead - n.cacheWrite)
  const input = fresh + n.cacheRead * r.read + n.cacheWrite * r.write
  return (input * price.in + n.output * price.out) / 1e6
}

export function priceUsage(model: string, usage?: GatewayUsage | null) {
  const n = normalizeUsage(usage)
  const costUsd = costOf(n, resolvePrice(model, priceOverrides), model)
  return { n, costUsd, promptTokens: n?.prompt ?? null, completionTokens: n?.output ?? null }
}

// ---- month window ------------------------------------------------------------
// Offset (ms) of `tz` from UTC at instant `date`.
function tzOffsetMs(tz: string, date: Date): number {
  const parts: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  )
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}
// UTC instant of local midnight on day 1 of month (y, m0) in `tz` — offset
// re-read at the candidate so a DST change near the boundary lands right.
function zonedMonthStart(tz: string, y: number, m0: number): Date {
  const guess = Date.UTC(y, m0, 1)
  let start = guess - tzOffsetMs(tz, new Date(guess))
  start = guess - tzOffsetMs(tz, new Date(start))
  return new Date(start)
}
// The billing month containing `now`, in time zone `tz`: { start, end } (end
// exclusive = when the meter resets).
export function monthWindow(tz = 'UTC', now = new Date()): { start: Date; end: Date } {
  const parts: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  )
  const y = +parts.year!
  const m0 = +parts.month! - 1
  return { start: zonedMonthStart(tz, y, m0), end: zonedMonthStart(tz, m0 === 11 ? y + 1 : y, (m0 + 1) % 12) }
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Time zone of the taxímetro's billing month. Set USAGE_TIMEZONE (an IANA name,
// e.g. America/Sao_Paulo) to roll the month over at local midnight; anything
// missing or invalid falls back to UTC.
export function usageTimeZone(env: Env = process.env): string {
  const tz = String(env.USAGE_TIMEZONE || '').trim()
  return isValidTimeZone(tz) ? tz : 'UTC'
}

// ---- recording ---------------------------------------------------------------
// In-flight inserts per user: the meter refetches right after a turn's `done`,
// while the title/embedding rows of that same turn may still be writing.
// getUsageSummary waits for them (bounded) so the number it shows is complete.
const pending = new Map<string, Set<Promise<unknown>>>() // email -> Set<Promise>

function track(email: string, p: Promise<unknown>): void {
  let set = pending.get(email)
  if (!set) pending.set(email, (set = new Set()))
  set.add(p)
  p.finally(() => {
    set.delete(p)
    if (!set.size) pending.delete(email)
  })
}

// The llm.js sink. Never throws and never blocks the caller: pricing is
// synchronous, the insert is fire-and-forget (tracked for the summary).
// `estimated` marks tokens approximated because the endpoint sent no usage.
export function recordUsage(kind: string, model: string, usage?: GatewayUsage | null, { estimated = false }: { estimated?: boolean } = {}): number | null {
  const s = scope.getStore()
  if (!s?.email) return null // background work outside any request: nothing to attribute
  const { n, costUsd } = priceUsage(model, usage)
  if (!n) return null
  const row: UsageRow = {
    sessionId: s.sessionId,
    // a studio route marks its whole scope as 'tweak'; internal calls made
    // under it (none today) would still keep their own specific kind
    kind: s.kind && kind === 'chat' ? s.kind : kind,
    model,
    promptTokens: n.prompt,
    completionTokens: n.output,
    cacheReadTokens: n.cacheRead || null,
    cacheWriteTokens: n.cacheWrite || null,
    estimated,
    costUsd,
  }
  if (s.dropTurn) return costUsd // a cancelled turn's late call: priced for its span, never written
  if (s.turnRows) s.turnRows.push(row)
  else emitRow(s, row)
  return costUsd
}

// ---- fixed-cost tool rows (ADR-0008) -----------------------------------------
// A tool call with a per-call price and no tokens (web search). Price in USD per
// 1,000 calls, first match wins: admin override 'tool:web_search:<provider>' →
// override 'tool:web_search' (the `priceIn` field of the model-override row) →
// WEB_SEARCH_PRICE_PER_1K_USD (every provider, seeded ones included) → the seed.
// The MCP providers have no published price: null ("não precificado") until an
// admin or the env sets one.
const TOOL_PRICE_SEEDS_PER_1K: Record<string, Record<string, number>> = { web_search: { brave: 5, tavily: 8, searxng: 0 } }

export function toolPricePer1k(provider: string | null | undefined, env: Env = process.env, kind = 'web_search'): number | null {
  const o = priceOverrides[`tool:${kind}:${provider}`]?.priceIn ?? priceOverrides[`tool:${kind}`]?.priceIn
  if (typeof o === 'number' && Number.isFinite(o)) return o
  const fromEnv = kind === 'web_search' ? Number.parseFloat(env.WEB_SEARCH_PRICE_PER_1K_USD as string) : NaN
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv
  return TOOL_PRICE_SEEDS_PER_1K[kind]?.[provider as string] ?? null
}

/**
 * One token-less usage_ledger row (kind, model = provider, tokens 0, cost_usd
 * or null). Same request scope as recordUsage: buffered in the turn, dropped
 * with a cancelled turn, held until the session exists. Returns the cost, or
 * null outside a request scope.
 */
export function recordToolUsage({
  kind,
  provider,
  units = 1,
  costUsd = null,
  model = null,
}: { kind?: string; provider?: string; units?: number; costUsd?: number | null; model?: string | null } = {}): number | null {
  const s = scope.getStore()
  if (!s?.email || !kind) return null
  const per1k = toolPricePer1k(provider, process.env, kind)
  const cost: number | null = costUsd ?? (per1k == null ? null : (per1k * (Number(units) || 1)) / 1000)
  const row: UsageRow = {
    sessionId: s.sessionId,
    kind,
    model: model || provider || null,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimated: false,
    costUsd: cost,
  }
  if (s.dropTurn) return cost
  if (s.turnRows) s.turnRows.push(row)
  else emitRow(s, row)
  return cost
}

function emitRow(s: UsageScope, row: UsageRow): void {
  if (s.held && !s.sessionId) s.held.push(row)
  else writeRow(s, row)
}

function writeRow(s: UsageScope, row: UsageRow): void {
  const p = insertUsageLedger(s.email as string, s.token, row).catch((e) => logger.warn('usage ledger insert failed', { err: e }))
  track(s.email as string, p)
}

// ---- summary -------------------------------------------------------------------
export async function getUsageSummary(
  email: string,
  token: string | null | undefined,
  { sessionId = null, tz = 'UTC' }: { sessionId?: string | null; tz?: string } = {}
) {
  const inflight = pending.get(email)
  if (inflight?.size) {
    await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 2000))])
  }
  const { start, end } = monthWindow(tz)
  const t = await usageTotals(email, token, { since: start, sessionId })
  return {
    month: { start: start.toISOString(), resetsAt: end.toISOString(), timezone: tz, ...t.month },
    session: sessionId ? { id: String(sessionId), ...t.session } : null,
  }
}

// The one-time copy of pre-ledger history into the ledger reads every user's
// messages, so it is a data migration run by the owner (server/db/backfillUsage.js,
// `node scripts/migrate.mjs backfill-usage`), not a per-process request-path job.
