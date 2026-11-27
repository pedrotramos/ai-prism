// MCP Apps in the chat (W4-5): the placeholder, the opaque-origin View, its CSP, the host bridge and the confirmation dialogs.
// Runs the built client behind the fixture server, which serves the view route with the headers of the real
// buildViewCsp / viewResponseHeaders (server/mcpApps.ts) and records the View's tool calls.
//
//   AC1  feature off -> no placeholder
//   AC5  the placeholder opens a View that renders; window.parent.document throws; fetch('/api/sessions') and a fetch to an
//        undeclared domain are blocked by CSP (a violation is logged); a View tools/call asks first with the full arguments and
//        Cancel sends nothing; ui/message fills the composer without sending; a fourth View cannot open while three are
//        active; axe is clean
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, AXE_TAGS } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const DESKTOP = { theme: 'dark', mobile: false }

const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model

const uiCall = (n, over = {}) => ({
  id: `c${n}`,
  name: 'mcp_chart__show_chart',
  label: 'Chart',
  args: { series: 'a' },
  status: 'ok',
  durationMs: 120,
  result: 'chart ready',
  hasUi: true,
  uiServiceName: 'main.apps.chart',
  uiToolCallId: String(500 + n),
  uiCsp: { connectDomains: ['https://api.example.com'], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  ...over,
})

const assistant = (id, content, tool_calls) => ({
  id: String(id),
  role: 'assistant',
  content,
  attachments: null,
  model: MODEL,
  prompt_tokens: 120,
  completion_tokens: 80,
  blocks: null,
  tool_calls,
  created_at: '2026-11-22T07:09:00.000Z',
  media_processing: null,
  intent_classify: null,
  reasoning: null,
})

async function open(browser) {
  const ctx = await newVariantContext(browser, DESKTOP)
  const page = await ctx.newPage()
  const errors = []
  const csp = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) csp.push(m.text())
  })
  return { ctx, page, errors, csp }
}

async function serve(page, calls) {
  const body = sessionBody(ids.s3)
  const refs = calls.map((c) => `{{toolcall:${c.id}}}`).join('\n\n')
  body.messages = [body.messages[0], assistant(910, `Here is the chart.\n\n${refs}`, calls)]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
  await page.goto(`/#/chat/${ids.s3}`)
}

const placeholder = (page, n) => page.getByRole('button', { name: /Open app/i }).nth(n)
const viewFrame = (page, n = 0) => page.frameLocator('iframe[data-mcp-app]').nth(n)

test('AC1 with the feature off there is no placeholder, and the frame is never created', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await page.route('**/api/mcp-apps/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) }))
  await serve(page, [uiCall(1)])
  await expect(page.getByText('Here is the chart.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Open app/i })).toHaveCount(0)
  await expect(page.locator('iframe[data-mcp-app]')).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5 the placeholder names the service and the domains the app may contact, and opens a View that renders', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serve(page, [uiCall(1)])
  const open1 = placeholder(page, 0)
  await expect(open1).toBeVisible()
  await expect(open1).toContainText('main.apps.chart')
  await expect(page.getByText('https://api.example.com').first()).toBeVisible()
  // inert until opened: no frame yet
  await expect(page.locator('iframe[data-mcp-app]')).toHaveCount(0)
  await open1.click()
  const frame = page.locator('iframe[data-mcp-app]')
  await expect(frame).toHaveCount(1)
  // opaque origin by attribute: scripts and forms, never same-origin
  expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
  // src is set once the host bridge is connected (it loads the bridge chunk first), so wait for it
  await expect(frame).toHaveAttribute('src', '/api/mcp-apps/view/501')
  // the host labels it outside the frame, so a View cannot pass as host UI
  await expect(page.getByText(/Interactive app from main\.apps\.chart/i)).toBeVisible()
  await expect(viewFrame(page).locator('#status')).toHaveText('ready')
  await expect(viewFrame(page).locator('#tool-input')).toContainText('"series":"a"')
  await expect(viewFrame(page).locator('#tool-result')).toContainText('points')
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5 the View cannot reach the host document, the app API or an undeclared domain', async ({ browser }) => {
  const { ctx, page, errors, csp } = await open(browser)
  await serve(page, [uiCall(1)])
  await placeholder(page, 0).click()
  const v = viewFrame(page)
  await expect(v.locator('#status')).toHaveText('ready')
  await v.getByRole('button', { name: 'Probe parent' }).click()
  await expect(v.locator('#probe')).toContainText('parent blocked')
  await v.getByRole('button', { name: 'Probe app API' }).click()
  await expect(v.locator('#probe')).toContainText('fetch blocked: /api/sessions')
  await v.getByRole('button', { name: 'Probe other domain' }).click()
  await expect(v.locator('#probe')).toContainText('fetch blocked: https://undeclared.example.org')
  // the browser said why: connect-src, not a network failure
  expect(csp.some((m) => /connect-src/.test(m) && /\/api\/sessions/.test(m))).toBe(true)
  expect(csp.some((m) => /connect-src/.test(m) && /undeclared\.example\.org/.test(m))).toBe(true)
  // the headers the View arrived with
  const res = await page.request.get('/api/mcp-apps/view/501', { headers: { 'sec-fetch-dest': 'iframe' } })
  const policy = res.headers()['content-security-policy']
  expect(policy).toMatch(/^sandbox allow-scripts allow-forms; default-src 'none';/)
  expect(policy).not.toMatch(/'self'; |allow-same-origin|unsafe-eval/)
  expect(res.headers()['x-frame-options']).toBe('SAMEORIGIN')
  expect(res.headers()['referrer-policy']).toBe('no-referrer')
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5 a View tools/call asks first with the full arguments; Cancel sends nothing, Allow sends it once', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serve(page, [uiCall(1)])
  await placeholder(page, 0).click()
  const v = viewFrame(page)
  await expect(v.locator('#status')).toHaveText('ready')
  // the fixture server keeps one call log for the whole run (and for every --repeat-each pass): count what this test adds
  const seen = (await (await page.request.get('/__fixtures/mcp-app-calls')).json()).length
  const calls = async () => (await (await page.request.get('/__fixtures/mcp-app-calls')).json()).length - seen

  await v.getByRole('button', { name: 'Call tool' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('main.apps.chart')
  await expect(dialog).toContainText('refresh_data')
  await expect(dialog).toContainText('"range": "7d"')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(v.locator('#call')).toContainText(/error|rejected/)
  expect(await calls()).toBe(0)

  await v.getByRole('button', { name: 'Call tool' }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Allow' }).click()
  await expect(v.locator('#call')).toContainText('ok: refreshed')
  expect(await calls()).toBe(1)
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5 ui/message puts the text in the composer and sends nothing', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serve(page, [uiCall(1)])
  await placeholder(page, 0).click()
  const v = viewFrame(page)
  await expect(v.locator('#status')).toHaveText('ready')
  await v.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('textarea').first()).toHaveValue('Show EMEA only')
  // no turn started: the chat stream shim was never asked for a stream
  expect(await page.evaluate(() => window.__sse === undefined)).toBe(true)
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5 a fourth View cannot open while three are active', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serve(page, [uiCall(1), uiCall(2), uiCall(3), uiCall(4)])
  // each opened placeholder turns into the open state, so the next closed one is always the first
  // and each click waits for its View, or a click lands on the placeholder that is still turning into one
  for (let i = 0; i < 3; i++) {
    await placeholder(page, 0).click()
    await expect(page.locator('iframe[data-mcp-app]')).toHaveCount(i + 1)
  }
  await expect(page.locator('iframe[data-mcp-app]')).toHaveCount(3)
  const fourth = page.getByRole('button', { name: /Open app/i }).last()
  await expect(fourth).toBeDisabled()
  await expect(page.getByText(/at most 3 apps/i).first()).toBeVisible()
  // closing one frees a slot
  await page.getByRole('button', { name: /Close app/i }).first().click()
  await expect(page.locator('iframe[data-mcp-app]')).toHaveCount(2)
  await expect(page.getByRole('button', { name: /Open app/i }).last()).toBeEnabled()
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5 axe finds no violations with a View open', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serve(page, [uiCall(1)])
  await placeholder(page, 0).click()
  await expect(viewFrame(page).locator('#status')).toHaveText('ready')
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})
