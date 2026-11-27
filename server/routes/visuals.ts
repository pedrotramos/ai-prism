// Charts as assets: the geo sets the map block draws, and the PNG of a chart of a chat
// (the figure a document carries: Document Studio, print and DOCX all read this URL).
import { authed } from './authed.ts'
import type { Express } from 'express'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { getGeoSet } from '../geo.ts'
import { chartPng, rasterAvailable } from '../chartRaster.ts'
import { isVizId } from '../../shared/chartValue.ts'
import { loadVisualInventory } from '../visualLoad.ts'

const GEO_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

export default function registerVisualRoutes(app: Express) {
  // the projected regions of a geo set (shared/geoTypes.ts): the same shapes the server draws
  app.get('/api/geo/:id', auth, (req, res) => {
    const id = String(req.params.id)
    const set = GEO_ID_RE.test(id) ? getGeoSet(id) : null
    if (!set) return res.status(404).json({ error: 'conjunto geográfico não encontrado' })
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.json(set)
  })

  // GET /api/sessions/:id/visuals/viz_12_0.png | candidate_3.png
  app.get('/api/sessions/:id/visuals/:file', auth, async (req, res) => {
    try {
      const vizId = String(req.params.file).replace(/\.png$/i, '')
      const sessionId = String(req.params.id)
      if (!isVizId(vizId) || !/^\d{1,20}$/.test(sessionId)) return res.status(400).json({ error: 'id de figura inválido' })
      if (!rasterAvailable()) return res.status(503).json({ error: 'a geração de imagens de gráfico não está disponível neste servidor' })
      await ensureReady(authed(req))
      const items = await loadVisualInventory(authed(req).email, authed(req).token, sessionId)
      const item = items?.find((v) => v.id === vizId)
      if (!item) return res.status(404).json({ error: 'figura não encontrada' })
      const png = await chartPng(item.block)
      if (!png) return res.status(404).json({ error: 'a figura não é um gráfico' })
      res.setHeader('Content-Type', 'image/png')
      // a project chat's access can be revoked: the browser revalidates, the server decides again
      res.setHeader('Cache-Control', 'private, no-cache')
      res.send(png)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
