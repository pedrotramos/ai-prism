// Identity of the caller (/api/me) and the app-admin list.
import { authed } from './authed.ts'
import type { Express } from 'express'
import { listAppAdmins, addAppAdmin, removeAppAdmin } from '../db.ts'
import {
  isAdmin,
  isOwner,
  ownerEmail,
  groupCheckStatus,
  invalidateAdminsCache,
  appAccessCandidates,
  isAppAccessPrincipal,
} from '../authz.ts'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin } from '../middleware/requireAdmin.ts'
import { ensureReady as realEnsureReady } from '../middleware/ensureReady.ts'
import { currentExternalAssetOrigins } from '../egressSetting.ts'
import type { RequestHandler } from 'express'

/** Injectable for tests; the defaults are the real middleware and sources. */
export interface AdminRouteDeps {
  auth?: RequestHandler
  ensureReady?: typeof realEnsureReady
  isAdmin?: typeof isAdmin
  origins?: () => readonly string[]
}

export default function registerAdminRoutes(app: Express, deps: AdminRouteDeps = {}) {
  const auth = deps.auth || realAuth
  const ensureReady = deps.ensureReady || realEnsureReady
  const adminCheck = deps.isAdmin || isAdmin
  // the effective allowlist of remote asset origins (env floor ∪ admin setting): the client renderer and the CSP agree.
  // Origins are not secret. A broken source is an empty list, which the client treats as "block every external image".
  const origins = (): string[] => {
    try {
      return [...(deps.origins || currentExternalAssetOrigins)()]
    } catch {
      return []
    }
  }
  app.get('/api/me', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      res.json({ email: authed(req).email, isAdmin: await adminCheck(authed(req).email, authed(req).token), isOwner: isOwner(authed(req).email), externalAssetOrigins: origins() })
    } catch (e) {
      // identity must never fail the app shell — degrade to non-admin
      res.json({ email: authed(req).email, isAdmin: isOwner(authed(req).email), isOwner: isOwner(authed(req).email), externalAssetOrigins: origins() })
    }
  })

  app.get('/api/admins', auth, requireAdmin, async (req, res) => {
    try {
      res.json({
        owner: ownerEmail(),
        admins: await listAppAdmins(authed(req).email, authed(req).token),
        groupCheck: groupCheckStatus(),
      })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // autocomplete for the admin form: everyone already granted CAN_USE/CAN_MANAGE
  // on the app (best-effort — empty list just disables suggestions)
  app.get('/api/admins/candidates', auth, requireAdmin, async (req, res) => {
    res.json({ candidates: await appAccessCandidates(authed(req).token) })
  })

  app.post('/api/admins', auth, requireAdmin, async (req, res) => {
    try {
      const principal = String(req.body?.principal || '').trim()
      const kind = req.body?.kind === 'group' ? 'group' : 'user'
      if (!principal || principal.length > 200) return res.status(400).json({ error: 'principal inválido' })
      if (kind === 'user' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(principal))
        return res.status(400).json({ error: 'para kind=user o principal deve ser um e-mail' })
      // Only principals that already have access to the app (CAN_USE/CAN_MANAGE in
      // the Databricks Apps permission layer) can be promoted to admin. If the ACL
      // couldn't be read at all, don't silently reject — say so (503) so the UI
      // can tell "not allowed" apart from "couldn't verify".
      const access = await isAppAccessPrincipal(principal, kind, authed(req).token)
      if (!access.reachable)
        return res.status(503).json({ error: 'não foi possível verificar o acesso ao app; tente novamente' })
      if (!access.ok)
        return res.status(400).json({ error: 'sem_acesso' })
      await addAppAdmin(authed(req).email, authed(req).token, principal, kind, { admin: authed(req).isAdmin === true })
      invalidateAdminsCache()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.delete('/api/admins/:principal', auth, requireAdmin, async (req, res) => {
    try {
      await removeAppAdmin(authed(req).email, authed(req).token, decodeURIComponent((req.params.principal as string)), { admin: authed(req).isAdmin === true })
      invalidateAdminsCache()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
