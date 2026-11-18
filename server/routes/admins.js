// Identity of the caller (/api/me) and the app-admin list.
import { listAppAdmins, addAppAdmin, removeAppAdmin } from '../db.js'
import {
  isAdmin,
  isOwner,
  ownerEmail,
  groupCheckStatus,
  invalidateAdminsCache,
  appAccessCandidates,
  isAppAccessPrincipal,
} from '../authz.js'
import { auth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { ensureReady } from '../middleware/ensureReady.js'

export default function registerAdminRoutes(app) {
  app.get('/api/me', auth, async (req, res) => {
    try {
      await ensureReady(req)
      res.json({ email: req.email, isAdmin: await isAdmin(req.email, req.token), isOwner: isOwner(req.email) })
    } catch (e) {
      // identity must never fail the app shell — degrade to non-admin
      res.json({ email: req.email, isAdmin: isOwner(req.email), isOwner: isOwner(req.email) })
    }
  })

  app.get('/api/admins', auth, requireAdmin, async (req, res) => {
    try {
      res.json({
        owner: ownerEmail(),
        admins: await listAppAdmins(req.email, req.token),
        groupCheck: groupCheckStatus(),
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // autocomplete for the admin form: everyone already granted CAN_USE/CAN_MANAGE
  // on the app (best-effort — empty list just disables suggestions)
  app.get('/api/admins/candidates', auth, requireAdmin, async (req, res) => {
    res.json({ candidates: await appAccessCandidates(req.token) })
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
      const access = await isAppAccessPrincipal(principal, kind, req.token)
      if (!access.reachable)
        return res.status(503).json({ error: 'não foi possível verificar o acesso ao app; tente novamente' })
      if (!access.ok)
        return res.status(400).json({ error: 'sem_acesso' })
      await addAppAdmin(req.email, req.token, principal, kind, { admin: req.isAdmin === true })
      invalidateAdminsCache()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.delete('/api/admins/:principal', auth, requireAdmin, async (req, res) => {
    try {
      await removeAppAdmin(req.email, req.token, decodeURIComponent(req.params.principal), { admin: req.isAdmin === true })
      invalidateAdminsCache()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
