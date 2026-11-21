// Admin web search status (W2-11a; the card is W2-11b). Admin only.
//
//   GET  /api/admin/web-search/status   the resolved chain, one row per backend,
//                                       with the caller's availability state
//   POST /api/admin/web-search/verify   body { entry, kind }: ONE real search against
//                                       that chain entry with a fixed query, as the
//                                       admin; counts only; ledgered; at most one
//                                       call per 10 s per admin and entry (429);
//                                       a bad or stale entry is a 400 with no call
//
// Neither ever returns a key value, a query or a result text.
import { authed } from './authed.ts'
import type { Express, RequestHandler } from 'express'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.ts'
import { webSearchStatus } from '../webSearch/index.ts'
import { logger } from '../log.ts'

interface WebSearchDeps {
  auth?: RequestHandler
  requireAdmin?: RequestHandler
  env?: Record<string, string | undefined>
  status?: typeof webSearchStatus
  now?: () => number
}

const VERIFY_INTERVAL_MS = 10_000

export default function registerWebSearchRoutes(app: Express, deps: WebSearchDeps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const env = deps.env || process.env
  const status = deps.status || webSearchStatus
  const now = deps.now || (() => Date.now())
  const lastVerify = new Map() // admin email → ms

  app.get('/api/admin/web-search/status', auth, requireAdmin, async function webSearchStatusHandler(req, res) {
    try {
      res.json(await status({ token: authed(req).token, email: authed(req).email, verify: false, env }))
    } catch (e) {
      logger.warn('web search status failed', { err: e })
      res.status(500).json({ error: 'status_failed' })
    }
  })

  app.post('/api/admin/web-search/verify', auth, requireAdmin, async function webSearchVerifyHandler(req, res) {
    const entry = req.body?.entry
    const kind = req.body?.kind
    if (!Number.isInteger(entry) || entry < 0 || typeof kind !== 'string' || !kind) return res.status(400).json({ error: 'invalid_entry' })
    const key = `${String(authed(req).email || '').toLowerCase()}\n${entry}:${kind}`
    const t = now()
    const prev = lastVerify.get(key)
    if (prev != null && t - prev < VERIFY_INTERVAL_MS) {
      res.set('Retry-After', String(Math.ceil((VERIFY_INTERVAL_MS - (t - prev)) / 1000)))
      return res.status(429).json({ error: 'verify_rate_limited' })
    }
    lastVerify.set(key, t)
    try {
      res.json(await status({ token: authed(req).token, email: authed(req).email, verify: { entry, kind }, env }))
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'invalid_entry') {
        // a stale or unknown entry made no provider call: it does not open a window
        if (prev == null) lastVerify.delete(key)
        else lastVerify.set(key, prev)
        return res.status(400).json({ error: 'invalid_entry' })
      }
      logger.warn('web search verify failed', { err: e })
      res.status(500).json({ error: 'verify_failed' })
    }
  })
}
