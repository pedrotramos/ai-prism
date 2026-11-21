// Presentation style templates ("design systems").
import { authed } from './authed.ts'
import type { Express } from 'express'
import {
  listDeckTemplates,
  getSelectedDeckTemplate,
  getDeckTemplate,
  templateSummary,
  createDeckTemplate,
  updateDeckTemplate,
  selectDeckTemplate,
  deleteDeckTemplate,
  setDeckTemplateScope,
} from '../db.ts'
import { isAdmin } from '../authz.ts'
import { labelDesignAssets } from '../llm.ts'
import { auth } from '../middleware/auth.ts'
import { requireAdmin } from '../middleware/requireAdmin.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { validateTemplateTokens } from '../templatePayload.ts'

// any: untrusted client JSON, narrowed field by field by the validators below
type Json = any

// cheap shape/cap validation so a malformed client payload can't persist
// garbage into a design system (400 with the offending fields, not a 500)
function validateTemplatePayload(t: Json): string[] {
  const bad: string[] = []
  const hexOk = (v: unknown) => !v || /^#[0-9A-Fa-f]{6}$/.test(String(v))
  for (const k of ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor']) {
    if (!hexOk(t[k])) bad.push(k)
  }
  if (t.palette !== undefined) {
    const ok =
      Array.isArray(t.palette) &&
      t.palette.length <= 64 &&
      t.palette.every((p: Json) => p && typeof p.varName === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.value || ''))
    if (!ok) bad.push('palette')
  }
  if (t.iconAssets !== undefined) {
    const kinds = new Set(['icon', 'image', 'watermark', 'illustration', 'background', 'lockup'])
    const ok =
      Array.isArray(t.iconAssets) &&
      t.iconAssets.length <= 200 &&
      t.iconAssets.every(
        (a: Json) => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:') && (!a.kind || kinds.has(a.kind))
      )
    if (!ok) bad.push('iconAssets')
  }
  if (t.fontAssets !== undefined) {
    const ok =
      Array.isArray(t.fontAssets) &&
      t.fontAssets.length <= 16 &&
      t.fontAssets.every((f: Json) => f && typeof f.family === 'string' && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:'))
    if (!ok) bad.push('fontAssets')
  }
  // strict patterns for the fields the client pastes into a <style> (server/templatePayload.js)
  for (const k of validateTemplateTokens(t)) if (!bad.includes(k)) bad.push(k)
  if (t.dsCards !== undefined) {
    // Per-card ceiling matches the importer's CARD_MAX_HTML (dsImport.js): rich
    // template/slide specimens legitimately inline several downscaled rasters
    // (Reference Architecture ~2.1MB), so a 700KB cap here silently 400'd the
    // very cards the flagship bundle exists to show. The 24MB body limit
    // (express.json) and 120-card count still bound the total payload.
    const ok =
      Array.isArray(t.dsCards) &&
      t.dsCards.length <= 120 &&
      t.dsCards.every((c: Json) => c && typeof c.html === 'string' && c.html.length <= 2_600_000)
    if (!ok) bad.push('dsCards')
  }
  return bad
}

export default function registerDeckTemplateRoutes(app: Express) {
  // a user's collection of presentation style templates ("design systems"),
  // exactly one selected at a time (Settings → Modelos de apresentação).
  // The list ships SUMMARIES (no readme/specimen cards — see templateSummary);
  // the by-id route below returns the full row for the Design System viewer.
  app.get('/api/deck-templates', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const [templates, admin] = await Promise.all([
        listDeckTemplates(authed(req).email, authed(req).token),
        isAdmin(authed(req).email, authed(req).token),
      ])
      // visible non-global rows are always the caller's own; global rows are
      // read-only unless the caller is an admin (server enforces on write too)
      res.json({
        templates: templates.map((t: Json) => ({ ...templateSummary(t), canEdit: t.scope !== 'global' || admin })),
        isAdmin: admin,
      })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Render bundle: only the SELECTED template, with iconAssets cut to the kinds
  // the painters actually resolve (icon/image refs on slides, illustration art
  // in the theme — see shared/deckTheme.js). The chat deck cards and the Studio
  // load this on every deck open, so it must stay lean: a mined design system's
  // full asset library (backgrounds, lockups) can be tens of MB and belongs
  // only to the Settings grid, which keeps the full list endpoint.
  // NOTE: registered before /api/deck-templates/:id — Express matches in order.
  const RENDER_ASSET_KINDS = new Set(['icon', 'image', 'illustration'])
  app.get('/api/deck-templates/selected', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const t = await getSelectedDeckTemplate(authed(req).email, authed(req).token)
      if (!t) return res.json({ template: null })
      const template = templateSummary(t)
      template.iconAssets = (template.iconAssets || []).filter((a: Json) => !a.kind || RENDER_ASSET_KINDS.has(a.kind))
      res.json({ template })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.get('/api/deck-templates/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const template = await getDeckTemplate(authed(req).email, authed(req).token, (req.params.id as string))
      if (!template) return res.status(404).json({ error: 'modelo não encontrado' })
      res.json({ template })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.post('/api/deck-templates', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const body = req.body || {}
      delete body._importReport // review-UI bookkeeping, never persisted
      const bad = validateTemplatePayload(body)
      if (bad.length) return res.status(400).json({ error: `payload inválido nos campos: ${bad.join(', ')}` })
      const template = await createDeckTemplate(authed(req).email, authed(req).token, body)
      res.json({ template })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Semantic labeling of mined design-system assets with a vision model — the
  // import flow sends thumbnail-sized copies; the returned labels only steer
  // asset choice in prompts (never slide content). Stateless: the client merges
  // labels into the (still unsaved) template draft.
  app.post('/api/deck-templates/label-assets', auth, async (req, res) => {
    try {
      const assets = (Array.isArray(req.body?.assets) ? req.body.assets : [])
        .filter((a: Json) => a && typeof a.id === 'string' && typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl))
        .slice(0, 40)
        .map((a: Json) => ({ id: a.id.slice(0, 60), kind: typeof a.kind === 'string' ? a.kind.slice(0, 12) : 'icon', dataUrl: a.dataUrl.slice(0, 300_000) }))
      const diagrams = (Array.isArray(req.body?.diagrams) ? req.body.diagrams : [])
        .filter((d: Json) => d && typeof d.id === 'string')
        .slice(0, 8)
        .map((d: Json) => ({ id: d.id.slice(0, 60), texts: (Array.isArray(d.texts) ? d.texts : []).map((t: unknown) => String(t).slice(0, 60)) }))
      if (!assets.length && !diagrams.length) return res.json({ labels: {} })
      res.json({ labels: await labelDesignAssets(authed(req).token, assets, diagrams) })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.patch('/api/deck-templates/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const body = req.body || {}
      delete body._importReport
      const bad = validateTemplatePayload(body)
      if (bad.length) return res.status(400).json({ error: `payload inválido nos campos: ${bad.join(', ')}` })
      const admin = await isAdmin(authed(req).email, authed(req).token)
      const ok = await updateDeckTemplate(authed(req).email, authed(req).token, (req.params.id as string), body, admin)
      if (!ok) return res.status(403).json({ error: 'sem permissão para editar este modelo' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.post('/api/deck-templates/:id/select', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const ok = await selectDeckTemplate(authed(req).email, authed(req).token, (req.params.id as string))
      if (!ok) return res.status(404).json({ error: 'modelo não encontrado' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.delete('/api/deck-templates/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const admin = await isAdmin(authed(req).email, authed(req).token)
      const ok = await deleteDeckTemplate(authed(req).email, authed(req).token, (req.params.id as string), admin)
      if (!ok) return res.status(403).json({ error: 'sem permissão para excluir este modelo' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // publishes/unpublishes a template org-wide: global rows appear (read-only)
  // for every user and become the default starting point for new users
  app.post('/api/deck-templates/:id/scope', auth, requireAdmin, async (req, res) => {
    try {
      const scope = req.body?.scope === 'global' ? 'global' : 'user'
      const ok = await setDeckTemplateScope(authed(req).email, authed(req).token, (req.params.id as string), scope, { admin: authed(req).isAdmin === true })
      if (!ok) return res.status(404).json({ error: 'modelo não encontrado' })
      res.json({ ok: true, scope })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
