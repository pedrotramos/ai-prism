// ui-revamp W3-9: navigating to another chat never drops unsaved studio edits. A dirty studio is closed through ITS OWN
// Save / Discard / Cancel prompt before the navigation happens; Cancel (or a failed Save) keeps the chat, the URL and the
// draft. QA's repro (qa-w3-8b-flakes-r1.md) is the deck/sidebar test below.
//
// AC map: sidebar row · New chat · browser Back (restored on Cancel) · Cancel keeps the chat · Discard navigates ·
// Save then navigates · failed Save stays · clean studios close without a prompt (the spreadsheet holds no unsaved work).
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const { ids } = loadFixtures()
const OTHER_CHAT = 'Fix flaky pytest in ingestion job'
const chatBlocks = JSON.parse(loadFixtures().routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const docBlock = chatBlocks.find((b) => b.type === 'document')
const sheetBlock = chatBlocks.find((b) => b.type === 'spreadsheet')
const deckBlock = chatBlocks.find((b) => b.type === 'deck-html')

const twoFrames = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))

/** Artifact endpoints that record every PATCH and can be told to fail it. */
async function routeArtifacts(page, { patchStatus = 200 } = {}) {
  const state = { patches: { deck: [], doc: [] } }
  const deck = { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [...deckBlock.slides], format: 'html' }
  await page.route(`**/api/decks/${ids.deck}`, (r) => {
    const req = r.request()
    if (req.method() !== 'PATCH') return r.fulfill({ json: { deck } })
    state.patches.deck.push(req.postDataJSON())
    if (patchStatus !== 200) return r.fulfill({ status: patchStatus, json: { error: 'save failed' } })
    return r.fulfill({ json: { deck: { ...deck, ...req.postDataJSON() } } })
  })
  await page.route(`**/api/documents/${ids.doc}`, (r) => {
    const req = r.request()
    if (req.method() !== 'PATCH') return r.fulfill({ json: { document: { id: ids.doc, title: docBlock.title, markdown: docBlock.markdown } } })
    const body = req.postDataJSON()
    state.patches.doc.push(body)
    if (patchStatus !== 200) return r.fulfill({ status: patchStatus, json: { error: 'save failed' } })
    return r.fulfill({ json: { document: { id: ids.doc, title: docBlock.title, markdown: body.markdown } } })
  })
  await page.route(`**/api/spreadsheets/${ids.sheet}`, (r) => r.fulfill({ json: { spreadsheet: { id: ids.sheet, title: sheetBlock.title, sheets: sheetBlock.sheets } } }))
  return state
}

const KINDS = {
  deck: {
    card: '[data-artifact-card="deck"] [data-card-primary]',
    dirty: async (page, studio) => {
      await studio.getByRole('button', { name: 'Edit', exact: true }).click()
      await studio.getByRole('button', { name: 'Add slide' }).click()
      await expect(studio).toHaveAttribute('data-studio-dirty', '')
    },
    discard: 'Discard',
    cancel: 'Cancel',
    save: 'Save & close',
    kept: (studio) => expect(studio.getByRole('button', { name: /^Slide \d$/ })).toHaveCount(4),
  },
  doc: {
    card: '[data-artifact-card="document"] [data-card-primary]',
    dirty: async (page, studio) => {
      await studio.getByRole('button', { name: 'Edit', exact: true }).click()
      await studio.getByRole('textbox', { name: 'Document text editor' }).click()
      await page.keyboard.type(' More.')
      await expect(studio).toHaveAttribute('data-studio-dirty', '')
    },
    discard: 'Discard changes',
    cancel: 'Keep editing',
    save: 'Save',
    kept: (studio) => expect(studio.getByRole('textbox', { name: 'Document text editor' })).toContainText('More.'),
  },
}

async function open(browser, baseURL, kind, opts) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const api = await routeArtifacts(page, opts)
  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  const card = page.locator(KINDS[kind].card).first()
  await expect(card).toBeVisible()
  await card.click()
  const studio = page.locator(`[data-studio="${kind}"]`)
  await expect(studio).toBeVisible()
  return { ctx, page, api, studio }
}

/** The sidebar, expanded first when the studio left it collapsed (QA's repro does the same). */
async function sidebar(page) {
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.isVisible()) await expand.click()
  return page.getByRole('navigation', { name: 'Conversations' })
}
const clickChat = async (page, name) => (await sidebar(page)).getByRole('button', { name, exact: true }).click()
const clickNewChat = async (page) => {
  await sidebar(page)
  await page.locator('#app-sidebar').getByRole('button', { name: 'New chat', exact: true }).click()
}

const prompt = (page) => page.getByRole('alertdialog')
const atS1 = (page) => expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
const atS2 = (page) => expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))

for (const [kind, g] of Object.entries(KINDS)) {
  test(`${kind}: picking another chat with unsaved edits asks first; Cancel stays on the chat and keeps the draft`, async ({ browser, baseURL }) => {
    const { ctx, page, studio } = await open(browser, baseURL, kind)
    await g.dirty(page, studio)
    await clickChat(page, OTHER_CHAT)
    await expect(prompt(page)).toBeVisible()
    await atS1(page) // nothing moved while the prompt is up
    await prompt(page).getByRole('button', { name: g.cancel }).click()
    await expect(prompt(page)).toHaveCount(0)
    await twoFrames(page)
    await atS1(page)
    await expect(studio).toBeVisible()
    await g.kept(studio)
    await ctx.close()
  })

  test(`${kind}: Discard navigates to the chosen chat and closes the studio`, async ({ browser, baseURL }) => {
    const { ctx, page, studio } = await open(browser, baseURL, kind)
    await g.dirty(page, studio)
    await clickChat(page, OTHER_CHAT)
    await prompt(page).getByRole('button', { name: g.discard }).click()
    await atS2(page)
    await expect(page.locator(`[data-studio="${kind}"]`)).toHaveCount(0)
    await ctx.close()
  })

  test(`${kind}: Save writes the draft once, then navigates`, async ({ browser, baseURL }) => {
    const { ctx, page, api, studio } = await open(browser, baseURL, kind)
    await g.dirty(page, studio)
    await clickChat(page, OTHER_CHAT)
    await prompt(page).getByRole('button', { name: g.save, exact: true }).click()
    await atS2(page)
    expect(api.patches[kind]).toHaveLength(1)
    await expect(page.locator(`[data-studio="${kind}"]`)).toHaveCount(0)
    await ctx.close()
  })

  test(`${kind}: a failed Save keeps the prompt, the chat and the draft; Cancel then stays`, async ({ browser, baseURL }) => {
    const { ctx, page, api, studio } = await open(browser, baseURL, kind, { patchStatus: 500 })
    await g.dirty(page, studio)
    await clickChat(page, OTHER_CHAT)
    await prompt(page).getByRole('button', { name: g.save, exact: true }).click()
    await expect.poll(() => api.patches[kind].length).toBeGreaterThanOrEqual(1)
    await expect(prompt(page)).toBeVisible()
    await atS1(page)
    await prompt(page).getByRole('button', { name: g.cancel }).click()
    await twoFrames(page)
    await atS1(page) // no late navigation after the cancel
    await expect(studio).toBeVisible()
    await g.kept(studio)
    await ctx.close()
  })

  test(`${kind}: New chat with unsaved edits asks first; Cancel stays, Discard opens the new chat`, async ({ browser, baseURL }) => {
    const { ctx, page, studio } = await open(browser, baseURL, kind)
    await g.dirty(page, studio)
    await clickNewChat(page)
    await expect(prompt(page)).toBeVisible()
    await prompt(page).getByRole('button', { name: g.cancel }).click()
    await twoFrames(page)
    await atS1(page)
    await g.kept(studio)
    await clickNewChat(page)
    await prompt(page).getByRole('button', { name: g.discard }).click()
    await expect(page).toHaveURL(/#\/chat$/)
    await expect(page.locator(`[data-studio="${kind}"]`)).toHaveCount(0)
    await ctx.close()
  })

  test(`${kind}: browser Back with unsaved edits asks first; Cancel restores the chat URL, Discard goes back`, async ({ browser, baseURL }) => {
    const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
    const page = await ctx.newPage()
    await routeArtifacts(page)
    await page.goto(`${baseURL}/#/chat/${ids.s2}`, { waitUntil: 'domcontentloaded' })
    await clickChat(page, 'Q3 revenue by region — analysis')
    await atS1(page)
    await page.locator(g.card).first().click()
    const studio = page.locator(`[data-studio="${kind}"]`)
    await expect(studio).toBeVisible()
    await g.dirty(page, studio)
    await page.goBack()
    await expect(prompt(page)).toBeVisible()
    await prompt(page).getByRole('button', { name: g.cancel }).click()
    await twoFrames(page)
    await atS1(page) // the URL is put back: it never disagrees with what is on screen
    await expect(studio).toBeVisible()
    await g.kept(studio)
    await page.goBack()
    await prompt(page).getByRole('button', { name: g.discard }).click()
    await atS2(page)
    await expect(page.locator(`[data-studio="${kind}"]`)).toHaveCount(0)
    await ctx.close()
  })
}

test('a clean studio (the spreadsheet holds no unsaved work) closes on navigation without a prompt', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await routeArtifacts(page)
  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open studio', exact: true }).click()
  await expect(page.locator('[data-studio="sheet"]')).toBeVisible()
  await clickChat(page, OTHER_CHAT)
  await atS2(page)
  await expect(prompt(page)).toHaveCount(0)
  await expect(page.locator('[data-studio="sheet"]')).toHaveCount(0)
  await ctx.close()
})

test('a clean deck closes on navigation without a prompt', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, baseURL, 'deck')
  await clickChat(page, OTHER_CHAT)
  await atS2(page)
  await expect(prompt(page)).toHaveCount(0)
  await expect(page.locator('[data-studio="deck"]')).toHaveCount(0)
  await ctx.close()
})

// ---- the spreadsheet holds work only once an AI edit is ACCEPTED and its write has not landed (QA r1) ----
// The accepted edit lives only in the studio's preview. A failed (or pending) write keeps it there, so leaving asks first:
// Save retries the write, Discard drops the edit, Cancel stays. A preview that was never accepted closes silently.
const sheetSpec = { id: ids.sheet, title: sheetBlock.title, sheets: sheetBlock.sheets }
async function openSheetWithFailedAccept(browser, baseURL, { retryOk = true } = {}) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const state = { patches: 0, fail: true }
  await page.route(`**/api/spreadsheets/${ids.sheet}/tweak`, (r) =>
    r.fulfill({ json: { spreadsheet: { ...sheetSpec, title: `${sheetSpec.title} revised` }, model: 'test-model' } }))
  await page.route(`**/api/spreadsheets/${ids.sheet}`, (r) => {
    if (r.request().method() !== 'PATCH') return r.fulfill({ json: { spreadsheet: sheetSpec } })
    state.patches++
    if (state.fail) return r.fulfill({ status: 500, json: { error: 'save failed' } })
    return r.fulfill({ json: { spreadsheet: { ...sheetSpec, title: `${sheetSpec.title} revised` } } })
  })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open studio', exact: true }).click()
  const studio = page.locator('[data-studio="sheet"]')
  await expect(studio).toBeVisible()
  const panel = studio.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Change the workbook title')
  await panel.getByRole('button', { name: /Apply/ }).click()
  await panel.getByRole('button', { name: 'Accept & save' }).click()
  await expect.poll(() => state.patches).toBe(1)
  await expect(studio.getByRole('button', { name: 'Retry' })).toBeVisible()
  if (retryOk) state.fail = false
  return { ctx, page, studio, state }
}

test('sheet: a failed accepted edit asks first; Cancel stays on the chat with Retry still there', async ({ browser, baseURL }) => {
  const { ctx, page, studio } = await openSheetWithFailedAccept(browser, baseURL)
  await clickChat(page, OTHER_CHAT)
  await expect(prompt(page)).toBeVisible()
  await prompt(page).getByRole('button', { name: 'Keep editing' }).click()
  await twoFrames(page)
  await atS1(page)
  await expect(studio.getByRole('button', { name: 'Retry' })).toBeVisible()
  await ctx.close()
})

test('sheet: Discard drops the failed edit and navigates', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await openSheetWithFailedAccept(browser, baseURL)
  await clickChat(page, OTHER_CHAT)
  await prompt(page).getByRole('button', { name: 'Discard edit' }).click()
  await atS2(page)
  await expect(page.locator('[data-studio="sheet"]')).toHaveCount(0)
  expect(state.patches).toBe(1)
  await ctx.close()
})

test('sheet: Save retries the write, then navigates; a Save that fails again stays', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await openSheetWithFailedAccept(browser, baseURL, { retryOk: false })
  await clickChat(page, OTHER_CHAT)
  await prompt(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.patches).toBe(2)
  await expect(prompt(page)).toBeVisible() // failed again: the prompt, the chat and the edit stay
  await atS1(page)
  state.fail = false
  await prompt(page).getByRole('button', { name: 'Save', exact: true }).click()
  await atS2(page)
  expect(state.patches).toBe(3)
  await expect(page.locator('[data-studio="sheet"]')).toHaveCount(0)
  await ctx.close()
})
