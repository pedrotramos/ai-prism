// CSRF guard for state-changing /api/* calls (POST, PUT, PATCH, DELETE).
//
// Why: /api/chat accepts multipart/form-data, which a plain HTML <form> on any
// other site can submit without a CORS preflight. If the browser attaches the
// Apps session cookie, that form runs a turn in the victim's account with the
// tools the attacker picked, and the turn lands in the victim's history. The
// SPA always calls the API from its own origin, so anything else is refused.
//
// Allowed:
//   - Sec-Fetch-Site: same-origin | none (every current browser sends it);
//   - else an Origin (or, without Origin, a Referer) whose host is the request's
//     own host (Host / X-Forwarded-Host) or the DATABRICKS_APP_URL host;
//   - requests with none of the three headers: not a browser (curl, scripts,
//     server-to-server, tests), so not a CSRF vector.
// Everything else gets 403 JSON before the body is parsed.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'none'])

function hostOf(url) {
  if (!url) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase()
  } catch {
    return null
  }
}

function headerValue(req, name) {
  const v = req.headers?.[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function csrfGuard({ env = process.env } = {}) {
  return function csrfGuardMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next()
    const fetchSite = headerValue(req, 'sec-fetch-site')?.toLowerCase()
    if (fetchSite && TRUSTED_FETCH_SITES.has(fetchSite)) return next()

    const origin = headerValue(req, 'origin')
    const referer = headerValue(req, 'referer')
    if (!fetchSite && !origin && !referer) return next()

    const source = origin ? hostOf(origin) : referer ? hostOf(referer) : null
    if (source) {
      const own = new Set(
        [headerValue(req, 'host'), headerValue(req, 'x-forwarded-host')?.split(',')[0].trim(), hostOf(env.DATABRICKS_APP_URL)]
          .filter(Boolean)
          .map((h) => h.toLowerCase())
      )
      if (own.has(source)) return next()
    }
    return res.status(403).json({ error: 'Requisição de outro site bloqueada.', code: 'cross_site_request' })
  }
}
