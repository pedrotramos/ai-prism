// The built frontend (client/dist): static files plus the SPA fallback. Mounted
// after every API route: its catch-all would otherwise answer API paths.
import type { Express } from 'express'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

export default function registerStaticRoutes(app: Express, dist: string) {
  if (!fs.existsSync(dist)) return
  // Vite names everything under /assets by content hash: safe to cache for a year. index.html (and every
  // other unhashed file) must be revalidated, or a deploy would keep serving the old shell.
  const assets = path.join(dist, 'assets') + path.sep
  app.use(
    express.static(dist, {
      maxAge: 0,
      setHeaders(res, file) {
        res.setHeader('Cache-Control', file.startsWith(assets) ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    }),
  )
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' })
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(dist, 'index.html'))
  })
}
