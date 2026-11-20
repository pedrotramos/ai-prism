import { upsertMcpCatalogEntry, deleteMcpCatalogEntry } from '../db.js'
import {
  inspectMcpService,
  normalizeServiceName,
  isCuratedMcpService,
  getMcpCatalog,
  invalidateMcpCatalog,
  listMcpServicesViaSp,
} from '../externalMcp.ts'
import { auth } from '../middleware/auth.ts'
import { requireAdmin } from '../middleware/requireAdmin.ts'
import { ensureReady } from '../middleware/ensureReady.ts'

export default function registerMcpCatalogRoutes(app) {
  // ---- admin: MCP catalog ----------------------------------------------------
  // The org's connectable MCP Services = curated system.ai.* ∪ what an admin
  // published (any MCP Service created in the AI Gateway), minus what an admin
  // hid. Users see the visible set in their MCP tab and connect OBO as before.
  const MCP_NAME_MAX = 120
  const MCP_DESC_MAX = 300

  app.get('/api/admin/mcp-catalog', auth, requireAdmin, async (req, res) => {
    try {
      await ensureReady(req)
      const [entries, spList] = await Promise.all([
        getMcpCatalog(req.email, req.token, { includeHidden: true }),
        listMcpServicesViaSp(),
      ])
      const inCatalog = new Set(entries.map((e) => e.connectionName))
      const suggestions = spList.filter((s) => !inCatalog.has(s.connectionName))
      res.json({ entries, suggestions })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Preview a service before publishing: normalize what the admin pasted and
  // list its tools OBO with the admin's own token. Persists nothing.
  app.post('/api/admin/mcp-catalog/inspect', auth, requireAdmin, async (req, res) => {
    try {
      const serviceName = normalizeServiceName(req.body?.input)
      if (!serviceName) return res.status(400).json({ error: 'invalid_service_name' })
      const [result, spList] = await Promise.all([
        inspectMcpService(req.token, serviceName, { cacheKey: req.email }),
        listMcpServicesViaSp().catch(() => []),
      ])
      const comment = spList.find((s) => s.connectionName === serviceName)?.comment || ''
      res.json({ serviceName, comment, curated: isCuratedMcpService(serviceName), ...result })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Publish / edit / hide an entry. A NEW custom service is re-probed: a service
  // the admin can't reach at all ('unavailable', or 'forbidden' = no EXECUTE /
  // nonexistent) is refused; 'needs_login' is fine (OAuth-backed services need per-user consent on first use).
  app.put('/api/admin/mcp-catalog/:name', auth, requireAdmin, async (req, res) => {
    try {
      await ensureReady(req)
      const serviceName = normalizeServiceName(decodeURIComponent(req.params.name))
      if (!serviceName) return res.status(400).json({ error: 'invalid_service_name' })
      const b = req.body || {}
      const existing = await getMcpCatalog(req.email, req.token, { includeHidden: true })
      const isNew = !existing.some((e) => e.connectionName === serviceName)
      let credentialClass = null
      if (isNew) {
        const probe = await inspectMcpService(req.token, serviceName, { cacheKey: req.email })
        if (probe.status === 'unavailable' || probe.status === 'forbidden') {
          return res.status(400).json({ error: probe.error || 'unavailable', status: probe.status })
        }
        // a service that authenticates with ONE shared credential would let every
        // user act as that identity: refuse it (see server/mcpCredentials.js)
        if (probe.admission?.code === 'shared_credential') {
          return res.status(400).json({ error: 'shared_credential', status: probe.status })
        }
        credentialClass = probe.credentialClass && probe.credentialClass !== 'unverified' ? probe.credentialClass : null
      }
      await upsertMcpCatalogEntry(req.email, req.token, serviceName, {
        displayName: typeof b.displayName === 'string' ? b.displayName.trim().slice(0, MCP_NAME_MAX) : '',
        description: typeof b.description === 'string' ? b.description.trim().slice(0, MCP_DESC_MAX) : '',
        hidden: !!b.hidden,
        credentialClass,
      }, { admin: req.isAdmin === true })
      invalidateMcpCatalog()
      res.json({ ok: true, serviceName })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Unpublish a custom service, or reset a curated one to its defaults (the
  // override row goes away → visible again with its original name/description).
  app.delete('/api/admin/mcp-catalog/:name', auth, requireAdmin, async (req, res) => {
    try {
      await ensureReady(req)
      const serviceName = normalizeServiceName(decodeURIComponent(req.params.name))
      if (!serviceName) return res.status(400).json({ error: 'invalid_service_name' })
      await deleteMcpCatalogEntry(req.email, req.token, serviceName, { admin: req.isAdmin === true })
      invalidateMcpCatalog()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
