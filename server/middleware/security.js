// Placeholder for the next security middleware (rate and body limits, more
// headers), mounted by installMiddleware right after the security headers so
// that work only has to fill this body. Today it only passes the request on.
// The headers, CSRF guard and error handler in place today live in
// server/securityHeaders.js and server/csrfGuard.js.
export function security() {
  return function securityMiddleware(req, res, next) {
    next()
  }
}
