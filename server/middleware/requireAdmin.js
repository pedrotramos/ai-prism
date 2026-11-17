import { isAdmin } from '../authz.js'
import { ensureReady } from './ensureReady.js'

// admin gate for management routes: 403 for signed-in non-admins
export async function requireAdmin(req, res, next) {
  try {
    await ensureReady(req)
    if (await isAdmin(req.email, req.token)) return next()
    res.status(403).json({ error: 'apenas administradores' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
