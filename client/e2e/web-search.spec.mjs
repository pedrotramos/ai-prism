// Web search admin card + chip icon (W2-11b). The admin Tools tab shows ONE
// ROW PER CHAIN ENTRY from GET /api/admin/web-search/status, a Verify action
// (POST /api/admin/web-search/verify, result counts only) and the 24 h
// `forbidden` count. Both web tools' chips carry the globe icon. Built client +
// recorded fixtures; the web-search routes are answered with page.route.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, newVariantContext, SCREENS, loadFixtures } from './lib.mjs'

const DESKTOP = { theme: 'dark', mobile: false }
// a key value that must never reach the DOM, whatever the backend sends
const SECRET = 'sk-live-should-never-render-0123456789'

const STATUS = {
  mode: 'auto',
  enabled: true,
  offReason: null,
  chain: [
    { kind: 'managed-mcp', provider: 'databricks', service: 'system.ai.web_search', state: 'down', code: 'forbidden' },
    { kind: 'external-mcp', provider: 'firecrawl-mcp', service: 'main.tools.firecrawl', tool: 'firecrawl_search', state: 'up', lastMs: 812 },
    { kind: 'brave', provider: 'brave', keyPresent: true, state: 'unknown' },
    { kind: 'tavily', provider: 'tavily', keyPresent: true, state: 'down', code: 'quota' },
    { kind: 'searxng', provider: 'searxng', state: 'down', code: 'timeout' },
  ],
  last24h: { calls: 9, errors: 4, byCode: { forbidden: 3, quota: 1 } },
}

const VERIFIED = {
  ...STATUS,
  chain: [
    { kind: 'managed-mcp', provider: 'databricks', service: 'system.ai.web_search', state: 'down', code: 'forbidden', lastMs: 120 },
    { kind: 'external-mcp', provider: 'firecrawl-mcp', service: 'main.tools.firecrawl', tool: 'firecrawl_search', state: 'up', lastMs: 640, resultCount: 3 },
    { kind: 'brave', provider: 'brave', keyPresent: true, state: 'up', lastMs: 300, resultCount: 2 },
    { kind: 'tavily', provider: 'tavily', keyPresent: true, state: 'down', code: 'quota', lastMs: 90 },
    { kind: 'searxng', provider: 'searxng', state: 'down', code: 'timeout', lastMs: 12000 },
  ],
  last24h: { calls: 14, errors: 6, byCode: { forbidden: 4, quota: 2 } },
}

async function stubAdmin(page) {
  await page.route('**/api/admin/model-endpoints', (r) => r.fulfill({ json: { endpoints: [], recommended: [] } }))
  await page.route('**/api/admin/mcp-catalog', (r) => r.fulfill({ json: { entries: [], suggestions: [] } }))
  await page.route('**/api/admins', (r) => r.fulfill({ json: { owner: 'owner@example.com', admins: [] } }))
  await page.route('**/api/admins/candidates', (r) => r.fulfill({ json: { candidates: [] } }))
  await page.route('**/api/skills', (r) => r.fulfill({ json: { skills: [], isAdmin: true } }))
  await page.route('**/api/deck-templates', (r) => r.fulfill({ json: { templates: [] } }))
  await page.route('**/api/admin/tool-policy/*', (r) => r.fulfill({ json: { ok: true } }))
}

async function openCard(browser, baseURL, { status = STATUS, policy = null, verify = null } = {}) {
  const ctx = await newVariantContext(browser, DESKTOP)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await stubAdmin(page)
  if (policy) await page.route('**/api/tool-policy', (r) => r.fulfill({ json: { policy } }))
  // the status body may carry a stray key value: the card must not render it
  await page.route('**/api/admin/web-search/status', (r) => r.fulfill({ json: { ...status, apiKey: SECRET } }))
  const verifyCalls = []
  await page.route('**/api/admin/web-search/verify', (r) => {
    verifyCalls.push({ method: r.request().method(), body: r.request().postDataJSON() })
    return verify ? verify(r) : r.fulfill({ json: VERIFIED })
  })
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Tools', exact: true }).click()
  const card = dialog.getByRole('region', { name: 'Web Search' })
  await expect(card).toBeVisible()
  return { ctx, page, dialog, card, errors, verifyCalls }
}

const rows = (card) => card.locator('[data-chain-row]')

test('AC-1: one row per chain entry, in order, with an honest state each; MCP rows name service + tool, keyed rows presence only', async ({ browser, baseURL }) => {
  const { ctx, card, errors } = await openCard(browser, baseURL)
  await expect(rows(card)).toHaveCount(5)
  const kinds = await rows(card).evaluateAll((els) => els.map((e) => [e.getAttribute('data-kind'), e.getAttribute('data-state')]))
  expect(kinds).toEqual([
    ['managed-mcp', 'forbidden'],
    ['external-mcp', 'up'],
    ['brave', 'unknown'],
    ['tavily', 'quota'],
    ['searxng', 'unavailable'],
  ])
  await expect(rows(card).nth(0)).toContainText('No permission or service does not exist')
  await expect(rows(card).nth(0)).toContainText('system.ai.web_search')
  await expect(rows(card).nth(1)).toContainText('Available')
  await expect(rows(card).nth(1)).toContainText('main.tools.firecrawl')
  await expect(rows(card).nth(1)).toContainText('firecrawl_search')
  await expect(rows(card).nth(2)).toContainText('Not checked yet')
  await expect(rows(card).nth(2)).toContainText('Key configured')
  await expect(rows(card).nth(3)).toContainText('Quota exceeded')
  await expect(rows(card).nth(4)).toContainText('Unavailable')
  // the active entry is the first one that is not down
  await expect(rows(card).nth(1)).toHaveAttribute('data-active', 'true')
  await expect(card.locator('[data-active="true"]')).toHaveCount(1)
  // 24 h forbidden count
  await expect(card.getByTestId('web-search-forbidden-24h')).toHaveText('3')
  expect(await ctx.pages()[0].content()).not.toContain(SECRET)
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC-1: unconfigured MCP → no search tool; keyed row without a key → no key', async ({ browser, baseURL }) => {
  const status = {
    ...STATUS,
    chain: [
      { kind: 'external-mcp', provider: 'mcp', service: 'main.tools.other', state: 'down', code: 'unconfigured' },
      { kind: 'brave', provider: 'brave', keyPresent: false, state: 'down', code: 'unconfigured' },
    ],
    last24h: { calls: 0, errors: 0, byCode: {} },
  }
  const { ctx, card } = await openCard(browser, baseURL, { status })
  await expect(rows(card)).toHaveCount(2)
  await expect(rows(card).nth(0)).toHaveAttribute('data-state', 'no_tool')
  await expect(rows(card).nth(0)).toContainText('Search tool not identified')
  await expect(rows(card).nth(1)).toHaveAttribute('data-state', 'no_key')
  await expect(rows(card).nth(1)).toContainText('No key')
  await expect(card.locator('[data-active="true"]')).toHaveCount(0)
  await expect(card.getByTestId('web-search-forbidden-24h')).toHaveText('0')
  await ctx.close()
})

for (const [offReason, mode, text] of [
  ['kill_switch', 'off', 'Off (kill-switch)'],
  ['backend_off', 'off', 'Off (WEB_SEARCH_BACKEND=off)'],
  ['invalid_backend', 'off', 'Off (invalid WEB_SEARCH_BACKEND)'],
  ['none_configured', 'auto', 'No backend configured'],
]) {
  test(`overall state: ${offReason} renders as an honest state, not an error`, async ({ browser, baseURL }) => {
    const status = { mode, enabled: false, offReason, chain: [], last24h: { calls: 0, errors: 0, byCode: {} } }
    const { ctx, card } = await openCard(browser, baseURL, { status })
    await expect(card.getByTestId('web-search-overall')).toHaveText(text)
    await expect(rows(card)).toHaveCount(0)
    await expect(card.getByRole('alert')).toHaveCount(0)
    await ctx.close()
  })
}

test('overall state: the policy toggle off wins and reads "Off (policy)"', async ({ browser, baseURL }) => {
  const { ctx, card } = await openCard(browser, baseURL, { policy: { 'web-search': false } })
  await expect(card.getByTestId('web-search-overall')).toHaveText('Off (policy)')
  await expect(card.getByRole('switch', { name: 'Web Search' })).toHaveAttribute('aria-checked', 'false')
  await ctx.close()
})

// per-entry Verify fixture: the response marks only the named entry as checked
const verifiedFor = (entry) => {
  const chain = STATUS.chain.map((r, i) => (i === entry ? VERIFIED.chain[i] : r))
  const v = chain[entry]
  return { ...VERIFIED, chain, verified: { entry, kind: v.kind, state: v.state, code: v.code ?? null, resultCount: v.resultCount ?? null } }
}

test('AC-2: each row has its own Verify; one click = one POST naming that entry; counts only', async ({ browser, baseURL }) => {
  const verify = (r) => r.fulfill({ json: verifiedFor(r.request().postDataJSON().entry) })
  const { ctx, page, card, verifyCalls } = await openCard(browser, baseURL, { verify })
  await expect(card.getByRole('button', { name: /^Verify/ })).toHaveCount(5)
  await rows(card).nth(1).getByRole('button', { name: 'Verify External MCP service' }).click()
  await expect(rows(card).nth(1)).toContainText('3 results')
  expect(verifyCalls).toEqual([{ method: 'POST', body: { entry: 1, kind: 'external-mcp' } }])
  // the other rows keep their states (brave is still unchecked)
  await expect(rows(card).nth(2)).toHaveAttribute('data-state', 'unknown')
  await expect(rows(card).nth(2)).not.toContainText('results')
  await expect(card.getByRole('status')).toContainText('External MCP service: 3 results')
  await expect(card.getByTestId('web-search-forbidden-24h')).toHaveText('4')
  await rows(card).nth(2).getByRole('button', { name: 'Verify Brave Search API' }).click()
  await expect(rows(card).nth(2)).toContainText('2 results')
  await expect(rows(card).nth(2)).toHaveAttribute('data-state', 'up')
  expect(verifyCalls.map((c) => c.body)).toEqual([{ entry: 1, kind: 'external-mcp' }, { entry: 2, kind: 'brave' }])
  expect(await page.content()).not.toContain(SECRET)
  await ctx.close()
})

test('AC-2: a Verify that fails at the provider names the row state', async ({ browser, baseURL }) => {
  const verify = (r) => r.fulfill({ json: verifiedFor(3) })
  const { ctx, card } = await openCard(browser, baseURL, { verify })
  await rows(card).nth(3).getByRole('button', { name: 'Verify Tavily API' }).click()
  await expect(card.getByRole('status')).toContainText('Tavily API: Quota exceeded')
  await ctx.close()
})

test('AC-2: Verify rate-limited (429), invalid (400) and failed (500) show explicit messages', async ({ browser, baseURL }) => {
  let n = 0
  const verify = (r) => {
    const k = n++
    if (k === 0) return r.fulfill({ status: 429, headers: { 'Retry-After': '7' }, json: { error: 'verify_rate_limited' } })
    if (k === 1) return r.fulfill({ status: 400, json: { error: 'invalid_entry' } })
    return r.fulfill({ status: 500, json: { error: 'verify_failed' } })
  }
  const { ctx, card } = await openCard(browser, baseURL, { verify })
  const btn = rows(card).nth(1).getByRole('button', { name: 'Verify External MCP service' })
  await btn.click()
  await expect(card.getByRole('alert')).toContainText('Wait 7 s before verifying again.')
  await btn.click()
  await expect(card.getByRole('alert')).toContainText('The search configuration changed. Reload the page and try again.')
  await btn.click()
  await expect(card.getByRole('alert')).toContainText('Verification failed. Try again in a moment.')
  // rows keep the last known states
  await expect(rows(card)).toHaveCount(5)
  await ctx.close()
})

test('status route failing shows an explicit error inside the card, the rest of the tab still works', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, DESKTOP)
  const page = await ctx.newPage()
  await stubAdmin(page)
  await page.route('**/api/admin/web-search/status', (r) => r.fulfill({ status: 500, json: { error: 'status_failed' } }))
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Tools', exact: true }).click()
  const card = dialog.getByRole('region', { name: 'Web Search' })
  await expect(card.getByRole('alert')).toContainText("Couldn't load the web search status.")
  await expect(dialog.getByRole('switch', { name: 'Python' })).toBeVisible()
  await ctx.close()
})

test('axe: the web search card is clean (after Verify too)', async ({ browser, baseURL }) => {
  const { ctx, page, card } = await openCard(browser, baseURL, { verify: (r) => r.fulfill({ json: verifiedFor(1) }) })
  const scan = async () => {
    const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).include('[data-testid="web-search-card"]').analyze()
    return r.violations.map((v) => `${v.id}: ${v.nodes.length}`)
  }
  expect(await scan()).toEqual([])
  await rows(card).nth(1).getByRole('button', { name: 'Verify External MCP service' }).click()
  await expect(rows(card).nth(1)).toContainText('3 results')
  expect(await scan()).toEqual([])
  await ctx.close()
})

// ---------------------------------------------------------------- chip icon
const fx = loadFixtures()
const ids = fx.ids
const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)

test('AC-3: web_search and web_fetch chips carry the globe icon', async ({ browser }) => {
  const ctx = await newVariantContext(browser, DESKTOP)
  const page = await ctx.newPage()
  const body = sessionBody(ids.s3)
  const model = sessionBody(ids.s1).messages[1].model
  const tool_calls = [
    { id: 'w1', name: 'web_search', label: 'Searching the web', args: { query: 'selic' }, status: 'ok', durationMs: 900, result: 'ok' },
    { id: 'w2', name: 'web_fetch', label: 'Reading a page', args: { url: 'https://example.com' }, status: 'ok', durationMs: 400, result: 'ok' },
  ]
  body.messages = [
    body.messages[0],
    { id: '990', role: 'assistant', content: 'Looked it up.\n\n{{toolcall:w1}}\n\n{{toolcall:w2}}', attachments: null, model, prompt_tokens: 1, completion_tokens: 1, blocks: null, tool_calls, created_at: '2026-11-17T07:09:00.000Z', media_processing: null, intent_classify: null, reasoning: null },
  ]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
  await page.goto(`/#/chat/${ids.s3}`)
  const chips = page.locator('[data-tool-state]')
  await expect(chips).toHaveCount(2)
  for (let i = 0; i < 2; i++) await expect(chips.nth(i).locator('[data-tool-icon="globe"] svg')).toHaveCount(1)
  await ctx.close()
})
