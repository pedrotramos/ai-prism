import { getImage } from '../db.ts'
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
      res.setHeader('Content-Type', img.contentType || 'image/png')
      // another member's image in a shared chat: the client shows no edit affordance (N1b)
      if (img.readOnly) res.setHeader('X-Artifact-Read-Only', 'true')
      if (img.shared) {
        // a project chat's image: access can be revoked (leaving, removal, project delete), so the
        // browser revalidates every time and the server decides again (the getter above ran);
        // the bytes never change per id, so an unchanged one answers 304 without a Volume read
        res.setHeader('Cache-Control', 'private, no-cache')
        const etag = `"img-${img.id}"`
        res.setHeader('ETag', etag)
        // compared here, not with req.fresh: a reload (request Cache-Control: no-cache) must still get its 304
        const sent = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim().replace(/^W\//, ''))
        if (sent.includes(etag) || sent.includes('*')) return res.status(304).end()
      } else {
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      }
      res.send(await getImageBytes(req.token, img.volumePath))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
