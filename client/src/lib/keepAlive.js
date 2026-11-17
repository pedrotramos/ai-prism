// Keep the Lakebase endpoint awake while someone is looking at the app.
//
// The database scales to zero after `lakebase_suspend_timeout` without queries,
// and the server's pool drains after PG_POOL_IDLE_TIMEOUT_MS. A tab that is open
// and visible, but idle, would otherwise let the endpoint suspend and make the
// next click pay a cold start. So a visible tab pings GET /api/keepalive every
// few minutes; the server throttles that to one `SELECT 1` per few minutes.
// Hidden tabs don't ping, and coming back to a tab pings if the last ping is
// stale. Returns a stop function.
export const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000

export function startDbKeepAlive({
  intervalMs = KEEPALIVE_INTERVAL_MS,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
  ping = () => fetch('/api/keepalive', { cache: 'no-store', credentials: 'same-origin' }),
  now = () => Date.now(),
} = {}) {
  if (!doc || !win) return () => {}
  let lastPingAt = null
  const maybePing = () => {
    if (doc.visibilityState !== 'visible') return
    const t = now()
    // 10% slack: timer jitter must not skip the tick that lands on the interval
    if (lastPingAt !== null && t - lastPingAt < intervalMs * 0.9) return
    lastPingAt = t
    Promise.resolve()
      .then(ping)
      .catch(() => {
        // best-effort: a failed ping only means the next one comes sooner
        lastPingAt = null
      })
  }
  const timer = win.setInterval(maybePing, intervalMs)
  doc.addEventListener('visibilitychange', maybePing)
  return () => {
    win.clearInterval(timer)
    doc.removeEventListener('visibilitychange', maybePing)
  }
}
