import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const blocks = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const sheetBlock = blocks.find((b) => b.type === 'spreadsheet')
const SHEET = {
  id: ids.sheet,
  title: sheetBlock.title,
  sheets: [
    ...sheetBlock.sheets,
    { name: 'Analise', blocks: [{ kind: 'title', text: 'Analise' }, { kind: 'table', columns: [{ header: 'Ticket' }, { header: 'Margem' }, { header: 'Custo' }], rows: [[10, 2, 4], [20, 5, 6], [30, 7, 9]] }] },
  ],
}

async function openSheet(browser, baseURL) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  await ctx.route(`**/api/spreadsheets/${ids.sheet}`, (route) => route.fulfill({ json: { spreadsheet: SHEET } }))
  await ctx.route('**/api/deck-templates/selected', (route) => route.fulfill({ json: { template: null } }))
  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.getByText('Open in Slides Studio').first().waitFor()
  await page.getByRole('button', { name: 'Open studio' }).first().click()
  const root = page.locator('[data-studio="sheet"]')
  await root.locator('[data-ds-paper]').waitFor()
  return { ctx, page, root, grid: root.locator('[data-ds-paper]'), quick: root.locator('[data-quick-actions]') }
}

test('keyboard can select a sheet cell and expose the selection actions', async ({ browser, baseURL }) => {
  const { ctx, page, grid, quick } = await openSheet(browser, baseURL)
  try {
    await grid.focus()
    await page.keyboard.press('ArrowRight')
    await expect(quick).toBeVisible()
    await expect(quick.getByRole('button', { name: 'Ask AI' })).toBeVisible()
  } finally {
    await ctx.close()
  }
})

test('Escape dismisses sheet quick actions and restores focus to the grid', async ({ browser, baseURL }) => {
  const { ctx, page, root, grid, quick } = await openSheet(browser, baseURL)
  try {
    await root.locator('[data-rc="5-1"]').click()
    await expect(quick).toBeVisible()
    await quick.getByRole('button', { name: 'Ask AI' }).focus()
    await page.keyboard.press('Escape')
    await expect(quick).toHaveCount(0)
    await expect(grid).toBeFocused()
  } finally {
    await ctx.close()
  }
})

test('sheet quick actions remain adjacent to the selected range', async ({ browser, baseURL }) => {
  const { ctx, page, root, quick } = await openSheet(browser, baseURL)
  try {
    const first = root.locator('[data-rc="5-1"]')
    const last = root.locator('[data-rc="6-2"]')
    await first.click()
    await last.click({ modifiers: ['Shift'] })
    await expect(quick).toBeVisible()
    const [a, b, toolbar] = await Promise.all([first.boundingBox(), last.boundingBox(), quick.boundingBox()])
    const selected = { top: a.y, bottom: b.y + b.height }
    const gap = toolbar.y > selected.bottom ? toolbar.y - selected.bottom : selected.top - (toolbar.y + toolbar.height)
    expect(gap, `selected range ends at ${selected.bottom}; toolbar starts at ${toolbar.y}`).toBeLessThanOrEqual(64)
  } finally {
    await ctx.close()
  }
})

test('sheet quick actions include Explain formula for a selected formula cell', async ({ browser, baseURL }) => {
  const { ctx, page, root, quick } = await openSheet(browser, baseURL)
  try {
    await root.locator('[data-rc="5-1"]').click()
    await expect(quick).toBeVisible()
    await expect(quick.getByRole('button', { name: 'Explain formula' })).toBeVisible()
  } finally {
    await ctx.close()
  }
})
