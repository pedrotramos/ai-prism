// The web-search cost tile on the Costs page (#/costs, admin only): loading, empty,
// error (with Try again), all priced, priced + unpriced (with the estimate), the
// price editor (save, clear, validation, failure), the users shown only as a hash,
// pt-BR copy, and no serious/critical axe finding at 1440 and 390, light and dark.
// Every request is answered with page.route (fake data, no backend).
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { newVariantContext, contextOptions, AXE_TAGS, VARIANTS, variantName } from './lib.mjs'
import { ALL_PRICED, EMPTY, PRICED_AND_UNPRICED, routeToolUsage } from './web-search-cost-fixtures.mjs'

const NOW = '2026-11-18T12:00:00Z'
const META = {
  breakdowns: ['resource', 'model', 'person', 'tag'],
  tagKeys: ['ai_prism_app'],
  defaultPeriod: { from: '2026-10-20', to: '2026-11-18' },
  maxDays: 366,
}

async function open(browser, variant = { theme: 'dark', mobile: false }, tool = {}) {
  const ctx = await newVariantContext(browser, variant)
  await ctx.clock.setFixedTime(NOW)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // the Costs page itself: an empty period is enough, the tile is what is under test
  await page.route('**/api/costs**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/costs/meta') return route.fulfill({ json: META })
    return route.fulfill({ json: { by: 'resource', period: META.defaultPeriod, currency: 'USD', rows: [], totals: { usd: 0, dbus: 0 } } })
  })
  const seen = await routeToolUsage(page, tool)
  return { ctx, page, errors, seen }
}

const tileOf = (page) => page.getByTestId('web-search-tile')
const seriousOrCritical = (res) =>
  res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)

test('priced and unpriced calls: totals, the estimate at the current price, providers, users as a hash only', async ({ browser, baseURL }) => {
  const { ctx, page, errors, seen } = await open(browser, undefined, { data: PRICED_AND_UNPRICED })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await expect(tile.getByRole('heading', { name: 'Web search', level: 2 })).toBeVisible()
  await expect(tile.getByTestId('web-search-calls')).toHaveText('12')
  await expect(tile.getByTestId('web-search-cost')).toHaveText('$0.04')
  await expect(tile.getByTestId('web-search-unpriced')).toHaveText('4')
  await expect(tile.getByTestId('web-search-unpriced-note')).toContainText('4 calls have no price')
  await expect(tile.getByTestId('web-search-unpriced-note')).toContainText('$0.008')
  await expect(tile.locator('[data-block="chart"]')).toBeVisible()
  const providers = tile.getByRole('table', { name: /By provider/ })
  await expect(providers.getByRole('cell', { name: 'brave' })).toBeVisible()
  await expect(providers.getByRole('cell', { name: 'databricks' })).toBeVisible()
  const users = tile.getByRole('table', { name: /Top users/ })
  await expect(users.getByRole('cell', { name: '3f9a1c0b' })).toBeVisible()
  expect(await tile.innerText()).not.toMatch(/@/)
  // the request follows the page period
  expect(seen.gets.at(-1).searchParams.get('kind')).toBe('web_search')
  expect(seen.gets.at(-1).searchParams.get('from')).toBe('2026-10-20')
  expect(seen.gets.at(-1).searchParams.get('to')).toBe('2026-11-18')
  expect(errors).toEqual([])
  await ctx.close()
})

test('all calls priced: no unpriced note', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, undefined, { data: ALL_PRICED })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await expect(tile.getByTestId('web-search-calls')).toHaveText('8')
  await expect(tile.getByTestId('web-search-unpriced')).toHaveText('0')
  await expect(tile.getByTestId('web-search-unpriced-note')).toHaveCount(0)
  await ctx.close()
})

test('an empty ledger: a friendly empty state, no tables, the price editor still there', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, undefined, { data: EMPTY })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await expect(tile.getByText('No web searches in this period')).toBeVisible()
  await expect(tile.getByRole('table')).toHaveCount(0)
  await expect(tile.getByRole('textbox', { name: 'All providers: price per 1,000 calls (USD)' })).toBeVisible()
  await ctx.close()
})

test('loading shows a skeleton, then the data', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, undefined, { data: PRICED_AND_UNPRICED, handler: () => ({ delayMs: 1500, json: PRICED_AND_UNPRICED }) })
  await page.goto(`${baseURL}/#/costs`)
  await expect(tileOf(page).getByRole('status').filter({ hasText: 'Loading web search usage' })).toBeVisible()
  await expect(tileOf(page).getByTestId('web-search-calls')).toHaveText('12')
  await ctx.close()
})

test('a failing ledger shows an error with Try again, which recovers; the rest of the page still works', async ({ browser, baseURL }) => {
  let fail = true
  const { ctx, page } = await open(browser, undefined, {
    data: PRICED_AND_UNPRICED,
    handler: () => (fail ? { status: 500, json: { code: 'internal_error' } } : null),
  })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await expect(tile.getByRole('alert')).toContainText('Couldn’t load web search usage')
  await expect(page.getByRole('main').getByRole('tab', { name: 'By resource' })).toBeVisible()
  fail = false
  await tile.getByRole('button', { name: 'Try again' }).click()
  await expect(tile.getByTestId('web-search-calls')).toHaveText('12')
  await ctx.close()
})

test('the period picker drives the tile query', async ({ browser, baseURL }) => {
  const { ctx, page, seen } = await open(browser, undefined, { data: EMPTY })
  await page.goto(`${baseURL}/#/costs`)
  await expect(tileOf(page).getByText('No web searches in this period')).toBeVisible()
  await page.getByRole('button', { name: 'Last 7 days' }).click()
  await expect.poll(() => seen.gets.at(-1).searchParams.get('from')).toBe('2026-11-12')
  expect(seen.gets.at(-1).searchParams.get('to')).toBe('2026-11-18')
  await ctx.close()
})

test('the price editor: save a provider price, clear one, refuse bad input, report a failed save', async ({ browser, baseURL }) => {
  const { ctx, page, seen } = await open(browser, undefined, { data: PRICED_AND_UNPRICED })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await expect(tile.getByText('Applies to future calls; unpriced calls are estimated at the current price.')).toBeVisible()
  const brave = tile.getByRole('textbox', { name: 'brave: price per 1,000 calls (USD)' })
  await brave.fill('7,5')
  await tile.getByTestId('price-row-web_search:brave').getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => seen.puts.length).toBe(1)
  expect(seen.puts[0]).toEqual({ key: 'web_search:brave', body: { per1kUsd: 7.5 } })
  await expect(tile.getByTestId('price-row-web_search:brave').getByRole('status')).toHaveText('Saved')

  // the kind-wide price had an override (2): blank it → null
  const all = tile.getByRole('textbox', { name: 'All providers: price per 1,000 calls (USD)' })
  await expect(all).toHaveValue('2')
  await all.fill('')
  await tile.getByTestId('price-row-web_search').getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => seen.puts.length).toBe(2)
  expect(seen.puts[1]).toEqual({ key: 'web_search', body: { per1kUsd: null } })

  // bad input never reaches the server
  const dbx = tile.getByRole('textbox', { name: 'databricks: price per 1,000 calls (USD)' })
  await dbx.fill('1001')
  await tile.getByTestId('price-row-web_search:databricks').getByRole('button', { name: 'Save' }).click()
  await expect(tile.getByTestId('price-row-web_search:databricks').getByRole('status')).toContainText('Enter a number from 0 to 1000')
  expect(seen.puts.length).toBe(2)
  await ctx.close()
})

test('a failed price save says so and keeps the field', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, undefined, { data: PRICED_AND_UNPRICED, putStatus: 500 })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await tile.getByRole('textbox', { name: 'brave: price per 1,000 calls (USD)' }).fill('9')
  await tile.getByTestId('price-row-web_search:brave').getByRole('button', { name: 'Save' }).click()
  await expect(tile.getByTestId('price-row-web_search:brave').getByRole('status')).toContainText('Couldn’t save the price')
  await expect(tile.getByRole('textbox', { name: 'brave: price per 1,000 calls (USD)' })).toHaveValue('9')
  await ctx.close()
})

test('pt-BR: Portuguese copy and the decimal comma', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ ...contextOptions({ theme: 'light' }), locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
  await ctx.clock.setFixedTime(NOW)
  const page = await ctx.newPage()
  await page.route('**/api/costs**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/costs/meta') return route.fulfill({ json: META })
    return route.fulfill({ json: { by: 'resource', period: META.defaultPeriod, currency: 'USD', rows: [], totals: { usd: 0, dbus: 0 } } })
  })
  await routeToolUsage(page, { data: PRICED_AND_UNPRICED })
  await page.goto(`${baseURL}/#/costs`)
  const tile = tileOf(page)
  await expect(tile.getByRole('heading', { name: 'Busca na web', level: 2 })).toBeVisible()
  await expect(tile.getByTestId('web-search-unpriced-note')).toContainText('4 chamadas estão sem preço')
  await expect(tile.getByTestId('web-search-cost')).toHaveText(/US\$\s0,04/)
  await ctx.close()
})

for (const v of VARIANTS) {
  test(`web-search tile: no serious/critical axe finding (${variantName(v)})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, v, { data: PRICED_AND_UNPRICED })
    await page.goto(`${baseURL}/#/costs`)
    const tile = tileOf(page)
    await expect(tile.getByTestId('web-search-calls')).toHaveText('12')
    await page.waitForTimeout(600) // chart entry animation
    const res = await new AxeBuilder({ page }).include('[data-testid="web-search-tile"]').withTags(AXE_TAGS).analyze()
    expect(seriousOrCritical(res)).toEqual([])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await ctx.close()
  })
}
