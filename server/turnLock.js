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
// A holder older than `staleMs` (default 15 minutes) can be taken over, so a
// turn stuck on a hung tool call can never leave its session busy forever. The
// release function returned by acquire() is bound to its own hold: a late
// release from a taken-over turn does not free the new holder.

const DEFAULT_STALE_MS = 15 * 60 * 1000

export function createTurnLock({ staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const holds = new Map() // key -> { since: ms }

  const live = (key) => {
    const h = holds.get(key)
    return h && now() - h.since < staleMs ? h : null
  }

  return {
    /** Takes the lock for `key`; returns an idempotent release(), or null when busy. */
    acquire(key) {
      const k = String(key)
      if (live(k)) return null
      const hold = { since: now() }
      holds.set(k, hold)
      return () => {
        if (holds.get(k) === hold) holds.delete(k)
      }
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
