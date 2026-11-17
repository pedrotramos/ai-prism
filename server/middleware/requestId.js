// Request-id middleware: placeholder, mounted first by installMiddleware so the
// request-id/structured-logging work only has to fill this body. Today it only
// passes the request on.
export function requestId() {
  return function requestIdMiddleware(req, res, next) {
    next()
  }
}
