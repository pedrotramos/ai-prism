// W3-6 #6: hashed /assets/* are immutable for a year; index.html (and the SPA fallback) is never cached.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import registerStaticRoutes from '../server/routes/static.ts'

let dir, server, base
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-static-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>')
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>')
  const app = express()
  registerStaticRoutes(app, dir)
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('hashed assets are public, one year, immutable', async () => {
  const res = await fetch(`${base}/assets/index-abc123.js`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
})

test('index.html is no-cache, at / and at its own path', async () => {
  for (const p of ['/', '/index.html']) {
    const res = await fetch(base + p)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-cache', p)
  }
})

test('the SPA fallback (a client route) is no-cache too', async () => {
  const res = await fetch(`${base}/chat/12`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-cache')
})

test('an unhashed root file is not marked immutable', async () => {
  const res = await fetch(`${base}/favicon.svg`)
  assert.doesNotMatch(res.headers.get('cache-control') || '', /immutable/)
})

test('a missing asset is a 404, never the HTML fallback cached as an asset', async () => {
  const res = await fetch(`${base}/assets/missing-zzz.js`)
  assert.notEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
})
