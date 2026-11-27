import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const { ids, routes } = loadFixtures()
const blocks = JSON.parse(routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const deckBlock = blocks.find((b) => b.type === 'deck-html')

test('a second browser Back during a navigation prompt stays ignored and leaves URL aligned after Discard', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const deck = { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [...deckBlock.slides], format: 'html' }
  await ctx.route(`**/api/decks/${ids.deck}`, (route) => route.fulfill({ json: { deck } }))

  await page.goto(`${baseURL}/#/chat/${ids.s3}`, { waitUntil: 'domcontentloaded' })
  const sidebar = async () => {
    const expand = page.getByRole('button', { name: 'Expand sidebar' })
    if (await expand.isVisible()) await expand.click()
    return page.getByRole('navigation', { name: 'Conversations' })
  }
  await (await sidebar()).getByRole('button', { name: 'Fix flaky pytest in ingestion job', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))
  await (await sidebar()).getByRole('button', { name: 'Q3 revenue by region — analysis', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))

  await page.getByText('Open in Slides Studio').first().click()
  const studio = page.locator('[data-studio="deck"]')
  await expect(studio).toBeVisible()
  await studio.getByRole('button', { name: 'Edit', exact: true }).click()
  await studio.getByRole('button', { name: 'Add slide' }).click()
  await expect(studio).toHaveAttribute('data-studio-dirty', '')

  await page.goBack()
  const prompt = page.getByRole('alertdialog')
  await expect(prompt).toBeVisible()
  await page.goBack() // a second popstate while the first leave guard is still awaiting the decision
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: 'Discard' }).click()

  await expect(page.getByRole('heading', { name: 'Fix flaky pytest in ingestion job' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))
  await ctx.close()
})
