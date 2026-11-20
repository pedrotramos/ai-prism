// Fixtures of the web-search cost tile (GET /api/admin/usage/tools and
// PUT /api/admin/tool-prices/:key), answered with page.route: no backend. Shared by
// costs.spec.mjs (the tile there is just empty) and web-search-cost.spec.mjs.

export const PERIOD = { from: '2026-10-20', to: '2026-11-18' }

export const EMPTY = {
  kind: 'web_search',
  period: PERIOD,
  totals: { calls: 0, pricedCalls: 0, unpricedCalls: 0, costUsd: 0 },
  byDay: [],
  byProvider: [],
  topUsers: [],
  prices: { web_search: null },
}

// 12 calls: 8 priced by brave ($5 per 1,000), 4 through the managed provider with no price
export const PRICED_AND_UNPRICED = {
  kind: 'web_search',
  period: PERIOD,
  totals: { calls: 12, pricedCalls: 8, unpricedCalls: 4, costUsd: 0.04 },
  byDay: [
    { day: '2026-11-16', calls: 5, unpricedCalls: 2, costUsd: 0.015 },
    { day: '2026-11-17', calls: 7, unpricedCalls: 2, costUsd: 0.025 },
  ],
  byProvider: [
    { provider: 'brave', calls: 8, unpricedCalls: 0, costUsd: 0.04, pricePer1k: 5, estimatedUnpricedUsd: 0 },
    { provider: 'databricks', calls: 4, unpricedCalls: 4, costUsd: 0, pricePer1k: 2, estimatedUnpricedUsd: 0.008 },
  ],
  topUsers: [
    { userHash: 'h2:3f9a1c0b77de', calls: 9, costUsd: 0.03 },
    { userHash: 'h2:a1b2c3d4e5f6', calls: 3, costUsd: 0.01 },
  ],
  prices: { web_search: 2, 'web_search:brave': null, 'web_search:databricks': null },
}

export const ALL_PRICED = {
  ...PRICED_AND_UNPRICED,
  totals: { calls: 8, pricedCalls: 8, unpricedCalls: 0, costUsd: 0.04 },
  byProvider: [PRICED_AND_UNPRICED.byProvider[0]],
  prices: { web_search: null, 'web_search:brave': 5 },
}

/**
 * Routes the tile's two endpoints. `handler(url)` may return { status, json, delayMs }
 * for the GET; the PUTs are recorded in the returned `puts` (and answered { ok: true },
 * or with `putStatus`).
 */
export async function routeToolUsage(page, { data = EMPTY, handler = () => null, putStatus = 200 } = {}) {
  const gets = []
  const puts = []
  await page.route('**/api/admin/usage/tools**', async (route) => {
    const url = new URL(route.request().url())
    gets.push(url)
    const custom = handler(url)
    if (custom?.delayMs) await new Promise((r) => setTimeout(r, custom.delayMs))
    if (custom?.status) return route.fulfill({ status: custom.status, json: custom.json ?? {} })
    return route.fulfill({ json: custom?.json ?? data })
  })
  await page.route('**/api/admin/tool-prices/**', async (route) => {
    const req = route.request()
    puts.push({ key: decodeURIComponent(new URL(req.url()).pathname.split('/').pop()), body: req.postDataJSON() })
    return route.fulfill({ status: putStatus, json: putStatus === 200 ? { ok: true } : { code: 'internal_error' } })
  })
  return { gets, puts }
}
