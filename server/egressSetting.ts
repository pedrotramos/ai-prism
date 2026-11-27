// The allowlist the CSP header reads (md-exfil T2): EXTERNAL_ASSET_ORIGINS (the floor, read once) ∪ the admin setting
// (app_settings.external_asset_origins). The header NEVER awaits the database:
//   - current() is synchronous. Before the first successful read it is the env floor alone.
//   - a stale cache (TTL 15 s) starts ONE background refresh (single-flight, through the app pool: RLS lets everyone read the key,
//     so no user identity is needed) and the stale value keeps being served meanwhile.
//   - a failed refresh keeps the last good value (then the floor) and is not retried inside the TTL. It never adds anything.
// Every stored entry is re-validated on read (parseAllowedOrigins), so a hand-edited row cannot widen the policy.
import { withTx } from './db/pool.ts'
import { readExternalAssetOrigins } from './db/egressSettings.ts'
import { parseAllowedOrigins } from '../shared/urlEgressPolicy.js'
import { logger } from './log.ts'

export const EGRESS_SETTING_TTL_MS = 15_000

type Env = Record<string, string | undefined>

export interface EgressSettingDeps {
  read: () => Promise<readonly string[]>
  env?: Env
  now?: () => number
  ttlMs?: number
  log?: (msg: string) => void
}

export const hostsFromEnv = (env: Env) => ({ appHost: env.DATABRICKS_APP_URL, workspaceHost: env.DATABRICKS_HOST })

/** env floor ∪ extra, validated and deduped, floor first. */
export function mergeOrigins(env: Env, extra: readonly string[]): string[] {
  const hosts = hostsFromEnv(env)
  const all = [...parseAllowedOrigins(env.EXTERNAL_ASSET_ORIGINS, hosts).allowed, ...parseAllowedOrigins(extra, hosts).allowed].map((a) => a.origin)
  return [...new Set(all)]
}

export function createEgressSetting({ read, env = process.env, now = Date.now, ttlMs = EGRESS_SETTING_TTL_MS, log = (m) => logger.warn(m) }: EgressSettingDeps) {
  let value: string[] = []
  let attemptedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null
  let gen = 0

  function refresh(): Promise<void> {
    if (inflight) return inflight
    attemptedAt = now()
    const myGen = gen
    let started: Promise<readonly string[]>
    try {
      started = read() // started synchronously; a synchronous throw is a failed read like any other
    } catch (e) {
      started = Promise.reject(e)
    }
    let run: Promise<void> | null = null
    run = (async () => {
      try {
        const stored = await started
        if (myGen === gen) value = parseAllowedOrigins([...stored], hostsFromEnv(env)).allowed.map((a) => a.origin)
      } catch {
        log('external asset origins: refresh failed, keeping the last good value')
      } finally {
        if (run && inflight === run) inflight = null
      }
    })()
    inflight = run
    return run
  }

  return {
    /** Synchronous; starts at most one background refresh when stale (`kick: false` only reads the cache). */
    current({ kick = true }: { kick?: boolean } = {}): string[] {
      if (kick && now() - attemptedAt >= ttlMs) void refresh()
      return mergeOrigins(env, value)
    },
    refresh,
    /** The next current() reads again; a read already in flight is not trusted (it may predate the write). */
    invalidate(): void {
      attemptedAt = Number.NEGATIVE_INFINITY
      gen++
      inflight = null
    },
  }
}

/** One startup warning naming the env entries that were dropped (never a value that was accepted). */
export function warnRejectedEnvOrigins(env: Env = process.env, log: (m: string) => void = (m) => logger.warn(m)): string[] {
  const { rejected } = parseAllowedOrigins(env.EXTERNAL_ASSET_ORIGINS, hostsFromEnv(env))
  if (rejected.length) log(`EXTERNAL_ASSET_ORIGINS: ${rejected.length} invalid entr${rejected.length === 1 ? 'y' : 'ies'} dropped: ${rejected.join(' ')}`)
  return rejected
}

const shared = createEgressSetting({ read: () => withTx(null, null, (c) => readExternalAssetOrigins(c)) })

export const currentExternalAssetOrigins = (opts?: { kick?: boolean }): string[] => shared.current(opts)
export const refreshExternalAssetOrigins = (): Promise<void> => shared.refresh()
export const invalidateExternalAssetOrigins = (): void => shared.invalidate()
