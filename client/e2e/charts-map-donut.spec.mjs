// Donut and map in the chat: a donut with its total in the hole and its legend, a choropleth
// drawn from the geo set the server serves (GET /api/geo/:id, answered here from the bundled
// set), the "Use in slides" action filling the composer, and no serious axe violation in both
// themes. Served with page.route so the recorded fixtures stay untouched.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, AXE_TAGS } from './lib.mjs'
import worldCountries from '../../shared/geo/worldCountries.ts'

const fx = loadFixtures()
const { ids } = fx
const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model

const COUNTRIES = [
  { label: 'Brasil', value: 420 },
  { label: 'Chile', value: 130 },
  { label: 'Argentina', value: 90 },
  { label: 'México', value: 250 },
]
const BLOCKS = [
  { type: 'chart', chartType: 'donut', title: 'Participação de receita por país', series: [{ name: 'Receita', data: COUNTRIES }] },
  { type: 'chart', chartType: 'map', geo: 'world-countries', title: 'Receita por país (mapa)', series: [{ name: 'Receita', data: COUNTRIES }] },
]

async function openChart(browser, variant) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const body = sessionBody(ids.s3)
  body.messages = [
    body.messages[0],
    {
      id: '9002',
      role: 'assistant',
      content: 'Receita:\n\n{{block:0}}\n\n{{block:1}}',
      attachments: null,
      model: MODEL,
      prompt_tokens: 100,
      completion_tokens: 60,
      blocks: BLOCKS,
      tool_calls: null,
      created_at: '2026-11-17T07:09:00.000Z',
      media_processing: null,
      intent_classify: null,
      reasoning: null,
    },
  ]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
  await page.route('**/api/geo/world-countries', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(worldCountries) }))
  await page.goto(`/#/chat/${ids.s3}`)
  await page.locator('[data-chart-type="map"] path[data-region]').first().waitFor({ timeout: 15_000 })
  return { ctx, page, errors }
}

test('a donut shows its total and shares, a map shades the regions that have a value', async ({ browser }) => {
  const { ctx, page, errors } = await openChart(browser, { theme: 'light', mobile: false })

  const donut = page.locator('[data-chart-type="donut"]')
  await expect(donut.locator('[role="img"]')).toHaveAttribute('aria-label', /Participação de receita por país/)
  // 4 slices, and the total (890) in the hole
  await expect.poll(() => donut.evaluate((c) => c.querySelectorAll('.recharts-pie-sector').length), { timeout: 10_000 }).toBe(4)
  await expect(donut.locator('svg text', { hasText: '890' })).toBeVisible()
  // the total sits in the hole: the middle of the text is the middle of the ring
  const off = await donut.evaluate((c) => {
    const box = (e) => e.getBoundingClientRect()
    const ring = [...c.querySelectorAll('.recharts-pie-sector')].map(box)
    const left = Math.min(...ring.map((r) => r.left))
    const right = Math.max(...ring.map((r) => r.right))
    const top = Math.min(...ring.map((r) => r.top))
    const bottom = Math.max(...ring.map((r) => r.bottom))
    const t = box([...c.querySelectorAll('svg text')].find((e) => e.textContent === '890'))
    return { dx: Math.abs((t.left + t.right) / 2 - (left + right) / 2), dy: Math.abs((t.top + t.bottom) / 2 - (top + bottom) / 2) }
  })
  expect(off.dx).toBeLessThan(4)
  expect(off.dy).toBeLessThan(24) // the caption sits under the total, so its middle is a little below the ring's
  await expect(donut.locator('svg text', { hasText: '47%' })).toBeVisible() // Brasil: 420 of 890

  // nothing of the donut is cut off: every label lies inside the chart's svg
  const cut = await donut.evaluate((c) => {
    const svg = c.querySelector('.recharts-wrapper > .recharts-surface').getBoundingClientRect()
    return [...c.querySelectorAll('.recharts-wrapper > .recharts-surface text')].filter((e) => {
      const r = e.getBoundingClientRect()
      return r.top < svg.top - 0.5 || r.bottom > svg.bottom + 0.5 || r.left < svg.left - 0.5 || r.right > svg.right + 0.5
    }).map((e) => e.textContent)
  })
  expect(cut).toEqual([])

  const map = page.locator('[data-chart-type="map"]')
  await expect(map.locator('[role="img"]')).toHaveAttribute('aria-label', /Receita por país/)
  const regions = await map.locator('path[data-region]').count()
  expect(regions).toBe(worldCountries.regions.length)
  // the four named countries carry a value-shaded fill; the rest sit on the empty surface
  const fills = await map.locator('path[data-region]').evaluateAll((els) => {
    const by = Object.fromEntries(els.map((e) => [e.getAttribute('data-region'), e.getAttribute('fill')]))
    return { br: by.BR, cl: by.CL, jp: by.JP }
  })
  expect(fills.br).toMatch(/^#[0-9a-f]{6}$/i)
  expect(fills.cl).toMatch(/^#[0-9a-f]{6}$/i)
  expect(fills.br).not.toBe(fills.cl) // 420 vs 130: two shades
  expect(fills.jp).toBe('var(--surface-3)')
  await expect(map.locator('path[data-region="BR"] title')).toHaveText(/Brazil: 420/)

  // View data lists the rows behind the map
  await map.getByRole('button', { name: 'View data' }).click()
  await expect(map.getByRole('cell', { name: 'Chile' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('"Use in slides" puts a deck request naming the chart in the composer', async ({ browser }) => {
  const { ctx, page, errors } = await openChart(browser, { theme: 'light', mobile: false })
  await page.locator('[data-chart-type="donut"]').getByRole('button', { name: 'Use in slides' }).click()
  const composer = page.locator('textarea').first()
  await expect(composer).toHaveValue(/Participação de receita por país/)
  await expect(composer).toBeFocused()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the donut and the map have no serious or critical axe violations (both themes)', async ({ browser }) => {
  for (const variant of [{ theme: 'dark', mobile: false }, { theme: 'light', mobile: true }]) {
    const { ctx, page, errors } = await openChart(browser, variant)
    await expect.poll(() => page.locator('[data-chart-type="donut"] .recharts-pie-sector').count(), { timeout: 10_000 }).toBe(4)
    // axe samples colours: let the entrance animations of the message finish first
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))))
    const res = await new AxeBuilder({ page }).include('[data-block="chart"]').withTags(AXE_TAGS).analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.html.slice(0, 120) + ' :: ' + (n.any[0]?.message || '')).join(' | ')}`)
    expect(bad, variant.theme).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  }
})
