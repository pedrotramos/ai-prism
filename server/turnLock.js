// Per-session turn lock: at most one turn (/api/chat, /continue, /regenerate)
// runs per chat session at a time. A second one is REFUSED (the routes answer
// 409 turn_in_flight before opening the SSE stream), not queued: a double
// submit or a second tab would otherwise run two turns over the same history,
// interleaving the answers and doubling the ledger rows.
//
// Not server/fifoLimiter.js: that limiter queues callers behind a global
// concurrency cap; this one is keyed per session and never waits.
//
// In-process only. With several app instances behind the proxy, two requests
// for one session can still land on different processes; a shared lock (a row
// in Lakebase) would be needed for that.
//
// A holder with no activity for `staleMs` (default 15 minutes) can be taken
// over, so a turn stuck on a hung tool call can never leave its session busy
// forever. Activity is `release.touch()`, which the turn routes call on every
// SSE event they send: a long deck or tool-heavy turn that keeps streaming is
// never taken over. The release function returned by acquire() (and its touch)
// is bound to its own hold: a late call from a taken-over turn does not free or
// refresh the new holder.

const DEFAULT_STALE_MS = 15 * 60 * 1000

export function createTurnLock({ staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const holds = new Map() // key -> { since: ms, seen: ms of last activity }

  const live = (key) => {
    const h = holds.get(key)
    return h && now() - h.seen < staleMs ? h : null
  }

  return {
    /**
     * Takes the lock for `key`; returns an idempotent release() with a
     * release.touch() heartbeat, or null when busy.
     */
    acquire(key) {
      const k = String(key)
      if (live(k)) return null
      const t = now()
      const hold = { since: t, seen: t }
      holds.set(k, hold)
      const release = () => {
        if (holds.get(k) === hold) holds.delete(k)
      }
      release.touch = () => {
        if (holds.get(k) === hold) hold.seen = now()
      }
      return release
    },
    /** `{ since: ISO timestamp }` while a live turn holds `key`, else null. */
    busy(key) {
      const h = live(String(key))
      return h ? { since: new Date(h.since).toISOString() } : null
    },
  }
}

// the process-wide lock shared by the turn routes and GET /api/sessions/:id
export const turnLock = createTurnLock()
