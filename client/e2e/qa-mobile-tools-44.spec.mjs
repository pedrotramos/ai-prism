// From QA review r1 of W1-6: on a touch screen (coarse pointer) the Tools
// trigger is a 44 x 44 px target; with a mouse it keeps a compact 36 px height.
// Since W1-3 the trigger lives in the composer (a pill with the icon stack).
import { test, expect } from '@playwright/test'
import { newVariantContext, loadFixtures } from './lib.mjs'

const { ids } = loadFixtures()

test('the mobile Tools target is at least 44 by 44 CSS pixels', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: true })
  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const tools = page.locator('[data-composer] button[title="Tools"]')
  await expect(tools).toBeVisible()
  const box = await tools.boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await ctx.close()
})

test('with a mouse (fine pointer) the Tools target keeps its compact 36 px height', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const tools = page.locator('[data-composer] button[title="Tools"]')
  await expect(tools).toBeVisible()
  const box = await tools.boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(36)
  expect(box.height).toBeGreaterThanOrEqual(36)
  expect(box.height).toBeLessThan(44)
  await ctx.close()
})
