// The built frontend (client/dist): static files plus the SPA fallback. Mounted
// after every API route: its catch-all would otherwise answer API paths.
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

export default function registerStaticRoutes(app, dist) {
  if (!fs.existsSync(dist)) return
  app.use(express.static(dist))
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' })
    res.sendFile(path.join(dist, 'index.html'))
  })
}
