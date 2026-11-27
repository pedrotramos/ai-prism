// logEgress: one structured warning per blocked or stripped external reference (host only, never a path or a query).
//
//   {"event":"egress_blocked","surface":"answer","kind":"image","hosts":["evil.com"],"count":1,"route":"POST /api/..."}
//
// It goes through the structured logger, so request_id and user_hash come from the request context (log.ts). A token
// bucket per user (EGRESS_LOG_PER_MIN, default 60, 0 = unlimited, like CSP_REPORT_PER_MIN) keeps a looping page or a
// hostile deck from flooding the logs. It never throws into the caller.
import { logger, currentRequestContext, userHash } from './log.ts'
import { tokenBucket, limitFromEnv } from './middleware/rateLimit.ts'

export type EgressEvent = {
  surface: 'answer' | 'deck' | 'document' | 'web_fetch'
  kind: 'image' | 'link' | 'css' | 'handler' | 'url'
  hosts: string[]
  route?: string
}

const SURFACES = new Set(['answer', 'deck', 'document', 'web_fetch'])
const KINDS = new Set(['image', 'link', 'css', 'handler', 'url'])
const MAX_HOSTS = 10
const MAX_HOST_LEN = 100
const MAX_ROUTE_LEN = 120
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

/** `Evil.com/p?d=S`, `https://u:pw@x.com:8443/a#f` -> `evil.com`, `x.com`; null when nothing host-like is left. */
function hostOnly(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let h = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  h = h.split(/[/?#\\]/)[0] as string
  h = h.slice(h.lastIndexOf('@') + 1) // userinfo
  h = h.replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase()
  return h.length > 0 && h.length <= MAX_HOST_LEN && HOST.test(h) ? h : null
}

export function makeEgressLogger({ env = process.env, now = Date.now }: { env?: NodeJS.ProcessEnv; now?: () => number } = {}): (e: EgressEvent) => void {
  const cap = tokenBucket({ perMinute: limitFromEnv(env.EGRESS_LOG_PER_MIN, 60), now })
  return function logEgress(e: EgressEvent): void {
    try {
      const seen = new Set<string>()
      for (const h of Array.isArray(e?.hosts) ? e.hosts : []) {
        const host = hostOnly(h)
        if (host) seen.add(host)
      }
      if (!seen.size) return
      const email = currentRequestContext()?.req?.email
      if (!cap.take(`user:${userHash(email) ?? 'anon'}`).ok) return
      const route = typeof e.route === 'string' ? (e.route.split('?')[0] as string).slice(0, MAX_ROUTE_LEN) : null
      logger.warn(
        JSON.stringify({
          event: 'egress_blocked',
          surface: SURFACES.has(e.surface) ? e.surface : 'unknown',
          kind: KINDS.has(e.kind) ? e.kind : 'unknown',
          hosts: [...seen].slice(0, MAX_HOSTS),
          count: seen.size,
          route: route || null,
        }),
      )
    } catch {
      // never into the caller
    }
  }
}

export const logEgress = makeEgressLogger()
