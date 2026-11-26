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

test('QA: Export waits for an in-flight save, then the footer matches the downloaded workbook', async ({ browser, baseURL }) => {
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
    // mid-save the stored workbook may already be the new one, so Export cannot be used (and says why)
    const exportBtn = root.locator('[data-studio-export]')
    await expect(exportBtn).toBeDisabled()
    await expect(exportBtn).toHaveAttribute('title', /Saving your changes/)
    releasePatchResponse()
    await expect(exportBtn).toBeEnabled()
    await expect(exportBtn).not.toHaveAttribute('title', /.+/)
    const downloadPromise = page.waitForEvent('download')
    await exportBtn.click()
    await page.getByRole('menuitem', { name: /Excel workbook/ }).click()
    await downloadPromise
    expect(await note.locator('span').textContent()).toBe(await downloadedName(persistedXlsx))
  } finally {
    releasePatchResponse?.()
    await ctx.close()
  }
})

test('Export stays disabled while retrying a failed spreadsheet save', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  let releaseRetryResponse
  let signalRetryStarted
  const retryResponseGate = new Promise((resolve) => { releaseRetryResponse = resolve })
  const retryStarted = new Promise((resolve) => { signalRetryStarted = resolve })
  let patchAttempts = 0
  const persistedXlsx = await renderXlsx(SAVED, null)
  const previewXlsx = await renderXlsx(PREVIEW, null)

  try {
    await ctx.route(`**/api/spreadsheets/${ids.sheet}/tweak`, (route) => route.fulfill({ json: { spreadsheet: PREVIEW, model: 'test', usage: { prompt_tokens: 1 } } }))
    await ctx.route(`**/api/spreadsheets/${ids.sheet}/export`, (route) => route.fulfill({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: persistedXlsx,
    }))
    await ctx.route(`**/api/spreadsheets/${ids.sheet}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        patchAttempts += 1
        if (patchAttempts === 1) return route.fulfill({ status: 500, json: { error: 'save failed' } })
        // Model a retry whose write has committed but whose response is still pending.
        signalRetryStarted()
        await retryResponseGate
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
    const exportBtn = root.locator('[data-studio-export]')

    await panel.getByRole('textbox').fill('rename the sheet')
    await panel.getByRole('button', { name: /Apply/ }).click()
    await panel.getByRole('button', { name: 'Accept & save' }).click()
    await expect(root.locator('[data-save-status="error"]')).toBeVisible()
    await expect(exportBtn).toBeEnabled()
    await root.locator('[data-save-status="error"]').getByRole('button', { name: 'Retry' }).click()
    await retryStarted
    await expect(exportBtn).toBeDisabled()
    await expect(exportBtn).toHaveAttribute('title', /Saving your changes/)
  } finally {
    releaseRetryResponse?.()
    await ctx.close()
  }
})
