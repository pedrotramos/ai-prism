// Chat and image model catalogs, the org tool policy, the caller's spend
// summary, and the admin AI Gateway model catalog.
import { authed } from './authed.ts'
import type { Express, RequestHandler } from 'express'
import {
  listModelOverrides,
  upsertModelOverride,
  reorderModelOverrides,
  seedModelOverridesIfEmpty,
  getSelectedImageModel,
  setSelectedImageModel,
  getToolPolicy as db_getToolPolicy,
  setToolPolicy,
} from '../db.ts'
import { MODELS, DEFAULT_IMAGE_MODEL } from '../llm.ts'
import { getUsageSummary, usageTimeZone } from '../usage.ts'
import { SUPPORTED_EXTENSIONS } from '../files.ts'
import { transcriptionEnabled, MEDIA_EXTENSIONS } from '../transcribe.ts'
import { TOOL_GROUP_KEYS } from '../tools.ts'
import { warmWebSearch as realWarmWebSearch } from '../webSearch/index.ts'
import { warmUserMcpConnections as realWarmMcp } from '../mcpWarm.ts'
import { listChatEndpoints, buildAdminCatalog, buildUserImageModels, recommendedModelIds } from '../serving.ts'
import { getUserModels, reconcileSeededPrices, invalidateUserModels } from '../models.ts'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin } from '../middleware/requireAdmin.ts'
import { ensureReady as realEnsureReady } from '../middleware/ensureReady.ts'

interface ModelRouteDeps {
  auth?: RequestHandler
  ensureReady?: typeof realEnsureReady
  getToolPolicy?: typeof db_getToolPolicy
  warmWebSearch?: typeof realWarmWebSearch
  warmUserMcpConnections?: typeof realWarmMcp
}

// `deps` overrides collaborators in tests; production passes nothing.
export default function registerModelRoutes(app: Express, deps: ModelRouteDeps = {}) {
  const {
    auth = realAuth,
    ensureReady = realEnsureReady,
    getToolPolicy = db_getToolPolicy,
    warmWebSearch = realWarmWebSearch,
    warmUserMcpConnections = realWarmMcp,
  } = deps
  app.get('/api/models', auth, async (req, res) => {
    const models = await getUserModels(authed(req))
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
      await ensureReady(authed(req))
      // fail closed: if the catalog cannot be read, no image model is offered (not the curated defaults)
      const overrides = await listModelOverrides(authed(req).email, authed(req).token).catch(() => null)
      const models = overrides ? buildUserImageModels(overrides) : []
      const selected = await getSelectedImageModel(authed(req).email, authed(req).token).catch(() => null)
      // Which model "Padrão" actually resolves to, so the UI can name it
      // explicitly instead of an opaque "Default". Matches the tool's fallback
      // (DEFAULT_IMAGE_MODEL) when it's among the enabled models, else the first
      // enabled image model — exactly what a turn with no explicit choice uses.
      const defaultId = models.some((m) => m.id === DEFAULT_IMAGE_MODEL)
        ? DEFAULT_IMAGE_MODEL
        : models[0]?.id || null
      res.json({ models, selected, defaultId })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.put('/api/image-models/selected', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : ''
      if (!modelId) return res.status(400).json({ error: 'modelId obrigatório' })
      const overrides = await listModelOverrides(authed(req).email, authed(req).token) // a read error is a 500, never "enabled"
      if (!buildUserImageModels(overrides).some((m) => m.id === modelId)) {
        return res.status(400).json({ error: 'modelo de imagem não habilitado' })
      }
      await setSelectedImageModel(authed(req).email, authed(req).token, modelId)
      res.json({ ok: true, selected: modelId })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Org tool policy: which built-in tool GROUPS are available. The user-facing
  // read (picker hides disabled groups); a missing key means enabled (default-on).
  app.get('/api/tool-policy', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      // the client reads the policy on load: warm this user's web search
      // availability in the background so their first turn can offer the tool
      // (never awaited; per-user probes are deduped and cached)
      void warmWebSearch({ token: authed(req).token, email: authed(req).email }).catch(() => {})
      // same for the user's adopted MCP connections (admission + tool listing),
      // so a by-name connection has its tools on the first turn after a restart
      void Promise.resolve(warmUserMcpConnections(authed(req).token, authed(req).email)).catch(() => {})
      const policy = await getToolPolicy(authed(req).email, authed(req).token).catch(() => ({}))
      res.json({ policy, keys: TOOL_GROUP_KEYS })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.put('/api/admin/tool-policy/:key', auth, requireAdmin, async (req, res) => {
    try {
      const key = (req.params.key as string)
      if (!TOOL_GROUP_KEYS.includes(key)) return res.status(400).json({ error: 'tool inválida' })
      await setToolPolicy(authed(req).email, authed(req).token, key, !!req.body?.enabled, { admin: authed(req).isAdmin === true })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ---- taxímetro: the caller's spend (month + current conversation) ----------
  // Priced at list price at call time (usage_ledger). Always scoped to the
  // caller's email — a sessionId they don't own just sums to zero.
  app.get('/api/usage/summary', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const sessionId = /^\d+$/.test(String(req.query.sessionId || '')) ? String(req.query.sessionId) : null
      const summary = await getUsageSummary(authed(req).email, authed(req).token, { sessionId, tz: usageTimeZone() })
      res.json(summary)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // ---- admin: AI Gateway model catalog -----------------------------------
  // list live endpoints ∪ curated ∪ overrides; seeds overrides from the static
  // MODELS the first time so switching /api/models to enabled-only never strands
  // the org with no models.
  app.get('/api/admin/model-endpoints', auth, requireAdmin, async (req, res) => {
    try {
      await seedModelOverridesIfEmpty(authed(req).email, authed(req).token, MODELS, { admin: authed(req).isAdmin === true })
      const [discovered, rawOverrides] = await Promise.all([
        listChatEndpoints(authed(req).token),
        listModelOverrides(authed(req).email, authed(req).token),
      ])
      const overrides = await reconcileSeededPrices(authed(req), rawOverrides)
      // `recommended`: curated defaults this org's catalog doesn't have yet (it
      // was seeded before they existed) — offered as one-click adds in the tab.
      res.json({ endpoints: buildAdminCatalog(discovered, overrides), recommended: recommendedModelIds(overrides) })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.put('/api/admin/model-endpoints/:endpointId', auth, requireAdmin, async (req, res) => {
    try {
      const endpointId = decodeURIComponent((req.params.endpointId as string))
      const b = req.body || {}
      // prices: accept a non-negative number, else null (→ fall back to the
      // curated/family-inferred default). Guards against NaN/negatives from the UI.
      const price = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null)
      await upsertModelOverride(authed(req).email, authed(req).token, endpointId, {
        enabled: !!b.enabled,
        displayName: typeof b.displayName === 'string' ? b.displayName.slice(0, 120) : '',
        blurb: typeof b.blurb === 'string' ? b.blurb.slice(0, 300) : '',
        sortOrder: Number.isInteger(b.sortOrder) ? b.sortOrder : null,
        priceIn: price(b.priceIn),
        priceOut: price(b.priceOut),
      }, { admin: authed(req).isAdmin === true })
      invalidateUserModels() // force refresh so users see the change quickly
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Reorder the enabled models. Body: { order: [endpointId, ...] } — index 0 is
  // first in the picker AND the default model for new chats (see getUserModels /
  // the client's models[0]). Admin-only, like the other catalog mutations.
  app.put('/api/admin/model-endpoints-order', auth, requireAdmin, async (req, res) => {
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order.filter((x: unknown) => typeof x === 'string') : null
      if (!order || !order.length) return res.status(400).json({ error: 'order (array de ids) obrigatório' })
      await reorderModelOverrides(authed(req).email, authed(req).token, order, { admin: authed(req).isAdmin === true })
      invalidateUserModels() // force refresh so the new default/order shows quickly
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
