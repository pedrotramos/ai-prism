import { test, expect } from '@playwright/test'
import { newVariantContext, SCREENS } from './lib.mjs'

const validA = {
  id: 'rec-a',
  displayName: 'Recommendation A',
  blurb: 'blurb rec-a',
  provider: 'Anthropic',
  enabled: false,
  discovered: true,
  curated: true,
  sortOrder: 10,
  priceIn: null,
  priceOut: null,
  inferredPriceIn: 3,
  inferredPriceOut: 15,
  modality: 'chat',
}
const validB = { ...validA, id: 'rec-b', displayName: 'Recommendation B', blurb: 'blurb rec-b', sortOrder: 11 }
const undiscovered = { ...validA, id: 'not-discovered', displayName: 'Undiscovered Recommendation', discovered: false }
const enabled = { ...validA, id: 'already-enabled', displayName: 'Enabled Recommendation', enabled: true }

async function openModels(browser, baseURL, { endpoints = [validA, validB, undiscovered, enabled], recommended = ['rec-a', 'rec-b', 'not-discovered', 'already-enabled', 'missing'] } = {}) {
  const context = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await context.newPage()
  const puts = []
  await page.route('**/api/me', (r) => r.fulfill({ json: { email: 'admin@example.com', isAdmin: true, isOwner: true } }))
  await page.route('**/api/admin/model-endpoints', (r) => r.fulfill({ json: { endpoints, recommended } }))
  await page.route('**/api/admin/model-endpoints/*', (r) => {
    if (r.request().method() === 'PUT') {
      puts.push({
        method: r.request().method(),
        path: new URL(r.request().url()).pathname,
        body: r.request().postDataJSON(),
      })
    }
    return r.fulfill({ json: { ok: true } })
  })
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Models (LLM)', exact: true }).click()
  await expect(dialog.getByRole('list', { name: 'Enabled models' })).toBeVisible()
  return { context, page, dialog, puts }
}

async function recommendationCard(dialog) {
  const opener = dialog.getByRole('button', { name: /Recommended models/ })
  if (await opener.count()) await opener.click()
  const addAll = dialog.getByRole('button', { name: 'Add all', exact: true })
  await expect(addAll).toBeVisible()
  return addAll.locator('xpath=../..')
}

const expectedPut = (id, displayName, sortOrder) => ({
  method: 'PUT',
  path: `/api/admin/model-endpoints/${id}`,
  body: { enabled: true, displayName, blurb: `blurb ${id}`, sortOrder, priceIn: null, priceOut: null },
})

test('Amendment 1: only discovered, not-enabled recommended endpoints appear in the card', async ({ browser, baseURL }) => {
  const { context, dialog } = await openModels(browser, baseURL)
  const card = await recommendationCard(dialog)
  await expect(card.getByText('Recommendation A', { exact: true })).toBeVisible()
  await expect(card.getByText('Recommendation B', { exact: true })).toBeVisible()
  await expect(card.getByText('Undiscovered Recommendation', { exact: true })).toHaveCount(0)
  await expect(card.getByText('Enabled Recommendation', { exact: true })).toHaveCount(0)
  await context.close()
})

test('Amendment 1: no recommendation control appears when every recommendation is undiscovered or enabled', async ({ browser, baseURL }) => {
  const { context, dialog } = await openModels(browser, baseURL, {
    endpoints: [undiscovered, enabled],
    recommended: ['not-discovered', 'already-enabled', 'missing'],
  })
  await expect(dialog.getByRole('button', { name: /Recommended models/ })).toHaveCount(0)
  await expect(dialog.getByText('Recommended models', { exact: true })).toHaveCount(0)
  await context.close()
})

test('Amendment 1: add one sends the base PUT for that recommendation', async ({ browser, baseURL }) => {
  const { context, dialog, puts } = await openModels(browser, baseURL)
  const card = await recommendationCard(dialog)
  await card.getByRole('button', { name: 'Add', exact: true }).first().click()
  await expect.poll(() => puts).toEqual([expectedPut('rec-a', 'Recommendation A', 10)])
  await context.close()
})

test('Amendment 1: add all sends the same base PUTs in recommendation order', async ({ browser, baseURL }) => {
  const { context, dialog, puts } = await openModels(browser, baseURL)
  const card = await recommendationCard(dialog)
  await card.getByRole('button', { name: 'Add all', exact: true }).click()
  await expect.poll(() => puts).toEqual([
    expectedPut('rec-a', 'Recommendation A', 10),
    expectedPut('rec-b', 'Recommendation B', 11),
  ])
  await context.close()
})

test('Amendment 1: recommendation control has no added “N new” badge', async ({ browser, baseURL }) => {
  const { context, dialog } = await openModels(browser, baseURL)
  await expect(dialog.getByText(/^\d+ new$/, { exact: true })).toHaveCount(0)
  await context.close()
})
