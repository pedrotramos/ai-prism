// ui-revamp W2-4: integration of Wave 1 (Home, sidebar, projects, studios, settings) as one app.
// Fixture-backed (client/dist behind fixture-server.mjs); new API shapes come in with page.route.
//
// AC map (see the PR body): item 4 share · item 8 style persistence on reopen.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, SCREENS } from './lib.mjs'

const { ids } = loadFixtures()
const OTHER_CHAT = 'Fix flaky pytest in ingestion job'
const FIRST_CHAT = 'Q3 revenue by region — analysis'

const styleTrigger = (page) => page.locator('[data-composer]').getByRole('button', { name: /^Response style:/ })

// ---- item 8: a confirmed style survives leaving and reopening the chat ----

test('a confirmed style is still there after leaving the chat and coming back', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await page.route(`**/api/sessions/${ids.s1}`, (r) => (r.request().method() === 'PATCH' ? r.fulfill({ json: { ok: true } }) : r.fallback()))
  await SCREENS['chat-rich'](page, baseURL, ids)
  await styleTrigger(page).click()
  await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Executive/ }).click()
  await expect(styleTrigger(page)).toHaveAccessibleName('Response style: Executive')
  await page.getByRole('button', { name: OTHER_CHAT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))
  await page.getByRole('button', { name: FIRST_CHAT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  await expect(styleTrigger(page)).toHaveAccessibleName('Response style: Executive')
  await ctx.close()
})

test('after a newer failed save, reopening the chat shows the last CONFIRMED style, not Default', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  let patches = 0
  await page.route(`**/api/sessions/${ids.s1}`, (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    patches += 1
    return patches === 1 ? r.fulfill({ json: { ok: true } }) : r.fulfill({ status: 500, json: { error: 'save failed' } })
  })
  await SCREENS['chat-rich'](page, baseURL, ids)
  await styleTrigger(page).click()
  await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Executive/ }).click()
  await expect(styleTrigger(page)).toHaveAccessibleName('Response style: Executive')
  await expect.poll(() => patches).toBe(1)
  await styleTrigger(page).click()
  await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Concise/ }).click()
  await expect(page.getByRole('alert').filter({ hasText: /style/i })).toBeVisible()
  await expect(styleTrigger(page)).toHaveAccessibleName('Response style: Executive')
  await page.getByRole('button', { name: OTHER_CHAT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))
  await page.getByRole('button', { name: FIRST_CHAT, exact: true }).click()
  await expect(styleTrigger(page)).toHaveAccessibleName('Response style: Executive')
  await ctx.close()
})

// ---- item 4 (Q4-B): the deck studio's Share moves the chat into a project and opens its members ----

const ME = 'e2e-user@example.com'
const PROJECT = { id: '3', name: 'Alpha', description: '', instructions: '', created_by: ME, role: 'owner' }
const LIMITS = { nameMaxChars: 200, descriptionMaxChars: 2000, instructionsMaxChars: 20000, fileMaxBytes: 5242880, filesPerUpload: 10, filesPerProject: 50, extractedCharsPerFile: 50000, contextFilesMaxTokens: 32000, supportedExtensions: ['pdf', 'txt', 'md'] }

/** A tiny projects "server": one project, the chat s1 starts personal and can be attached. */
async function routeProjects(page, { inProject = false } = {}) {
  const state = { attached: inProject, attachCalls: [] }
  await page.route('**/api/projects**', async (r) => {
    const req = r.request()
    const url = new URL(req.url())
    const p = url.pathname
    if (p === '/api/projects') return r.fulfill({ json: { projects: [PROJECT], limits: LIMITS } })
    if (p === '/api/projects/3') return r.fulfill({ json: { project: PROJECT } })
    if (p === '/api/projects/3/members') return r.fulfill({ json: { members: [{ kind: 'user', principal: ME, role: 'owner' }] } })
    if (p === '/api/projects/3/files') return r.fulfill({ json: { files: [], context: null } })
    if (p === '/api/projects/3/sessions' && req.method() === 'POST') {
      state.attachCalls.push(JSON.parse(req.postData() || '{}'))
      state.attached = true
      return r.fulfill({ json: { ok: true } })
    }
    if (p === '/api/projects/3/sessions') return r.fulfill({ json: { sessions: [] } })
    return r.fallback()
  })
  // the sidebar list reflects the move once the attach went through
  await page.route('**/api/sessions', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const res = await r.fetch()
    const body = await res.json()
    if (state.attached) body.sessions = body.sessions.map((s) => (String(s.id) === ids.s1 ? { ...s, project_id: '3' } : s))
    return r.fulfill({ response: res, json: body })
  })
  return state
}

const openDeck = async (page, baseURL) => {
  await SCREENS['deck-studio'](page, baseURL, ids)
  return page.locator('[data-studio="deck"]')
}

test('Share on a personal chat asks for a project, moves the chat there and opens the members', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const server = await routeProjects(page)
  const deck = await openDeck(page, baseURL)
  await deck.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: /Move/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Alpha' }).click()
  await expect.poll(() => server.attachCalls).toEqual([{ sessionId: ids.s1 }])
  await expect(page).toHaveURL(/#\/projects\/3$/)
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()
  await expect(page.locator('[data-share-first]')).toBeFocused()
  await ctx.close()
})

test('Share on a chat that is already in a project goes to its members without moving anything', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const server = await routeProjects(page, { inProject: true })
  const deck = await openDeck(page, baseURL)
  await deck.getByRole('button', { name: 'Share' }).click()
  await expect(page).toHaveURL(/#\/projects\/3$/)
  await expect(page.locator('[data-share-first]')).toBeFocused()
  expect(server.attachCalls).toEqual([])
  await ctx.close()
})
