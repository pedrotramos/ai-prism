// QA-only acceptance probe from the review request. This file is not part of
// the reviewed PR snapshot.
import { test, expect } from '@playwright/test'
import { newVariantContext, loadFixtures } from './lib.mjs'

const { ids } = loadFixtures()

test('the mobile Tools target is at least 44 by 44 CSS pixels', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: true })
  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const tools = page.locator('main header button[title="Tools"]')
  await expect(tools).toBeVisible()
  const box = await tools.boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await ctx.close()
})
