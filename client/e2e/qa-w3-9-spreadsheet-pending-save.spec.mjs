import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const { ids } = loadFixtures()
const blocks = JSON.parse(loadFixtures().routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const sheetBlock = blocks.find((b) => b.type === 'spreadsheet')
const sheet = { id: ids.sheet, title: sheetBlock.title, sheets: sheetBlock.sheets }
const otherChat = 'Fix flaky pytest in ingestion job'

test('spreadsheet: a failed accepted edit remains available when the user changes chats', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  let patchCount = 0
  await ctx.route(`**/api/spreadsheets/${ids.sheet}/tweak`, (route) =>
    route.fulfill({ json: { spreadsheet: { ...sheet, title: `${sheet.title} revised` }, model: 'test-model' } }))
  await ctx.route(`**/api/spreadsheets/${ids.sheet}`, (route) => {
    if (route.request().method() === 'PATCH') {
      patchCount++
      return route.fulfill({ status: 500, json: { error: 'save failed' } })
    }
    return route.fulfill({ json: { spreadsheet: sheet } })
  })

  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open studio', exact: true }).click()
  const studio = page.locator('[data-studio="sheet"]')
  await expect(studio).toBeVisible()
  const panel = studio.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Change the workbook title')
  await panel.getByRole('button', { name: /Apply/ }).click()
  await expect(panel.getByRole('button', { name: 'Accept & save' })).toBeVisible()
  await panel.getByRole('button', { name: 'Accept & save' }).click()
  await expect.poll(() => patchCount).toBe(1)
  await expect(studio.getByRole('status')).toHaveAttribute('data-save-status', 'error')
  await expect(studio.getByRole('button', { name: 'Retry' })).toBeVisible()

  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.isVisible()) await expand.click()
  await page.getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: otherChat, exact: true }).click()

  // A failed accepted edit is still unsaved, so leaving must be refused until it is saved or explicitly discarded.
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  await expect(studio.getByRole('button', { name: 'Retry' })).toBeVisible()
  await ctx.close()
})
