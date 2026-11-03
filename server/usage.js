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
import { insertUsageLedger, usageTotals, backfillUsageLedger } from './db.js'
import { resolvePrice } from './serving.js'

const scope = new AsyncLocalStorage()

// Run `fn` (an Express `next`) inside a fresh usage scope for this request.
// The store object is also kept on req so a middleware that loses the async
// context (multer parses multipart on stream events) can re-enter it — see
// rebindUsageScope.
export function openUsageScope(req, res, next) {
  const store = { email: req.email, token: req.token, sessionId: null, kind: null, held: null }
  req.usageScope = store
  // rows held for a session that never materialized (the turn failed before
  // creating it) still count toward the month — written session-less at the end
  res.on('close', () => flushHeld(store))
  scope.run(store, next)
}
export function rebindUsageScope(req, res, next) {
  if (req.usageScope) scope.run(req.usageScope, next)
  else next()
}
export function setUsageSession(sessionId) {
  const s = scope.getStore()
  if (!s || sessionId == null) return
  s.sessionId = String(sessionId)
  flushHeld(s)
}
// A brand-new chat spends BEFORE its session exists (media transcription,
// the intent classifier). Holding those rows until setUsageSession lets them
// land on the conversation instead of floating session-less.
export function holdUsageUntilSession() {
  const s = scope.getStore()
  if (s && !s.sessionId) s.held = []
}
function flushHeld(s) {
  const rows = s.held
  s.held = null
  for (const row of rows || []) writeRow(s, { ...row, sessionId: s.sessionId })
}
export function setUsageKind(kind) {
  const s = scope.getStore()
  if (s) s.kind = kind
}

// ---- pricing ---------------------------------------------------------------
// Admin overrides, refreshed by index.js whenever it reloads the catalog
// (getUserModels, 30s TTL). Until the first load the curated/family prices apply.
let priceOverrides = {}
export function setPriceOverrides(overrides) {
  priceOverrides = overrides || {}
}

// Prompt-cache billing relative to the input price, per family. Sondado ao vivo
// (nov/2026): `prompt_tokens` INCLUDES the cached tokens on every family, so the
// discount is applied to that slice only. Anthropic bills reads at 0.1× and
// writes at 1.25×; OpenAI reads at ≤0.1× (we use 0.1, the conservative end).
// Other families report cache fields inconsistently → no discount (full price).
function cacheRates(model) {
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
export function normalizeUsage(u) {
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
export function costOf(n, price, model) {
  if (!n || !price) return null
  const r = cacheRates(model)
  const fresh = Math.max(0, n.prompt - n.cacheRead - n.cacheWrite)
  const input = fresh + n.cacheRead * r.read + n.cacheWrite * r.write
  return (input * price.in + n.output * price.out) / 1e6
}

export function priceUsage(model, usage) {
  const n = normalizeUsage(usage)
  const costUsd = costOf(n, resolvePrice(model, priceOverrides), model)
  return { n, costUsd, promptTokens: n?.prompt ?? null, completionTokens: n?.output ?? null }
}

// ---- month window ------------------------------------------------------------
// Offset (ms) of `tz` from UTC at instant `date`.
function tzOffsetMs(tz, date) {
  const parts = Object.fromEntries(
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
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}
// UTC instant of local midnight on day 1 of month (y, m0) in `tz` — offset
// re-read at the candidate so a DST change near the boundary lands right.
function zonedMonthStart(tz, y, m0) {
  const guess = Date.UTC(y, m0, 1)
  let start = guess - tzOffsetMs(tz, new Date(guess))
  start = guess - tzOffsetMs(tz, new Date(start))
  return new Date(start)
}
// The billing month containing `now`, in time zone `tz`: { start, end } (end
// exclusive = when the meter resets).
export function monthWindow(tz = 'UTC', now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  )
  const y = +parts.year
  const m0 = +parts.month - 1
  return { start: zonedMonthStart(tz, y, m0), end: zonedMonthStart(tz, m0 === 11 ? y + 1 : y, (m0 + 1) % 12) }
}

// ---- recording ---------------------------------------------------------------
// In-flight inserts per user: the meter refetches right after a turn's `done`,
// while the title/embedding rows of that same turn may still be writing.
// getUsageSummary waits for them (bounded) so the number it shows is complete.
const pending = new Map() // email -> Set<Promise>

function track(email, p) {
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
export function recordUsage(kind, model, usage, { estimated = false } = {}) {
  const s = scope.getStore()
  if (!s?.email) return null // background work outside any request: nothing to attribute
  const { n, costUsd } = priceUsage(model, usage)
  if (!n) return null
  const row = {
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
  if (s.held && !s.sessionId) s.held.push(row)
  else writeRow(s, row)
  return costUsd
}

function writeRow(s, row) {
  const p = insertUsageLedger(s.email, s.token, row).catch((e) => console.warn('usage ledger insert failed:', e.message))
  track(s.email, p)
}

// ---- summary -------------------------------------------------------------------
export async function getUsageSummary(email, token, { sessionId = null, tz = 'UTC' } = {}) {
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

// One-time copy of pre-ledger history (see db.backfillUsageLedger). Best-effort.
let backfillStarted = false
export function startUsageBackfill(email, token) {
  if (backfillStarted) return
  backfillStarted = true
  const cost = (model, usage) => priceUsage(model, usage)
  backfillUsageLedger(email, token, cost)
    .then((n) => n && console.log(`usage ledger: ${n} linhas reconstruídas do histórico`))
    .catch((e) => {
      backfillStarted = false // retry on a later request
      console.warn('usage ledger backfill failed:', e.message)
    })
}
