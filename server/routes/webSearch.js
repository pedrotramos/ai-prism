// Admin web search status (W2-11a; the card is W2-11b). Admin only.
//
//   GET  /api/admin/web-search/status   the resolved chain, one row per backend,
//                                       with the caller's availability state
//   POST /api/admin/web-search/verify   one real search per backend with a fixed
//                                       query, as the admin; counts only; ledgered;
//                                       at most one call per 10 s per admin (429)
//
// Neither ever returns a key value, a query or a result text.
import { auth as realAuth } from '../middleware/auth.js'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.js'
import { webSearchStatus } from '../webSearch/index.js'
import { logger } from '../log.js'

const VERIFY_INTERVAL_MS = 10_000

export default function registerWebSearchRoutes(app, deps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const env = deps.env || process.env
  const status = deps.status || webSearchStatus
  const now = deps.now || (() => Date.now())
  const lastVerify = new Map() // admin email → ms

  app.get('/api/admin/web-search/status', auth, requireAdmin, async function webSearchStatusHandler(req, res) {
    try {
      res.json(await status({ token: req.token, email: req.email, verify: false, env }))
    } catch (e) {
      logger.warn('web search status failed', { err: e })
      res.status(500).json({ error: 'status_failed' })
    }
  })

  app.post('/api/admin/web-search/verify', auth, requireAdmin, async function webSearchVerifyHandler(req, res) {
    const key = String(req.email || '').toLowerCase()
    const t = now()
    const prev = lastVerify.get(key)
    if (prev != null && t - prev < VERIFY_INTERVAL_MS) {
      res.set('Retry-After', String(Math.ceil((VERIFY_INTERVAL_MS - (t - prev)) / 1000)))
      return res.status(429).json({ error: 'verify_rate_limited' })
    }
    lastVerify.set(key, t)
    try {
      res.json(await status({ token: req.token, email: req.email, verify: true, env }))
    } catch (e) {
      logger.warn('web search verify failed', { err: e })
      res.status(500).json({ error: 'verify_failed' })
    }
  })
}
