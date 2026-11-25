import { test, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import { loadFixtures, newVariantContext } from './lib.mjs'
import { renderXlsx } from '../../server/xlsx-export.ts'
import { INSTRUCTIONS_SHEET_NAME } from '../../shared/sheetInstructions.js'

const { ids } = loadFixtures()
const SAVED = {
  id: ids.sheet,
  title: 'Saved workbook',
  sheets: [{ name: 'Dados', blocks: [{ kind: 'section', text: 'Header' }] }],
}
const PREVIEW = {
  ...SAVED,
  sheets: [{ name: INSTRUCTIONS_SHEET_NAME, blocks: [{ kind: 'section', text: 'Preview' }] }],
}

test('QA: footer follows the persisted workbook while an accepted preview save response is pending', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  let releasePatchResponse
  let signalPatchStarted
  const patchResponseGate = new Promise((resolve) => { releasePatchResponse = resolve })
  const patchStarted = new Promise((resolve) => { signalPatchStarted = resolve })
  let persistedXlsx = await renderXlsx(SAVED, null)
  const previewXlsx = await renderXlsx(PREVIEW, null)
  const downloadedName = async (bytes) => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    return workbook.worksheets.at(-1).name
  }

  try {
    await ctx.route(`**/api/spreadsheets/${ids.sheet}/tweak`, (route) => route.fulfill({ json: { spreadsheet: PREVIEW, model: 'test', usage: { prompt_tokens: 1 } } }))
    await ctx.route(`**/api/spreadsheets/${ids.sheet}/export`, (route) => route.fulfill({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: persistedXlsx,
    }))
    await ctx.route(`**/api/spreadsheets/${ids.sheet}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        // Model the server's successful updateSpreadsheet before its PATCH response reaches the client.
        persistedXlsx = previewXlsx
        signalPatchStarted()
        await patchResponseGate
        return route.fulfill({ json: { spreadsheet: PREVIEW } })
      }
      return route.fulfill({ json: { spreadsheet: SAVED } })
    })

    const page = await ctx.newPage()
    await page.goto(`${baseURL}/#/chat/${ids.s1}`)
    await page.getByRole('button', { name: 'Open studio' }).first().waitFor()
    await page.getByRole('button', { name: 'Open studio' }).first().click()
    const root = page.locator('[data-studio="sheet"]')
    await root.waitFor()

    const panel = root.locator('[data-studio-ai-panel]')
    await panel.getByRole('textbox').fill('rename the sheet')
    await panel.getByRole('button', { name: /Apply/ }).click()
    await expect(panel.getByRole('button', { name: 'Accept & save' })).toBeVisible()
    await panel.getByRole('button', { name: 'Accept & save' }).click()
    await patchStarted

    const note = root.getByText('The color legend and fill instructions are on the')
    const downloadPromise = page.waitForEvent('download')
    await root.locator('[data-studio-export]').click()
    await page.getByRole('menuitem', { name: /Excel workbook/ }).click()
    await downloadPromise
    expect(await note.locator('span').textContent()).toBe(await downloadedName(persistedXlsx))
  } finally {
    releasePatchResponse?.()
    await ctx.close()
  }
})
