// Whether MCP Apps are on, for code that has no request in hand (the turn's tool assembly). The admin setting is read at most
// every 15 s per process; the env kill-switch MCP_APPS_DISABLED=1 wins and needs no read. A failed read is "off" (fail closed).
import { readMcpAppsSetting } from './db/mcpApps.ts'
import { mcpAppsEnabled } from './mcpApps.ts'

const TTL_MS = 15_000
let cache: { value: boolean; ts: number } | null = null

export function invalidateMcpAppsSetting(): void {
  cache = null
}

export async function mcpAppsOn(email: string, token: string | null, { env = process.env, now = Date.now }: { env?: Record<string, string | undefined>; now?: () => number } = {}): Promise<boolean> {
  if (env.MCP_APPS_DISABLED === '1') return false
  if (cache && now() - cache.ts < TTL_MS) return mcpAppsEnabled(env, { mcpAppsEnabled: cache.value })
  try {
    const value = await readMcpAppsSetting(email, token)
    cache = { value, ts: now() }
    return mcpAppsEnabled(env, { mcpAppsEnabled: value })
  } catch {
    return false
  }
}
