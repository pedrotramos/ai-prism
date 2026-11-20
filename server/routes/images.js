import { getImage } from '../db.js'
import { getImageBytes } from '../imageStore.ts'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'

export default function registerImageRoutes(app) {
  // ---- generated images (bytes live on a UC Volume) ----
  // Streams the PNG back, scoped by user_email (the DB read enforces ownership;
  // the Volume read uses the user's own token). Cacheable — image bytes for a
  // given id never change.
  app.get('/api/images/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const img = await getImage(req.email, req.token, req.params.id)
      if (!img) return res.status(404).json({ error: 'imagem não encontrada' })
      const bytes = await getImageBytes(req.token, img.volumePath)
      res.setHeader('Content-Type', img.contentType || 'image/png')
      // another member's image in a shared chat: the client shows no edit affordance (N1b)
      if (img.readOnly) res.setHeader('X-Artifact-Read-Only', 'true')
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      res.send(bytes)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
