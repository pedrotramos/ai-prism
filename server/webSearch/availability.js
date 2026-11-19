// Per-user availability of the web search candidates (design §Resolution 2).
// Process memory only. MCP candidates are keyed per (user, service) because the
// call is on-behalf-of the user and grants differ per user; keyed candidates
// are deployment-wide (the key is). The turn READS this state and never waits
// for a probe; probes run in the background and update it.
import { webSearchDeps } from './deps.js'

const MIN = 60_000
const NEGATIVE_TTL_MS = { forbidden: 10 * MIN, unconfigured: 10 * MIN }
const DEFAULT_NEGATIVE_TTL_MS = MIN // unavailable / timeout / quota / bad_response
const MAX_RETRY_AFTER_MS = 10 * MIN
const POSITIVE_FRESH_MS = 10 * MIN // matches the listing cache (mcpClient.js)
const MAX_ENTRIES = 10_000
const RING_WINDOW_MS = 24 * 60 * MIN
const RING_MAX = 10_000

const states = new Map() // key → { state, code, ts, until, tool, provider, lastMs, resultCount }
const probes = new Map() // key → Promise
let ring = [] // { ts, kind, ok, code }

const now = () => webSearchDeps.now()

export const isMcpKind = (kind) => kind === 'managed-mcp' || kind === 'external-mcp'

export function candidateKey(email, cand) {
  return isMcpKind(cand.kind) ? `${String(email || '').toLowerCase()}\n${cand.kind}:${cand.service}` : `*\n${cand.kind}`
}

/** → { state: 'up'|'down'|'unknown', code?, until?, expired, tool?, provider?, lastMs?, resultCount? } */
export function candidateState(email, cand) {
  const e = states.get(candidateKey(email, cand))
  if (!e) return { state: 'unknown', expired: true }
  return { ...e, expired: now() >= e.until }
}

/**
 * Sets a candidate's state. `down` keeps `code` for its TTL (`retryAfterMs`,
 * capped at 10 min, overrides it for transient codes); `up` is fresh 10 min.
 */
export function markCandidate(email, cand, state, { code = null, retryAfterMs = null, tool, provider, lastMs, resultCount } = {}) {
  const key = candidateKey(email, cand)
  const t = now()
  let ttl
  if (state === 'up') ttl = POSITIVE_FRESH_MS
  else if (NEGATIVE_TTL_MS[code]) ttl = NEGATIVE_TTL_MS[code]
  else ttl = retryAfterMs != null && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : DEFAULT_NEGATIVE_TTL_MS
  const prev = states.get(key) || {}
  states.delete(key) // re-insert: Map order = recency, oldest evicted first
  states.set(key, {
    state,
    code: state === 'up' ? null : code,
    ts: t,
    until: t + ttl,
    tool: tool ?? prev.tool ?? null,
    provider: provider ?? prev.provider ?? null,
    lastMs: lastMs ?? prev.lastMs ?? null,
    resultCount: resultCount ?? (state === 'up' ? prev.resultCount ?? null : null),
  })
  while (states.size > MAX_ENTRIES) states.delete(states.keys().next().value)
}

/** Starts `run()` for `key` unless one is already running; returns the promise. */
export function probeOnce(email, cand, run) {
  const key = candidateKey(email, cand)
  if (probes.has(key)) return probes.get(key)
  // run synchronously up to its first await (the listing call starts now)
  let started
  try {
    started = run()
  } catch (e) {
    started = Promise.reject(e)
  }
  const tracked = Promise.resolve(started)
    .catch(() => {})
    .finally(() => probes.delete(key))
  probes.set(key, tracked)
  return tracked
}

export function isProbing(email, cand) {
  return probes.has(candidateKey(email, cand))
}

/** Admin Verify: forget the caller's MCP states (and the deployment-wide keyed ones). */
export function clearCandidates(email) {
  const prefix = `${String(email || '').toLowerCase()}\n`
  for (const key of [...states.keys()]) if (key.startsWith(prefix) || key.startsWith('*\n')) states.delete(key)
}

export function recordOutcome(kind, { ok, code = null }) {
  const t = now()
  ring.push({ ts: t, kind, ok, code })
  if (ring.length > RING_MAX) ring = ring.slice(-RING_MAX)
}

/** Counts of the last 24 h (this process): { calls, errors, byCode }. */
export function outcomesLast24h() {
  const since = now() - RING_WINDOW_MS
  ring = ring.filter((o) => o.ts >= since)
  const byCode = {}
  let errors = 0
  for (const o of ring) {
    if (o.ok) continue
    errors++
    byCode[o.code || 'unavailable'] = (byCode[o.code || 'unavailable'] || 0) + 1
  }
  return { calls: ring.length, errors, byCode }
}

export function resetAvailability() {
  states.clear()
  probes.clear()
  ring = []
}
