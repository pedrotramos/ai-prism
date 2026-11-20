#!/usr/bin/env node
// Static server for the e2e/a11y job: serves the built client (client/dist)
// and answers /api/* from recorded fixtures (client/e2e/fixtures/api.json), so
// the browser runs the real SPA with no backend, database or AI Gateway.
//
//   node client/e2e/fixture-server.mjs [--port 4173]
//
// A request without a fixture gets a JSON 404 and is listed at
// GET /__fixtures/misses, so a screen that starts calling a new endpoint shows
// up in the report instead of silently rendering an error state.
//
// Every response carries the production security headers (the same
// securityHeaders() + security() functions server/middleware installs), so the
// suites run the SPA under the real enforced and report-only CSP. CSP reports
// POSTed to /api/csp-report are summarised like production and listed at
// GET /__fixtures/csp-reports.
import http from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { securityHeaders } from '../../server/securityHeaders.ts'
import { security, summarizeCspReports } from '../../server/middleware/security.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(HERE, '..', 'dist')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json' }

export function fixtureKey(method, url) {
  const u = new URL(url, 'http://x')
  return `${method.toUpperCase()} ${u.pathname}${u.search}`
}

export async function startFixtureServer({ port = 4173, host = '127.0.0.1', fixtures, dist = DIST } = {}) {
  const fx = fixtures || JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'api.json'), 'utf8'))
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`no ${dist}/index.html: run npm run build:client first`)
  const misses = new Map()
  const cspReports = []
  const headerMiddleware = [securityHeaders(), security({ log: () => {} })]
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    // a GET view of the request: the middleware only sets headers here
    for (const mw of headerMiddleware) mw({ method: 'GET', path: u.pathname, headers: req.headers }, res, () => {})
    if (u.pathname === '/__fixtures/csp-reports') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(cspReports))
    }
    if (u.pathname === '/api/csp-report' && req.method === 'POST') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try {
          cspReports.push(...summarizeCspReports(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        } catch {}
        res.writeHead(204).end()
      })
      return
    }
    if (u.pathname === '/__fixtures/misses') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify([...misses.entries()].map(([key, count]) => ({ key, count }))))
    }
    if (u.pathname.startsWith('/api/')) {
      req.resume()
      const key = fixtureKey(req.method, req.url)
      const hit = fx.routes[key] || fx.routes[`${req.method.toUpperCase()} ${u.pathname}`]
      if (!hit) {
        misses.set(key, (misses.get(key) || 0) + 1)
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'no fixture for this request' }))
      }
      const body = hit.encoding === 'base64' ? Buffer.from(hit.body, 'base64') : hit.body
      res.writeHead(hit.status, { 'content-type': hit.contentType || 'application/json' })
      return res.end(body)
    }
    let decoded
    try {
      decoded = decodeURIComponent(u.pathname)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      return res.end('bad request')
    }
    let file = path.join(dist, decoded)
    // anything that resolves outside dist (incl. a sibling like dist-x/) gets the SPA shell
    const rel = path.relative(dist, file)
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    if (!inside || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return {
    url: `http://${host}:${server.address().port}`,
    misses: () => [...misses.keys()],
    close: () =>
      new Promise((r) => {
        server.close(() => r())
        server.closeAllConnections() // keep-alive sockets would hold close() open
      }),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port')
  const s = await startFixtureServer({ port: i >= 0 ? Number(process.argv[i + 1]) : 4173 })
  process.stdout.write(`fixture server on ${s.url}\n`)
}
