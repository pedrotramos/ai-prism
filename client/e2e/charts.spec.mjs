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

// Readiness for the four blocks, read in ONE browser task (Recharts re-mounts
// marks during its entrance animation): the pivot table rows, the 5 heatmap
// cells painted with resolved token colours (not the pre-resolve var()
// fallback), the 5 scatter symbols and the 4 histogram bars painted.
async function chartsRendered(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const q = (k) => document.querySelector(`[data-chart-type="${k}"]`)
          const painted = (els) => els.filter((e) => { const f = getComputedStyle(e).fill; return f && f !== 'none' }).length
          const heat = [...(q('heatmap')?.querySelectorAll('[data-heat-cell][data-empty="false"]') || [])]
          return {
            pivotRows: q('pivot')?.querySelectorAll('tbody tr').length || 0,
            heatResolved: heat.filter((e) => /^#[0-9a-f]{6}$/i.test(e.getAttribute('fill') || '')).length,
            scatter: painted([...(q('scatter')?.querySelectorAll('.recharts-scatter-symbol path') || [])]),
            bars: painted([...(q('histogram')?.querySelectorAll('.recharts-bar-rectangle path') || [])]),
          }
        }),
      { message: 'all four analysis blocks rendered and painted', timeout: 15_000 }
    )
    .toEqual({ pivotRows: 3, heatResolved: 5, scatter: 5, bars: 4 })
}

async function openAnalysis(browser, variant, blocks = BLOCKS, ready = '[data-chart-type="histogram"]') {
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
      content: 'Análise:\n\n' + blocks.map((_, i) => `{{block:${i}}}`).join('\n\n'),
      attachments: null,
      model: MODEL,
      prompt_tokens: 120,
      completion_tokens: 80,
      blocks,
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
  await page.locator(ready).waitFor({ timeout: 15_000 })
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

  // the Table tab works for the new kinds too
  await scatter.getByRole('tab', { name: 'Table' }).click()
  await expect(scatter.getByRole('columnheader', { name: 'Receita' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the analysis blocks have no serious or critical axe violations (both themes)', async ({ browser }) => {
  for (const variant of [{ theme: 'dark', mobile: false }, { theme: 'light', mobile: true }]) {
    const { ctx, page, errors } = await openAnalysis(browser, variant)
    await chartsRendered(page)
    const res = await new AxeBuilder({ page }).include('[data-block="chart"]').withTags(AXE_TAGS).analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)
    expect(bad, variant.theme).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  }
})

// ---- W2-1: the block frame, the chart type switch (Q15-A), the artifact cards
// and the elicitation chips.

const ONE_SERIES = (values) => [{ name: 'Receita', data: values.map((value, i) => ({ label: `L${i + 1}`, value })) }]

// computes a button's colours against a probe set to the ink action tokens
const inkColors = (button) => {
  const probe = document.createElement('button')
  probe.style.backgroundColor = 'var(--action)'
  probe.style.color = 'var(--on-action)'
  document.body.append(probe)
  const e = getComputedStyle(probe)
  const a = getComputedStyle(button)
  const r = { bg: a.backgroundColor, actionBg: e.backgroundColor, fg: a.color, onAction: e.color }
  probe.remove()
  return r
}

test('the chart type switch offers only kinds the data fits, switching back and forth loses nothing, and the Table tab shows the same rows', async ({ browser }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`/#/chat/${ids.s1}`)
  const chart = page.locator('[data-block="chart"]').first()
  await chart.waitFor({ timeout: 15_000 })

  // two series of four regions: bar, line, area and the table; no pie (it would drop a series),
  // no waterfall, no "more types", no "ask for data"
  const tabs = chart.getByRole('tablist', { name: 'Chart view' }).getByRole('tab')
  await expect(tabs).toHaveText(['Bar', 'Line', 'Area', 'Table'])
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(chart.getByText(/waterfall|more types|ask for data|cascata/i)).toHaveCount(0)

  const bars = () => chart.evaluate((c) => c.querySelectorAll('.recharts-bar-rectangle').length)
  await expect.poll(bars, { timeout: 10_000 }).toBe(8)
  const tableCells = async () => {
    await chart.getByRole('tab', { name: 'Table' }).click()
    await expect(chart.getByRole('cell', { name: 'North America' })).toBeVisible()
    return chart.locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent)))
  }

  await chart.getByRole('tab', { name: 'Line' }).click()
  await expect(chart.locator('[role="img"]')).toHaveAttribute('aria-label', /^Line chart: Revenue by region/)
  await expect.poll(() => chart.evaluate((c) => c.querySelectorAll('.recharts-line-curve').length), { timeout: 10_000 }).toBe(2)
  await chart.getByRole('tab', { name: 'Area' }).click()
  await expect(chart.locator('[role="img"]')).toHaveAttribute('aria-label', /^Area chart: /)

  // the Table tab holds exactly the block's rows, whichever kind it was reached from
  const fromArea = await tableCells()
  expect(fromArea).toEqual([
    ['North America', '41.2', '41.5'],
    ['EMEA', '27.9', '30.6'],
    ['LATAM', '12.4', '15'],
    ['APAC', '18.1', '17'],
  ])
  await expect(chart.getByRole('columnheader', { name: 'Q3' })).toBeVisible()
  // a table has nothing to export as an image
  await expect(chart.locator('[data-block-footer]')).toHaveCount(0)

  // and back: the same data draws the same eight bars, in the same two colours
  await chart.getByRole('tab', { name: 'Bar' }).click()
  await expect.poll(bars, { timeout: 10_000 }).toBe(8)
  const fills = await chart.evaluate((c) => [...new Set([...c.querySelectorAll('.recharts-bar-rectangle path')].map((e) => getComputedStyle(e).fill))])
  expect(fills.length).toBe(2)
  expect(await tableCells()).toEqual(fromArea)
  expect(errors).toEqual([])
  await ctx.close()
})

test('the chart switch is a tab list: arrows, Home and End move and select, one tab stop', async ({ browser }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await page.goto(`/#/chat/${ids.s1}`)
  const chart = page.locator('[data-block="chart"]').first()
  await chart.waitFor({ timeout: 15_000 })
  const bar = chart.getByRole('tab', { name: 'Bar' })
  const line = chart.getByRole('tab', { name: 'Line' })
  const table = chart.getByRole('tab', { name: 'Table' })
  await bar.focus()
  await page.keyboard.press('ArrowRight')
  await expect(line).toBeFocused()
  await expect(line).toHaveAttribute('aria-selected', 'true')
  await expect(chart.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await line.getAttribute('id'))
  await page.keyboard.press('End')
  await expect(table).toBeFocused()
  await expect(table).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(bar).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(table).toBeFocused()
  // only the selected tab is in the tab order
  await expect(bar).toHaveAttribute('tabindex', '-1')
  await expect(table).toHaveAttribute('tabindex', '0')
  await ctx.close()
})

test('a pie is offered for one non-negative series and only then; a pivot switches to a heatmap and back', async ({ browser }) => {
  const blocks = [
    { type: 'chart', chartType: 'bar', title: 'Shares', series: ONE_SERIES([30, 50, 20]) },
    { type: 'chart', chartType: 'bar', title: 'Deltas', series: ONE_SERIES([30, -5, 20]) },
    { type: 'chart', chartType: 'pivot', title: 'Matrix', rowLabel: 'Região', colLabel: 'Canal', valueLabel: 'Receita', series: PIVOT },
  ]
  const { ctx, page, errors } = await openAnalysis(browser, { theme: 'light', mobile: false }, blocks, '[data-chart-type="pivot"]')
  const names = (title) => page.locator('[data-block="chart"]', { hasText: title }).getByRole('tab')
  await expect(names('Shares')).toHaveText(['Bar', 'Line', 'Area', 'Pie', 'Table'])
  await expect(names('Deltas')).toHaveText(['Bar', 'Line', 'Area', 'Table'])
  await expect(names('Matrix')).toHaveText(['Heatmap', 'Pivot table'])

  const shares = page.locator('[data-block="chart"]', { hasText: 'Shares' })
  await shares.getByRole('tab', { name: 'Pie' }).click()
  await expect.poll(() => shares.evaluate((c) => c.querySelectorAll('.recharts-pie-sector').length), { timeout: 10_000 }).toBe(3)

  // the pivot keeps its own kind until the reader picks the heatmap; the data is the same matrix
  const matrix = page.locator('[data-block="chart"]', { hasText: 'Matrix' })
  await expect(matrix.getByRole('tab', { name: 'Pivot table' })).toHaveAttribute('aria-selected', 'true')
  await expect(matrix.getByRole('cell', { name: '1,000' })).toBeVisible()
  await matrix.getByRole('tab', { name: 'Heatmap' }).click()
  await expect(matrix.locator('[data-heat-cell]')).toHaveCount(6)
  await matrix.getByRole('tab', { name: 'Pivot table' }).click()
  await expect(matrix.getByRole('cell', { name: '1,000' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the chart footer carries the PNG export and no provenance line the block cannot back', async ({ browser }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  await ctx.grantPermissions([])
  const page = await ctx.newPage()
  await page.goto(`/#/chat/${ids.s1}`)
  const chart = page.locator('[data-block="chart"]').first()
  await chart.waitFor({ timeout: 15_000 })
  // the model's own caption is the subtitle
  await expect(chart.locator('[data-block-subtitle]')).toHaveText('Source: main.sales.fct_revenue')
  const footer = chart.locator('[data-block-footer]')
  await expect(footer.getByRole('button', { name: 'Export as image (PNG)' })).toBeVisible()
  // a chart block holds no link to the tool call behind it: nothing claims "calculated with Python"
  await expect(footer).not.toContainText(/python|calculated|computed/i)
  await expect(chart.getByRole('link')).toHaveCount(0)
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), footer.getByRole('button', { name: 'Export as image (PNG)' }).click()])
  expect(download.suggestedFilename()).toMatch(/^Revenue_by_region.*\.png$/)
  await ctx.close()
})

test('hostile cell, label and series text is shown as text in the table, pivot and chart table (never HTML)', async ({ browser }) => {
  const HOSTILE = '<img src="x" onerror="window.__pwned=1"><script>window.__pwned=2</script>'
  const blocks = [
    { type: 'table', title: HOSTILE, columns: [HOSTILE, 'b'], rows: [[HOSTILE, '<b>bold</b>'], ['a', null]] },
    {
      type: 'chart',
      chartType: 'pivot',
      title: 'Hostile pivot',
      rowLabel: HOSTILE,
      colLabel: 'c',
      series: [{ name: HOSTILE, data: [{ label: HOSTILE, value: 1 }, { label: '<b>x</b>', value: 2 }] }],
    },
    { type: 'chart', chartType: 'bar', title: 'Hostile bar', series: [{ name: HOSTILE, data: [{ label: HOSTILE, value: 1 }, { label: '<b>x</b>', value: 2 }] }] },
  ]
  const { ctx, page, errors } = await openAnalysis(browser, { theme: 'dark', mobile: false }, blocks, '[data-chart-type="bar"]')
  const table = page.locator('[data-block="table"]')
  await expect(table.getByRole('cell', { name: '<b>bold</b>' })).toBeVisible()
  await expect(table.getByRole('columnheader', { name: HOSTILE })).toBeVisible()
  await expect(page.locator('[data-block="chart"]', { hasText: 'Hostile pivot' }).getByRole('rowheader', { name: '<b>x</b>' })).toBeVisible()
  const bar = page.locator('[data-block="chart"]', { hasText: 'Hostile bar' })
  await bar.getByRole('tab', { name: 'Table' }).click()
  await expect(bar.getByRole('cell', { name: HOSTILE })).toBeVisible()
  // nothing was parsed: no element came out of the text, and no handler ran
  await expect(page.locator('[data-block] img, [data-block] script, [data-block] b')).toHaveCount(0)
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the elicitation chips are keyboard-operable, the answers are persisted, and Continue is the ink action', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const ctx = await newVariantContext(browser, { theme, mobile: false })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    let persisted = null
    await page.route(`**/api/sessions/${ids.s1}/messages/62/question-answers`, async (route) => {
      persisted = route.request().postDataJSON()
      const body = sessionBody(ids.s1)
      const dq = body.messages.find((m) => m.id === '62' || m.id === 62).blocks[0]
      await route.fulfill({ json: { blocks: [{ ...dq, answers: persisted.answers }] } })
    })
    await page.goto(`/#/chat/${ids.s1}`)
    const box = page.locator('[data-block="deck-questions"]')
    await box.waitFor({ timeout: 15_000 })

    // single choice: a radio group with one tab stop; Space picks, arrows move and pick
    const aud = box.getByRole('radiogroup', { name: 'Who is the audience?' })
    const board = aud.getByRole('radio', { name: 'Board of directors' })
    await board.focus()
    await page.keyboard.press('Space')
    await expect(board).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowRight')
    const exec = aud.getByRole('radio', { name: 'Executive team' })
    await expect(exec).toBeFocused()
    await expect(exec).toHaveAttribute('aria-checked', 'true')
    await expect(board).toHaveAttribute('aria-checked', 'false')
    await expect(aud.getByRole('radio', { name: 'Regional leads' })).toHaveAttribute('tabindex', '-1')

    // multiple choice: checkboxes, each one a tab stop
    const inc = box.getByRole('group', { name: 'What should it include?' })
    await inc.getByRole('checkbox', { name: 'Risks' }).focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Space')
    await expect(inc.getByRole('checkbox', { name: 'Risks' })).toHaveAttribute('aria-checked', 'true')
    await expect(inc.getByRole('checkbox', { name: 'Appendix with raw data' })).toHaveAttribute('aria-checked', 'true')
    await box.getByRole('textbox', { name: 'Anything else to emphasize?' }).fill('Keep it short')

    const go = box.getByRole('button', { name: 'Continue' })
    const colors = await go.evaluate(inkColors)
    expect(colors.bg, `${theme} ${JSON.stringify(colors)}`).toBe(colors.actionBg)
    expect(colors.fg, `${theme} ${JSON.stringify(colors)}`).toBe(colors.onAction)

    await go.click()
    await expect.poll(() => persisted, { message: 'answers posted to the block', timeout: 10_000 }).not.toBeNull()
    expect(persisted.answers).toEqual({ aud: 'Executive team', inc: ['Risks', 'Appendix with raw data'], note: 'Keep it short' })
    // the answered state is the read-only summary of what was picked
    await expect(box.getByText('Answered questions')).toBeVisible()
    await expect(box.getByText('Executive team')).toBeVisible()
    expect(errors).toEqual([])
    await ctx.close()
  }
})

test('the artifact cards use the real deck thumbnail or the kind icon, and the Open action is the ink action', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const ctx = await newVariantContext(browser, { theme, mobile: false })
    const page = await ctx.newPage()
    await page.goto(`/#/chat/${ids.s1}`)
    const deck = page.locator('[data-artifact-card="deck"]').first()
    await deck.waitFor({ timeout: 15_000 })
    // the deck shows its first slide, rendered from the deck's own HTML
    await expect(deck.locator('[data-card-thumb] iframe')).toHaveCount(1)
    for (const kind of ['spreadsheet', 'document']) {
      const card = page.locator(`[data-artifact-card="${kind}"]`).first()
      // no thumbnail is faked for a kind that has no preview: its icon stands in
      await expect(card.locator('[data-card-thumb]')).toHaveCount(0)
      await expect(card.locator('svg').first()).toBeVisible()
    }
    for (const kind of ['deck', 'spreadsheet', 'document']) {
      const colors = await page.locator(`[data-artifact-card="${kind}"] [data-card-primary]`).first().evaluate(inkColors)
      expect(colors.bg, `${kind} ${theme} ${JSON.stringify(colors)}`).toBe(colors.actionBg)
      expect(colors.fg, `${kind} ${theme} ${JSON.stringify(colors)}`).toBe(colors.onAction)
    }
    await ctx.close()
  }
})

test('blocks stay inside the column on a phone and have no serious or critical axe violation (both themes)', async ({ browser }) => {
  for (const variant of [{ theme: 'light', mobile: true }, { theme: 'dark', mobile: false }]) {
    const ctx = await newVariantContext(browser, variant)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(`/#/chat/${ids.s1}`)
    await page.locator('[data-block="deck-questions"]').waitFor({ timeout: 15_000 })
    await page.locator('[data-artifact-card="deck"] iframe').first().waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-block="chart"] .recharts-bar-rectangle').count(), { timeout: 10_000 }).toBe(8)
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('[data-block], [data-artifact-card]')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.getAttribute('data-block') || e.getAttribute('data-artifact-card'))
    )
    expect(overflow, JSON.stringify(variant)).toEqual([])
    // axe on the chart in its table view as well as drawn
    for (const tab of ['Bar', 'Table']) {
      await page.locator('[data-block="chart"]').first().getByRole('tab', { name: tab }).click()
      const res = await new AxeBuilder({ page }).include('[data-block]').include('[data-artifact-card]').withTags(AXE_TAGS).analyze()
      const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)
      expect(bad, `${variant.theme} ${tab}`).toEqual([])
    }
    expect(errors).toEqual([])
    await ctx.close()
  }
})
