import { isAdmin } from '../authz.js'
import { ensureReady } from './ensureReady.js'

// admin gate for management routes: 403 for signed-in non-admins.
// req.isAdmin = true is the server-side proof the routes behind this gate hand
// to db.js as { admin: true } (app.is_admin = 'on' for row-level security). It
// is set here, after authz.isAdmin, and never read from the request.
export async function requireAdmin(req, res, next) {
  try {
    req.isAdmin = false
    await ensureReady(req)
    if (await isAdmin(req.email, req.token)) {
      req.isAdmin = true
      return next()
    }
    res.status(403).json({ error: 'apenas administradores' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
