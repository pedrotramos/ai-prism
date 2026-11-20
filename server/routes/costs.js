// Admin Costs page API: billed cost of this installation from the system
// tables (server/costs.js), run with the admin's own OBO token.
//
//   GET /api/costs/meta                       breakdowns, tag keys, default period (no warehouse call)
//   GET /api/costs?by=resource|model|person|tag[&from=YYYY-MM-DD&to=YYYY-MM-DD][&tag=<key>]
//
// Errors answer {code}: 400 bad_breakdown | bad_period | bad_tag, 403 no_access
// (the admin lacks SELECT on the system tables or CAN USE on the warehouse),
// 503 no_warehouse, 504 timeout, 502 query_failed. Non-admins get 403 from
// requireAdmin before anything runs.
import { auth as realAuth } from '../middleware/auth.js'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.js'
import { BREAKDOWNS, MAX_PERIOD_DAYS, costScope, parsePeriod, queryCosts, classifyCostsError } from '../costs.js'
import { execStatement } from '../warehouse.ts'
import { logger } from '../log.js'

// an upstream error may echo request details; the caller's token never reaches a log line
function scrub(text, token) {
  const s = String(text || '')
  return token && token.length >= 8 ? s.split(token).join('[redacted]') : s
}

export default function registerCostRoutes(app, deps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const exec = deps.exec || execStatement
  const env = deps.env || process.env
  const now = deps.now || (() => new Date())

  app.get('/api/costs/meta', auth, requireAdmin, function costsMetaHandler(req, res) {
    const scope = costScope(env)
    res.set('Cache-Control', 'no-store')
    res.json({ breakdowns: BREAKDOWNS, tagKeys: scope.tagKeys, defaultPeriod: parsePeriod({}, now()), maxDays: MAX_PERIOD_DAYS })
  })

  app.get('/api/costs', auth, requireAdmin, async function costsHandler(req, res) {
    res.set('Cache-Control', 'no-store')
    try {
      const out = await queryCosts({ token: req.token, by: req.query.by, query: req.query, env, exec, now: now() })
      res.json(out)
    } catch (e) {
      const { status, code } = classifyCostsError(e)
      if (status >= 500 || code === 'no_access') {
        logger.warn(`costs: ${code} (by=${String(req.query.by).slice(0, 20)}): ${scrub(e?.message, req.token)}`)
      }
      res.status(status).json({ code })
    }
  })
}
