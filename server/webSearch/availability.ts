// Per-user availability of the web search candidates (design §Resolution 2).
// Process memory only. MCP candidates are keyed per (user, service) because the
// call is on-behalf-of the user and grants differ per user; keyed candidates
// are deployment-wide (the key is). The turn READS this state and never waits
// for a probe; probes run in the background and update it.
import { webSearchDeps } from './deps.ts'

const MIN = 60_000
const NEGATIVE_TTL_MS: Record<string, number> = { forbidden: 10 * MIN, unconfigured: 10 * MIN }
const DEFAULT_NEGATIVE_TTL_MS = MIN // unavailable / timeout / quota / bad_response
const MAX_RETRY_AFTER_MS = 10 * MIN
const POSITIVE_FRESH_MS = 10 * MIN // matches the listing cache (mcpClient.js)
const MAX_ENTRIES = 10_000
const RING_WINDOW_MS = 24 * 60 * MIN
const RING_MAX = 10_000

/** A chain entry of the plan (see index.ts). */
export interface Candidate {
  kind: string
  implicit?: boolean
  service?: string
  tool?: string
  egressHost?: string
}
type State = 'up' | 'down' | 'unknown'
interface Entry {
  state: State
  code: string | null
  ts: number
  until: number
  tool: string | null
  provider: string | null
  lastMs: number | null
  resultCount: number | null
}
interface Outcome {
  ts: number
  kind: string
  ok: boolean
  code: string | null
}

const states = new Map<string, Entry>() // key → state entry
const probes = new Map<string, Promise<unknown>>() // key → Promise
let ring: Outcome[] = [] // outcomes of the last 24 h

const now = (): number => webSearchDeps.now()

export const isMcpKind = (kind: string): boolean => kind === 'managed-mcp' || kind === 'external-mcp'

export function candidateKey(email: unknown, cand: Candidate): string {
  return isMcpKind(cand.kind) ? `${String(email || '').toLowerCase()}\n${cand.kind}:${cand.service}` : `*\n${cand.kind}`
}

/** → { state: 'up'|'down'|'unknown', code?, until?, expired, tool?, provider?, lastMs?, resultCount? } */
export function candidateState(email: unknown, cand: Candidate): Partial<Entry> & { state: State; expired: boolean } {
  const e = states.get(candidateKey(email, cand))
  if (!e) return { state: 'unknown', expired: true }
  return { ...e, expired: now() >= e.until }
}

/**
 * Sets a candidate's state. `down` keeps `code` for its TTL (`retryAfterMs`,
 * capped at 10 min, overrides it for transient codes); `up` is fresh 10 min.
 */
export function markCandidate(
  email: unknown,
  cand: Candidate,
  state: 'up' | 'down',
  { code = null, retryAfterMs = null, tool, provider, lastMs, resultCount }: { code?: string | null; retryAfterMs?: number | null; tool?: string | null; provider?: string | null; lastMs?: number | null; resultCount?: number | null } = {}
): void {
  const key = candidateKey(email, cand)
  const t = now()
  let ttl: number
  if (state === 'up') ttl = POSITIVE_FRESH_MS
  else if (NEGATIVE_TTL_MS[code as string]) ttl = NEGATIVE_TTL_MS[code as string] as number // typed cast: a null code is never a key
  else ttl = retryAfterMs != null && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : DEFAULT_NEGATIVE_TTL_MS
  const prev: Partial<Entry> = states.get(key) || {}
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
  while (states.size > MAX_ENTRIES) states.delete(states.keys().next().value as string) // size > MAX_ENTRIES, so a key exists
}

/** Starts `run()` for `key` unless one is already running; returns the promise. */
export function probeOnce(email: unknown, cand: Candidate, run: () => unknown): Promise<unknown> {
  const key = candidateKey(email, cand)
  if (probes.has(key)) return probes.get(key) as Promise<unknown>
  // run synchronously up to its first await (the listing call starts now)
  let started: unknown
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

export function isProbing(email: unknown, cand: Candidate): boolean {
  return probes.has(candidateKey(email, cand))
}

/** Admin Verify of one entry: forget that candidate's state (the caller's for MCP, deployment-wide for keyed). */
export function clearCandidate(email: unknown, cand: Candidate): void {
  states.delete(candidateKey(email, cand))
}

export function recordOutcome(kind: string, { ok, code = null }: { ok: boolean; code?: string | null }): void {
  const t = now()
  ring.push({ ts: t, kind, ok, code })
  if (ring.length > RING_MAX) ring = ring.slice(-RING_MAX)
}

/** Counts of the last 24 h (this process): { calls, errors, byCode }. */
export function outcomesLast24h(): { calls: number; errors: number; byCode: Record<string, number> } {
  const since = now() - RING_WINDOW_MS
  ring = ring.filter((o) => o.ts >= since)
  const byCode: Record<string, number> = {}
  let errors = 0
  for (const o of ring) {
    if (o.ok) continue
    errors++
    byCode[o.code || 'unavailable'] = (byCode[o.code || 'unavailable'] || 0) + 1
  }
  return { calls: ring.length, errors, byCode }
}

export function resetAvailability(): void {
  states.clear()
  probes.clear()
  ring = []
}
