import type { Request, Response, NextFunction } from 'express'
import { isAdmin } from '../authz.ts'
import { ensureReady } from './ensureReady.ts'

// admin gate for management routes: 403 for signed-in non-admins.
// req.isAdmin = true is the server-side proof the routes behind this gate hand
// to db.js as { admin: true } (app.is_admin = 'on' for row-level security). It
// is set here, after authz.isAdmin, and never read from the request.
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<unknown> {
  // email/token were set by auth() (carried on the request object)
  const r = req as Request & { email: string; token: string; isAdmin?: boolean }
  try {
    r.isAdmin = false
    await ensureReady(r)
    if (await isAdmin(r.email, r.token)) {
      r.isAdmin = true
      return next()
    }
    res.status(403).json({ error: 'apenas administradores' })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}
