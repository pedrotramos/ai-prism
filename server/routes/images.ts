import { authed } from './authed.ts'
import type { Express, RequestHandler } from 'express'
import * as db from '../db.ts'
import { getImageBytes as realGetImageBytes } from '../imageStore.ts'
import { auth as realAuth } from '../middleware/auth.ts'
import { ensureReady as realEnsureReady } from '../middleware/ensureReady.ts'
import { setArtifactHeaders } from '../artifactHeaders.ts'

const extensionFor = (type: string) => ((type.split(';')[0] ?? '').split('/')[1] || 'bin').replace(/\+.*$/, '').replace(/[^a-z0-9]/gi, '') || 'bin'

interface ImageRouteDeps {
  auth?: RequestHandler
  ensureReady?: typeof realEnsureReady
  getImage?: typeof db.getImage
  getImageBytes?: typeof realGetImageBytes
}

// `deps` overrides the collaborators in tests; production passes nothing.
export default function registerImageRoutes(app: Express, deps: ImageRouteDeps = {}) {
  const { auth = realAuth, ensureReady = realEnsureReady, getImage = db.getImage, getImageBytes = realGetImageBytes } = deps
  // ---- generated images (bytes live on a UC Volume) ----
  // Streams the PNG back, scoped by user_email (the DB read enforces ownership;
  // the Volume read uses the user's own token). Cacheable — image bytes for a
  // given id never change.
  app.get('/api/images/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const img = await getImage(authed(req).email, authed(req).token, (req.params.id as string))
      if (!img) return res.status(404).json({ error: 'imagem não encontrada' })
      // an SVG (or any non-raster type) is an attachment: opened as a page it would run script on the app origin
      const type = img.contentType || 'image/png'
      setArtifactHeaders(res, { contentType: type, fallbackName: `image-${img.id}.${extensionFor(type)}`, inlineRaster: true })
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
      res.send(await getImageBytes(authed(req).token, img.volumePath))
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
