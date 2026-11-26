import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const { ids } = loadFixtures()
const COLLISION = {
  id: ids.sheet,
  title: 'Collision',
  sheets: [{ name: 'Instruções de Uso', blocks: [{ kind: 'section', text: 'Header' }] }],
}

test('QA: footer note names the suffixed instructions sheet when a source tab collides', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  try {
    await ctx.route(`**/api/spreadsheets/${ids.sheet}`, (route) => route.fulfill({ json: { spreadsheet: COLLISION } }))
    const page = await ctx.newPage()
    await page.goto(`${baseURL}/#/chat/${ids.s1}`)
    await page.getByText('Open in Slides Studio').first().waitFor()
    const open = page.getByRole('button', { name: 'Open studio' }).first()
    await open.scrollIntoViewIfNeeded()
    await open.click()
    const root = page.locator('[data-studio="sheet"]')
    await root.waitFor()

    const note = root.getByText('The color legend and fill instructions are on the')
    await expect(note).toContainText('Instruções de Uso 2')
  } finally {
    await ctx.close()
  }
})
