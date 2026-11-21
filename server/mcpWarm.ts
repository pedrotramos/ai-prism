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
const WARM_CONCURRENCY = 4 // connections warmed at once: bounds the burst, never the count
const lastWarm = new Map<string, number>() // user email -> ts

export function resetMcpWarm() {
  lastWarm.clear()
}

interface Conn {
  connectionName?: string
  status?: string
}
interface WarmDeps {
  listUserMcpConnections?: (email: string, token: string) => Promise<Conn[]>
  getHiddenMcpNames?: (email: string, token: string) => Set<string> | Promise<Set<string>>
  admitMcpConnection?: (token: string, email: string, name: string) => { ok?: boolean } | null | undefined | Promise<{ ok?: boolean } | null | undefined>
  listMcpServerCached?: (url: string, token: string, email: string) => unknown
}

/**
 * Warms admission + the tool listing of `email`'s adopted connections.
 * Resolves when done (tests await it); callers on a request path do not.
 * Skips: saved as forbidden, hidden by an admin, refused by the admission
 * (a shared-credential service is never contacted from here).
 */
export async function warmUserMcpConnections(token: string, email: string, deps: WarmDeps = {}): Promise<void> {
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
    const [adopted, hidden]: [Conn[], Set<string>] = await Promise.all([
      listUserMcpConnections(email, token),
      Promise.resolve(hiddenNames(email, token)).catch(() => new Set<string>()),
    ])
    const names = adopted
      .filter((c: Conn) => c?.connectionName && c.status !== 'forbidden' && !hidden.has(c.connectionName))
      .map((c: Conn) => c.connectionName as string)
    // every adopted connection, a few at a time (a prefix cap would leave the tail cold)
    let next = 0
    const worker = async () => {
      while (next < names.length) {
        const name = names[next++] as string // next < names.length
        await Promise.resolve(admit(token, email, name))
          .then((a) => (a?.ok ? listServer(externalMcpUrl(name), token, email) : null))
          .catch(() => {})
      }
    }
    await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, names.length) }, worker))
  } catch {
    // a failed warm-up is not an error: the next read tries again after the window
    lastWarm.delete(key)
  }
}
