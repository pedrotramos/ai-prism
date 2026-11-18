// Chat and image model catalogs, the org tool policy, the caller's spend
// summary, and the admin AI Gateway model catalog.
import {
  listModelOverrides,
  upsertModelOverride,
  reorderModelOverrides,
  seedModelOverridesIfEmpty,
  getSelectedImageModel,
  setSelectedImageModel,
  getToolPolicy,
  setToolPolicy,
} from '../db.js'
import { MODELS, DEFAULT_IMAGE_MODEL } from '../llm.js'
import { getUsageSummary, usageTimeZone } from '../usage.js'
import { SUPPORTED_EXTENSIONS } from '../files.js'
import { transcriptionEnabled, MEDIA_EXTENSIONS } from '../transcribe.js'
import { TOOL_GROUP_KEYS } from '../tools.js'
import { listChatEndpoints, buildAdminCatalog, buildUserImageModels, recommendedModelIds } from '../serving.js'
import { getUserModels, reconcileSeededPrices, invalidateUserModels } from '../models.js'
import { auth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { ensureReady } from '../middleware/ensureReady.js'

export default function registerModelRoutes(app) {
  app.get('/api/models', auth, async (req, res) => {
    const models = await getUserModels(req)
    // Media extensions are only offered when transcription is enabled, so the
    // file picker doesn't invite an upload the workspace can't process. The two
    // lists are kept separate on the wire so the client can label media distinctly.
    const mediaExtensions = transcriptionEnabled() ? MEDIA_EXTENSIONS : []
    res.json({
      models,
      supported_extensions: SUPPORTED_EXTENSIONS,
      media_extensions: mediaExtensions,
    })
  })

  // Image-generation models the user can choose from (Settings → image model),
  // plus their current selection (null → the org default is used). Separate from
  // /api/models: image endpoints never appear in the chat picker and vice-versa.
  app.get('/api/image-models', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const overrides = await listModelOverrides(req.email, req.token).catch(() => ({}))
      const models = buildUserImageModels(overrides)
      const selected = await getSelectedImageModel(req.email, req.token).catch(() => null)
      // Which model "Padrão" actually resolves to, so the UI can name it
      // explicitly instead of an opaque "Default". Matches the tool's fallback
      // (DEFAULT_IMAGE_MODEL) when it's among the enabled models, else the first
      // enabled image model — exactly what a turn with no explicit choice uses.
      const defaultId = models.some((m) => m.id === DEFAULT_IMAGE_MODEL)
        ? DEFAULT_IMAGE_MODEL
        : models[0]?.id || null
      res.json({ models, selected, defaultId })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.put('/api/image-models/selected', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : ''
      if (!modelId) return res.status(400).json({ error: 'modelId obrigatório' })
      await setSelectedImageModel(req.email, req.token, modelId)
      res.json({ ok: true, selected: modelId })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Org tool policy: which built-in tool GROUPS are available. The user-facing
  // read (picker hides disabled groups); a missing key means enabled (default-on).
  app.get('/api/tool-policy', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const policy = await getToolPolicy(req.email, req.token).catch(() => ({}))
      res.json({ policy, keys: TOOL_GROUP_KEYS })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.put('/api/admin/tool-policy/:key', auth, requireAdmin, async (req, res) => {
    try {
      const key = req.params.key
      if (!TOOL_GROUP_KEYS.includes(key)) return res.status(400).json({ error: 'tool inválida' })
      await setToolPolicy(req.email, req.token, key, !!req.body?.enabled, { admin: req.isAdmin === true })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ---- taxímetro: the caller's spend (month + current conversation) ----------
  // Priced at list price at call time (usage_ledger). Always scoped to the
  // caller's email — a sessionId they don't own just sums to zero.
  app.get('/api/usage/summary', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const sessionId = /^\d+$/.test(String(req.query.sessionId || '')) ? String(req.query.sessionId) : null
      const summary = await getUsageSummary(req.email, req.token, { sessionId, tz: usageTimeZone() })
      res.json(summary)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ---- admin: AI Gateway model catalog -----------------------------------
  // list live endpoints ∪ curated ∪ overrides; seeds overrides from the static
  // MODELS the first time so switching /api/models to enabled-only never strands
  // the org with no models.
  app.get('/api/admin/model-endpoints', auth, requireAdmin, async (req, res) => {
    try {
      await seedModelOverridesIfEmpty(req.email, req.token, MODELS, { admin: req.isAdmin === true })
      const [discovered, rawOverrides] = await Promise.all([
        listChatEndpoints(req.token),
        listModelOverrides(req.email, req.token),
      ])
      const overrides = await reconcileSeededPrices(req, rawOverrides)
      // `recommended`: curated defaults this org's catalog doesn't have yet (it
      // was seeded before they existed) — offered as one-click adds in the tab.
      res.json({ endpoints: buildAdminCatalog(discovered, overrides), recommended: recommendedModelIds(overrides) })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.put('/api/admin/model-endpoints/:endpointId', auth, requireAdmin, async (req, res) => {
    try {
      const endpointId = decodeURIComponent(req.params.endpointId)
      const b = req.body || {}
      // prices: accept a non-negative number, else null (→ fall back to the
      // curated/family-inferred default). Guards against NaN/negatives from the UI.
      const price = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null)
      await upsertModelOverride(req.email, req.token, endpointId, {
        enabled: !!b.enabled,
        displayName: typeof b.displayName === 'string' ? b.displayName.slice(0, 120) : '',
        blurb: typeof b.blurb === 'string' ? b.blurb.slice(0, 300) : '',
        sortOrder: Number.isInteger(b.sortOrder) ? b.sortOrder : null,
        priceIn: price(b.priceIn),
        priceOut: price(b.priceOut),
      }, { admin: req.isAdmin === true })
      invalidateUserModels() // force refresh so users see the change quickly
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Reorder the enabled models. Body: { order: [endpointId, ...] } — index 0 is
  // first in the picker AND the default model for new chats (see getUserModels /
  // the client's models[0]). Admin-only, like the other catalog mutations.
  app.put('/api/admin/model-endpoints-order', auth, requireAdmin, async (req, res) => {
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order.filter((x) => typeof x === 'string') : null
      if (!order || !order.length) return res.status(400).json({ error: 'order (array de ids) obrigatório' })
      await reorderModelOverrides(req.email, req.token, order, { admin: req.isAdmin === true })
      invalidateUserModels() // force refresh so the new default/order shows quickly
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
