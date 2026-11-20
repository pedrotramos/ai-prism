// Background warm-up of a user's adopted MCP connections (N7 item 1).
//
// A turn reads two caches and never waits on a classification or a slow gateway
// listing (TTFT): the credential admission (externalMcp.ts) and the tool
// listing (mcpClient.ts). Both are cold after a restart or ~10 idle minutes, so
// a by-name connection had no tools on the first turn. The client reads
// /api/tool-policy as it loads; that read starts this warm-up. It is never
// awaited by the request, swallows every error (a failed warm-up only leaves
// the caches as they were) and runs at most once per user per WARM_WINDOW_MS.
import * as db from './db.js'
import { admitMcpConnection, externalMcpUrl, getHiddenMcpNames } from './externalMcp.ts'
import { listMcpServerCached } from './mcpClient.ts'

const WARM_WINDOW_MS = 30_000
const MAX_WARM = 8 // adopted connections warmed per read: a bound, not a policy
const lastWarm = new Map() // user email -> ts

export function resetMcpWarm() {
  lastWarm.clear()
}

/**
 * Warms admission + the tool listing of `email`'s adopted connections.
 * Resolves when done (tests await it); callers on a request path do not.
 * Skips: saved as forbidden, hidden by an admin, refused by the admission
 * (a shared-credential service is never contacted from here).
 */
export async function warmUserMcpConnections(token, email, deps = {}) {
  const {
    listUserMcpConnections = db.listUserMcpConnections,
    getHiddenMcpNames: hiddenNames = getHiddenMcpNames,
    admitMcpConnection: admit = admitMcpConnection,
    listMcpServerCached: listServer = listMcpServerCached,
  } = deps
  if (!token || !email) return
  const key = String(email).toLowerCase()
  const last = lastWarm.get(key)
  if (last != null && Date.now() - last < WARM_WINDOW_MS) return
  lastWarm.set(key, Date.now())
  try {
    const [adopted, hidden] = await Promise.all([
      listUserMcpConnections(email, token),
      Promise.resolve(hiddenNames(email, token)).catch(() => new Set()),
    ])
    const names = adopted
      .filter((c) => c?.connectionName && c.status !== 'forbidden' && !hidden.has(c.connectionName))
      .slice(0, MAX_WARM)
      .map((c) => c.connectionName)
    await Promise.all(
      names.map((name) =>
        Promise.resolve(admit(token, email, name))
          .then((a) => (a?.ok ? listServer(externalMcpUrl(name), token, email) : null))
          .catch(() => {})
      )
    )
  } catch {
    // a failed warm-up is not an error: the next read tries again after the window
    lastWarm.delete(key)
  }
}
