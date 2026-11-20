// The web-search tile and a period change (QA round 1 of N2): while the query of the
// newly selected period is pending, the tile must not show the previous period's totals
// under the new period's dates, and the request of a period that is no longer selected is
// cancelled and its late answer never replaces the current one (held on a promise the test
// controls: no timers, the test waits for events).
import { test, expect } from '@playwright/test'
import { newVariantContext } from './lib.mjs'
import { EMPTY, PRICED_AND_UNPRICED, routeToolUsage } from './web-search-cost-fixtures.mjs'

const NOW = '2026-11-18T12:00:00Z'
const META = {
  breakdowns: ['resource', 'model', 'person', 'tag'],
  tagKeys: ['ai_prism_app'],
  defaultPeriod: { from: '2026-10-20', to: '2026-11-18' },
  maxDays: 366,
}

async function open(browser, tool) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  await ctx.clock.setFixedTime(NOW)
  const page = await ctx.newPage()
  await page.route('**/api/costs**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/costs/meta') return route.fulfill({ json: META })
    return route.fulfill({ json: { by: 'resource', period: META.defaultPeriod, currency: 'USD', rows: [], totals: { usd: 0, dbus: 0 } } })
  })
  const seen = tool ? await routeToolUsage(page, tool) : null // null: the test routes the tool endpoint itself
  return { ctx, page, seen }
}

test('changing period does not show prior totals under the selected period while the new query is pending', async ({ browser, baseURL }) => {
  const { ctx, page, seen } = await open(browser, {
    data: PRICED_AND_UNPRICED,
    handler: (url) => (url.searchParams.get('from') === '2026-11-12' ? { delayMs: 5000, json: EMPTY } : null),
  })
  try {
    await page.goto(`${baseURL}/#/costs`)
    const tile = page.getByTestId('web-search-tile')
    await expect(tile.getByTestId('web-search-calls')).toHaveText('12')
    await page.getByRole('button', { name: 'Last 7 days' }).click()
    await expect.poll(() => seen.gets.length).toBe(2)
    expect(await tile.getByTestId('web-search-calls').isVisible()).toBe(false)
    await expect(tile.getByRole('status').filter({ hasText: 'Loading web search usage' })).toBeVisible()
  } finally {
    await ctx.close()
  }
})

test('the answer of a deselected period is cancelled, and never renders when it finally arrives', async ({ browser, baseURL }) => {
  // Event-driven, no timers: the 30-day query is HELD on a promise the test controls. Switching to
  // 7 days must abort it (the guard: the browser reports the request as failed/aborted); then the held
  // response is released and its route settles, and the tile must still show the 7-day ledger only.
  const { ctx, page } = await open(browser, null)
  let release
  const held = new Promise((r) => (release = r))
  let settle
  const settled = new Promise((r) => (settle = r))
  let started
  const startedOld = new Promise((r) => (started = r))
  await page.route('**/api/admin/usage/tools**', async (route) => {
    const from = new URL(route.request().url()).searchParams.get('from')
    if (from !== '2026-10-20') return route.fulfill({ json: EMPTY })
    started()
    await held
    try {
      await route.fulfill({ json: PRICED_AND_UNPRICED }) // the old answer, 12 calls
      settle('fulfilled')
    } catch {
      settle('aborted') // the page had already cancelled the request
    }
  })
  const aborted = []
  page.on('requestfailed', (req) => {
    if (req.url().includes('from=2026-10-20')) aborted.push(req.failure()?.errorText)
  })
  try {
    await page.goto(`${baseURL}/#/costs`)
    await startedOld // the 30-day query is on the wire and held
    const tile = page.getByTestId('web-search-tile')
    await page.getByRole('button', { name: 'Last 7 days' }).click()
    await expect(tile.getByText('No web searches in this period')).toBeVisible()
    // the guard: the deselected period's request was cancelled by the page
    await expect.poll(() => aborted.length).toBe(1)
    expect(aborted[0]).toMatch(/ABORTED/i)
    release() // the old response is released now; wait for its route to settle (an event, not a timeout)
    await settled
    await expect(tile.getByText('No web searches in this period')).toBeVisible()
    await expect(tile.getByTestId('web-search-calls')).toHaveCount(0)
  } finally {
    release()
    await ctx.close()
  }
})
