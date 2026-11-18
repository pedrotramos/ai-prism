// Org settings (retention, org instructions) and the admin audit trail (W2-5).
//
//   GET  /api/admin/settings          { retentionDays, orgInstructions, retentionLastSweepAt, limits }
//   PUT  /api/admin/settings          { retentionDays?, orgInstructions? } → the saved settings
//   GET  /api/admin/audit?cursor&limit newest first: { items, nextCursor }
//
// Admin only (requireAdmin sets req.isAdmin, the server-side proof handed to
// the db layer as the admin flag). A settings save writes its admin_audit row
// in the same transaction (server/db/admin.js). Registering these routes also
// installs the org-instructions context provider for the turn routes.
import { auth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import {
  ORG_INSTRUCTIONS_MAX_CHARS,
  RETENTION_DAYS_MAX,
  getAppSettings,
  listAdminAudit,
  updateAppSettings,
  validateSettingsPatch,
} from '../db/admin.js'
import { installOrgInstructions, invalidateOrgInstructions } from '../orgInstructions.js'
import { logger } from '../log.js'

const LIMITS = Object.freeze({ retentionDaysMax: RETENTION_DAYS_MAX, orgInstructionsMaxChars: ORG_INSTRUCTIONS_MAX_CHARS })

function fail(res, e, what) {
  logger.warn(`${what} failed`, { err: e })
  res.status(500).json({ error: 'internal_error' })
}

export default function registerAdminSettingsRoutes(app) {
  installOrgInstructions()

  app.get('/api/admin/settings', auth, requireAdmin, async (req, res) => {
    try {
      res.json({ ...(await getAppSettings(req.email, req.token)), limits: LIMITS })
    } catch (e) {
      fail(res, e, 'admin settings read')
    }
  })

  app.put('/api/admin/settings', auth, requireAdmin, async (req, res) => {
    const { patch, error } = validateSettingsPatch(req.body)
    if (error) return res.status(400).json({ error })
    try {
      const saved = await updateAppSettings(req.email, req.token, patch, { admin: req.isAdmin === true })
      invalidateOrgInstructions()
      res.json({ ...saved, limits: LIMITS })
    } catch (e) {
      fail(res, e, 'admin settings save')
    }
  })

  app.get('/api/admin/audit', auth, requireAdmin, async (req, res) => {
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null
    // listAdminAudit clamps the page size (1..AUDIT_PAGE_MAX, default AUDIT_PAGE_DEFAULT)
    const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined
    try {
      res.json(await listAdminAudit(req.email, req.token, { cursor, limit }, { admin: req.isAdmin === true }))
    } catch (e) {
      if (e?.code === 'BAD_CURSOR') return res.status(400).json({ error: 'invalid cursor' })
      fail(res, e, 'admin audit read')
    }
  })
}
