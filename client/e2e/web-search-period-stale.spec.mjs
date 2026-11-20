// The web-search tile and a period change (QA round 1 of N2): while the query of the
// newly selected period is pending, the tile must not show the previous period's totals
// under the new period's dates, and a slow answer for a period that is no longer selected
// must never replace the current one.
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
  const seen = await routeToolUsage(page, tool)
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

test('an out-of-order answer for a period that is no longer selected is ignored', async ({ browser, baseURL }) => {
  // 30 days is slow and would say 12 calls; 7 days answers at once with an empty ledger
  const { ctx, page, seen } = await open(browser, {
    data: EMPTY,
    handler: (url) => (url.searchParams.get('from') === '2026-10-20' ? { delayMs: 3000, json: PRICED_AND_UNPRICED } : { json: EMPTY }),
  })
  try {
    await page.goto(`${baseURL}/#/costs`)
    const tile = page.getByTestId('web-search-tile')
    await expect.poll(() => seen.gets.length).toBe(1) // the slow 30-day query is on the wire
    await page.getByRole('button', { name: 'Last 7 days' }).click()
    await expect(tile.getByText('No web searches in this period')).toBeVisible()
    await page.waitForTimeout(3500) // the slow answer arrives now
    await expect(tile.getByText('No web searches in this period')).toBeVisible()
    await expect(tile.getByTestId('web-search-calls')).toHaveCount(0)
  } finally {
    await ctx.close()
  }
})
