// Costs page (#/costs, admin only): billed cost from the system tables by
// resource / model / person / tag, the period picker, CSV export, and the
// loading / empty / error / no-access / not-admin states. Every /api/costs*
// request is answered here with page.route (fake data, no warehouse), so the
// shared fixture file and its "no misses" check stay untouched.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { routeToolUsage } from './web-search-cost-fixtures.mjs'
import { newVariantContext, contextOptions, FETCH_SHIM, AXE_TAGS, VARIANTS, variantName } from './lib.mjs'

// The page builds its default "Last 30 days" period from the browser clock
// (costsData.js presetPeriod). Every context here freezes Date at NOW, so the
// literal dates below hold on any wall-clock day, including across a UTC
// midnight mid-run. setFixedTime only pins Date; timers and animations still run.
const NOW = '2026-11-18T12:00:00Z'

const META = {
  breakdowns: ['resource', 'model', 'person', 'tag'],
  tagKeys: ['cost_center', 'ai_prism_app'],
  defaultPeriod: { from: '2026-10-20', to: '2026-11-18' },
  maxDays: 366,
}

const DATA = {
  resource: [
    { product: 'MODEL_SERVING', resource_id: 'databricks-claude-sonnet-5-5', dbus: 180.5, usd: 12.6 },
    { product: 'SQL', resource_id: 'abc123warehouse', dbus: 6, usd: 4.2 },
    { product: 'APPS', resource_id: 'ai-prism', dbus: 10, usd: 0.7 },
  ],
  model: [
    { endpoint_name: 'databricks-claude-sonnet-5-5', requests: 420, prompt_tokens: 900000, completion_tokens: 100000, total_tokens: 1000000, dbus: 180.5, usd: 12.6 },
    { endpoint_name: 'databricks-gpt-5', requests: 30, prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000, dbus: 1, usd: 0.07 },
  ],
  person: [
    { user_email: 'ana@example.com', requests: 300, total_tokens: 700000, dbus: 120, usd: 8.4 },
    { user_email: 'bruno@example.com', requests: 150, total_tokens: 303000, dbus: 61.5, usd: 4.27 },
  ],
  tag: [
    { tag_value: '1234', infra_usd: 4.9, ai_usd: 12.67, dbus: 197.5, usd: 17.57 },
    { tag_value: null, infra_usd: 0, ai_usd: 0.2, dbus: 3, usd: 0.2 },
  ],
}

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0)

function answer(by, period, rows = DATA[by]) {
  return { by, period, currency: 'USD', tagKey: by === 'tag' ? 'cost_center' : undefined, rows, totals: { usd: sum(rows, 'usd'), dbus: sum(rows, 'dbus') } }
}

/** Routes /api/costs*; `handler(by, url)` may return { status, json, delayMs }. */
async function routeCosts(page, handler = () => null) {
  await routeToolUsage(page) // the web-search tile asks for its own endpoint: an empty ledger here
  const seen = []
  await page.route('**/api/costs**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/costs/meta') return route.fulfill({ json: META })
    seen.push(url)
    const by = url.searchParams.get('by')
    const period = { from: url.searchParams.get('from') || META.defaultPeriod.from, to: url.searchParams.get('to') || META.defaultPeriod.to }
    const custom = handler(by, url)
    if (custom?.delayMs) await new Promise((r) => setTimeout(r, custom.delayMs))
    if (custom?.status) return route.fulfill({ status: custom.status, json: custom.json ?? {} })
    return route.fulfill({ json: answer(by, period, custom?.rows) })
  })
  return seen
}

async function open(browser, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  await ctx.clock.setFixedTime(NOW)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

const seriousOrCritical = (res) =>
  res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)

test('an admin opens Costs from the sidebar and switches resource → model → person → tag', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  const seen = await routeCosts(page)
  await page.goto(`${baseURL}/#/chat`)
  await page.getByRole('button', { name: 'Costs', exact: true }).click()
  await expect(page).toHaveURL(/#\/costs$/)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible()

  // resource is the first view; the total of the period is shown in USD
  await expect(main.getByRole('tab', { name: 'By resource' })).toHaveAttribute('aria-selected', 'true')
  const table = main.getByRole('table')
  await expect(table.getByRole('cell', { name: 'abc123warehouse' })).toBeVisible()
  await expect(table.getByRole('cell', { name: 'SQL Warehouse' })).toBeVisible()
  await expect(main.getByTestId('costs-total')).toHaveText('$17.50')
  expect(seen.at(-1).searchParams.get('by')).toBe('resource')
  expect(seen.at(-1).searchParams.get('from')).toBe('2026-10-20')

  await main.getByRole('tab', { name: 'By model' }).click()
  await expect(table.getByRole('cell', { name: 'databricks-gpt-5' })).toBeVisible()
  await expect(table.getByRole('columnheader', { name: 'Input tokens' })).toBeVisible()
  expect(seen.at(-1).searchParams.get('by')).toBe('model')

  await main.getByRole('tab', { name: 'By person' }).click()
  await expect(table.getByRole('cell', { name: 'bruno@example.com' })).toBeVisible()
  await expect(main.getByText('AI model calls only', { exact: false })).toBeVisible()

  await main.getByRole('tab', { name: 'By tag' }).click()
  await expect(main.getByRole('combobox', { name: 'Tag' })).toHaveValue('cost_center')
  await expect(table.getByRole('cell', { name: '1234' })).toBeVisible()
  await expect(table.getByRole('cell', { name: '(untagged)' })).toBeVisible()
  expect(seen.at(-1).searchParams.get('tag')).toBe('cost_center')
  await main.getByRole('combobox', { name: 'Tag' }).selectOption('ai_prism_app')
  await expect.poll(() => seen.at(-1).searchParams.get('tag')).toBe('ai_prism_app')

  // the chart follows the token palette through the shared ChartBlock
  await expect(main.locator('[data-block="chart"]')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the period picker: presets and custom dates drive the query', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const seen = await routeCosts(page)
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  await expect(main.getByRole('table')).toBeVisible()
  await expect(main.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true')

  await main.getByRole('button', { name: 'Last 7 days' }).click()
  await expect(main.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => {
    const u = seen.at(-1)
    return (Date.parse(u.searchParams.get('to')) - Date.parse(u.searchParams.get('from'))) / 86400000
  }).toBe(6)

  await main.getByLabel('From', { exact: true }).fill('2026-09-01')
  await main.getByLabel('To', { exact: true }).fill('2026-09-30')
  await expect.poll(() => `${seen.at(-1).searchParams.get('from')}..${seen.at(-1).searchParams.get('to')}`).toBe('2026-09-01..2026-09-30')
  await expect(main.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'false')

  // an inverted range is refused on the client, with a message, and no request
  const before = seen.length
  await main.getByLabel('From', { exact: true }).fill('2026-10-15')
  await expect(main.getByText('Choose a valid period', { exact: false })).toBeVisible()
  expect(seen.length).toBe(before)
  await ctx.close()
})

test('CSV export downloads the rows on screen for the selected breakdown and period', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await routeCosts(page)
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  await main.getByRole('tab', { name: 'By person' }).click()
  await expect(main.getByRole('cell', { name: 'ana@example.com' })).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), main.getByRole('button', { name: 'Export CSV' }).click()])
  expect(download.suggestedFilename()).toBe('ai-prism-costs-person-2026-10-20_2026-11-18.csv')
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv.split('\r\n')[0]).toBe('user_email,requests,total_tokens,dbus,usd')
  expect(csv).toContain('ana@example.com,300,700000,120,8.4')
  await ctx.close()
})

test('loading shows a skeleton, then the data', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await routeCosts(page, () => ({ delayMs: 1500, rows: DATA.resource }))
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  await expect(main.getByRole('status').filter({ hasText: 'Loading costs' })).toBeVisible()
  await expect(main.getByRole('table')).toHaveCount(0)
  await expect(main.getByRole('table')).toBeVisible({ timeout: 10_000 })
  await expect(main.getByRole('status').filter({ hasText: 'Loading costs' })).toHaveCount(0)
  await ctx.close()
})

test('empty period: a friendly empty state, no table, export disabled', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await routeCosts(page, () => ({ rows: [] }))
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  await expect(main.getByText('No billed usage in this period')).toBeVisible()
  await expect(main.getByRole('table')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
  await ctx.close()
})

test('a failing warehouse shows an error with Try again, which recovers', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  let fail = true
  await routeCosts(page, () => (fail ? { status: 502, json: { code: 'query_failed' } } : null))
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  const alert = main.getByRole('alert').filter({ hasText: "Couldn't load costs" })
  await expect(alert).toBeVisible()
  fail = false
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(main.getByRole('table')).toBeVisible()
  await expect(alert).toHaveCount(0)
  await ctx.close()
})

test('no SELECT on the system tables: a friendly no-access state, not an error', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await routeCosts(page, () => ({ status: 403, json: { code: 'no_access' } }))
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'No access to the billing system tables' })).toBeVisible()
  await expect(main.getByText('system.billing', { exact: false })).toBeVisible()
  await expect(main.getByRole('alert')).toHaveCount(0)
  await ctx.close()
})

test('a non-admin sees no Costs link, and #/costs says admins only', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.route('**/api/me', (r) => r.fulfill({ json: { email: 'user@example.com', isAdmin: false, isOwner: false } }))
  await page.route('**/api/costs**', (r) => r.fulfill({ status: 403, json: { error: 'admin_required', code: 'admin_required' } }))
  await page.goto(`${baseURL}/#/chat`)
  await expect(page.locator('textarea').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Costs', exact: true })).toHaveCount(0)
  await page.goto(`${baseURL}/#/costs`)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Admins only' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('table')).toHaveCount(0)
  await ctx.close()
})

test('pt-BR: Portuguese copy and dd/mm/yyyy period, no off-by-one west of UTC', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ ...contextOptions({ theme: 'light' }), locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
  await ctx.addInitScript(FETCH_SHIM)
  await ctx.clock.setFixedTime(NOW)
  const page = await ctx.newPage()
  await routeCosts(page)
  await page.goto(`${baseURL}/#/costs`)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Custos', level: 1 })).toBeVisible()
  await expect(main.getByTestId('costs-period')).toHaveText('20/10/2026 – 18/11/2026')
  await expect(main.getByTestId('costs-total')).toHaveText(/US\$\s17,50/)
  await ctx.close()
})

for (const v of VARIANTS) {
  test(`costs page: no serious/critical axe finding (${variantName(v)})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, v)
    await routeCosts(page)
    await page.goto(`${baseURL}/#/costs`)
    const main = page.getByRole('main')
    await expect(main.getByRole('table')).toBeVisible()
    await page.waitForTimeout(600) // chart entry animation
    const res = await new AxeBuilder({ page }).include('main').withTags(AXE_TAGS).analyze()
    expect(seriousOrCritical(res)).toEqual([])
    // no horizontal overflow of the page at 390 px
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await ctx.close()
  })
}
