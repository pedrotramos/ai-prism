// Analysis kinds in the chat (W2-9): a pivot table, a heatmap, a scatter and a
// histogram rendered from chart blocks, coloured from the theme tokens, each
// with a text alternative and no serious axe violation. Served with page.route
// so the recorded fixtures stay untouched.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, AXE_TAGS } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model

const PIVOT = [
  { name: 'Loja', data: [{ label: 'Sul', value: 120 }, { label: 'Norte', value: 80 }, { label: 'Sudeste', value: 300 }] },
  { name: 'Online', data: [{ label: 'Sul', value: 90 }, { label: 'Norte', value: null }, { label: 'Sudeste', value: 410 }] },
]
const BLOCKS = [
  { type: 'chart', chartType: 'pivot', title: 'Receita por região e canal', rowLabel: 'Região', colLabel: 'Canal', valueLabel: 'Receita', series: PIVOT },
  { type: 'chart', chartType: 'heatmap', title: 'Intensidade de receita', rowLabel: 'Região', colLabel: 'Canal', valueLabel: 'Receita', series: PIVOT },
  {
    type: 'chart',
    chartType: 'scatter',
    title: 'Pedidos vs receita',
    xLabel: 'Receita',
    yLabel: 'Pedidos',
    series: [
      { name: 'Sul', data: [{ label: '', x: 10, y: 2 }, { label: '', x: 20, y: 5 }, { label: '', x: 30, y: 6 }] },
      { name: 'Norte', data: [{ label: '', x: 12, y: 1 }, { label: '', x: 25, y: 3 }] },
    ],
  },
  { type: 'chart', chartType: 'histogram', title: 'Distribuição de receita', series: [{ name: 'Receita', data: [{ label: '0–10', value: 3 }, { label: '10–20', value: 7 }, { label: '20–30', value: 4 }, { label: '30–40', value: 1 }] }] },
]

async function openAnalysis(browser, variant) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const body = sessionBody(ids.s3)
  body.messages = [
    body.messages[0],
    {
      id: '9001',
      role: 'assistant',
      content: 'Análise:\n\n{{block:0}}\n\n{{block:1}}\n\n{{block:2}}\n\n{{block:3}}',
      attachments: null,
      model: MODEL,
      prompt_tokens: 120,
      completion_tokens: 80,
      blocks: BLOCKS,
      tool_calls: null,
      created_at: '2026-11-17T07:09:00.000Z',
      media_processing: null,
      intent_classify: null,
      reasoning: null,
    },
  ]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  )
  await page.goto(`/#/chat/${ids.s3}`)
  await page.locator('[data-chart-type="histogram"]').waitFor({ timeout: 15_000 })
  return { ctx, page, errors }
}

test('the four analysis kinds render with text alternatives and token colours', async ({ browser }) => {
  const { ctx, page, errors } = await openAnalysis(browser, { theme: 'dark', mobile: false })

  // pivot: a real table with row/column headers, totals and an em dash for the empty cell
  const pivot = page.locator('[data-chart-type="pivot"]')
  await expect(pivot.getByRole('table')).toBeVisible()
  await expect(pivot.getByRole('columnheader', { name: 'Online' })).toBeVisible()
  await expect(pivot.getByRole('rowheader', { name: 'Sudeste' })).toBeVisible()
  await expect(pivot.getByRole('cell', { name: '—' })).toHaveCount(1)
  await expect(pivot.getByRole('cell', { name: '710' })).toBeVisible() // Sudeste total
  await expect(pivot.getByRole('cell', { name: '1,000' })).toBeVisible() // grand total

  // heatmap: one shaded cell per row x column, labelled for assistive tech
  const heat = page.locator('[data-chart-type="heatmap"]')
  await expect(heat.locator('[role="img"]')).toHaveAttribute('aria-label', /Intensidade de receita/)
  const cells = heat.locator('[data-heat-cell]')
  await expect(cells).toHaveCount(6)
  const fills = await cells.evaluateAll((els) => els.map((e) => e.getAttribute('fill')))
  expect(new Set(fills.filter(Boolean)).size).toBeGreaterThan(2)
  // the empty cell is not painted as a low value
  await expect(heat.locator('[data-heat-cell][data-empty="true"]')).toHaveCount(1)

  // scatter: one dot per point, two groups in two colours
  const scatter = page.locator('[data-chart-type="scatter"]')
  await expect(scatter.locator('[role="img"]')).toHaveAttribute('aria-label', /Pedidos vs receita/)
  await expect
    .poll(() => scatter.evaluate((c) => c.querySelectorAll('.recharts-scatter-symbol').length), { timeout: 10_000 })
    .toBe(5)
  const dotFills = await scatter.evaluate((c) => [...new Set([...c.querySelectorAll('.recharts-scatter-symbol path')].map((e) => getComputedStyle(e).fill))])
  expect(dotFills.length).toBe(2)
  expect(dotFills).not.toContain('rgb(0, 0, 0)')

  // histogram: contiguous bars, one per bin
  const hist = page.locator('[data-chart-type="histogram"]')
  await expect
    .poll(() => hist.evaluate((c) => c.querySelectorAll('.recharts-bar-rectangle').length), { timeout: 10_000 })
    .toBe(4)
  await expect(hist.locator('[role="img"]')).toHaveAttribute('aria-label', /Histogram/)

  // View data works for the new kinds too
  await scatter.getByRole('button', { name: 'View data' }).click()
  await expect(scatter.getByRole('columnheader', { name: 'Receita' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the analysis blocks have no serious or critical axe violations (both themes)', async ({ browser }) => {
  for (const variant of [{ theme: 'dark', mobile: false }, { theme: 'light', mobile: true }]) {
    const { ctx, page, errors } = await openAnalysis(browser, variant)
    await page.waitForTimeout(1200)
    const res = await new AxeBuilder({ page }).include('[data-block="chart"]').withTags(AXE_TAGS).analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)
    expect(bad, variant.theme).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  }
})
