// ui-revamp W2-4: integration of Wave 1 (Home, sidebar, projects, studios, settings) as one app.
// Fixture-backed (client/dist behind fixture-server.mjs); new API shapes come in with page.route.
//
// AC map (see the PR body): item 1 Home props · 2 one project colour · 3 topbar · 4 share · 5 scrim · 6 preferences ·
// 8 style persistence on reopen · 10 mobile (390) checks.
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

// ---- items 1, 2: Home is wired from the Shell; one colour per project id on every surface ----

const startIn = (page) => page.getByRole('button', { name: /^Start in project:/ })
const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)
/** What `var(--project-<slot>)` computes to in the page, as a background colour. */
const projectToken = (page, id) =>
  page.evaluate((n) => {
    const probe = document.createElement('i')
    document.body.append(probe)
    probe.style.backgroundColor = `var(--project-${n % 8})`
    const out = getComputedStyle(probe).backgroundColor
    probe.remove()
    return out
  }, Number(id))

test('Home: the project picker, the centred composer and the recents are wired, and nothing is lost on picking a project', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  await SCREENS.welcome(page, baseURL, ids)
  const main = page.getByRole('main')
  // the composer sits inside the welcome screen, under the greeting, not at the bottom of the column
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible()
  const composer = main.locator('[data-composer]')
  await expect(composer).toHaveCount(1)
  const [h1, box] = await Promise.all([main.getByRole('heading', { level: 1 }).boundingBox(), composer.boundingBox()])
  expect(box.y).toBeGreaterThan(h1.y + h1.height)
  expect(box.y + box.height).toBeLessThan(800) // well above the bottom edge of a 900 px page
  // typing, then choosing a project: the text stays and the pill names the project
  await page.getByRole('textbox', { name: 'Message' }).fill('draft that must survive')
  await expect(startIn(page)).toHaveAccessibleName('Start in project: No project')
  await startIn(page).click()
  await page.getByRole('dialog', { name: 'Start in a project' }).getByRole('button', { name: /Revenue analytics/ }).click()
  await expect(startIn(page)).toHaveAccessibleName('Start in project: Revenue analytics')
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('draft that must survive')
  // a new chat from the sidebar clears the choice (the pill follows the app's state, not its own)
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
  await expect(startIn(page)).toHaveAccessibleName('Start in project: No project')
  // recents: three of the caller's own chats; one opens
  const recents = page.locator('[data-recent]')
  await expect(recents).toHaveCount(3)
  await recents.first().click()
  await expect(page).toHaveURL(/#\/chat\/\d+$/)
  await ctx.close()
})

test('the same project id gets the same colour token on Home, in the sidebar and on the projects screen', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await SCREENS.welcome(page, baseURL, ids)
  // Home picker rows: ids 3 and 12 -> --project-3 and --project-4
  await startIn(page).click()
  const panel = page.getByRole('dialog', { name: 'Start in a project' })
  const dotOf = (name) => panel.getByRole('button', { name: new RegExp(name) }).locator('span[aria-hidden]').first()
  const home = { 3: await bg(dotOf('Revenue analytics')), 12: await bg(dotOf('Onboarding kit')) }
  await page.keyboard.press('Escape')
  const sidebar = page.getByRole('navigation', { name: 'Conversations' })
  const side = {
    3: await bg(sidebar.getByRole('group', { name: 'Revenue analytics' }).locator('[data-sidebar-project-dot]')),
    12: await bg(sidebar.getByRole('group', { name: 'Onboarding kit' }).locator('[data-sidebar-project-dot]')),
  }
  await SCREENS.projects(page, baseURL, ids)
  const listDot = (name) => page.locator('li', { has: page.getByRole('button', { name: new RegExp(name) }) }).locator('[data-project-dot]').first()
  const list = { 3: await bg(listDot('Revenue analytics')), 12: await bg(listDot('Onboarding kit')) }
  for (const id of [3, 12]) {
    const token = await projectToken(page, id)
    expect([id, home[id], side[id], list[id]]).toEqual([id, token, token, token])
  }
  expect(home[3]).not.toBe(home[12])
  // the project page repeats it
  await SCREENS['project-detail'](page, baseURL, ids)
  expect(await bg(page.locator('[data-project-dot]').first())).toBe(await projectToken(page, 3))
  await ctx.close()
})

// ---- item 3: the topbar gets crumbs, the panel toggle and Share ----

test('the topbar shows the project crumb, toggles the artifact panel and offers Share', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  // chat 28 lives in project 3 (fixture) and has no stored messages in api.json
  await page.route('**/api/sessions/28/messages', (r) =>
    r.fulfill({ json: { messages: [{ id: '900', role: 'user', content: 'Where are the migration notes?' }, { id: '901', role: 'assistant', content: 'Here they are.', model: 'databricks-claude-sonnet-5-5' }] } })
  )
  await page.goto(`${baseURL}/#/chat/28`)
  const crumb = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(crumb.getByRole('button', { name: 'Revenue analytics' })).toBeVisible()
  await expect(page.getByRole('button', { name: /artifact panel/ })).toHaveCount(0) // no artifact in this chat
  await expect(page.locator('[data-topbar-share]')).toBeVisible()
  await crumb.getByRole('button', { name: 'Revenue analytics' }).click()
  await expect(page).toHaveURL(/#\/projects\/3$/)
  // a chat with artifacts: the toggle opens and closes the panel (a fresh page: the hash-only goto above cannot reload)
  const page2 = await ctx.newPage()
  await SCREENS['chat-rich'](page2, baseURL, ids)
  const toggle = (name) => page2.getByRole('button', { name, exact: true })
  // the thread's last artifact is its document: that is what the toggle reopens
  await toggle('Show artifact panel').click()
  await expect(page2.locator('[data-studio="doc"]')).toBeVisible()
  // the document studio covers the app (modal): it closes with its own close control, and the toggle follows
  await page2.locator('[data-studio="doc"] [data-studio-close]').click()
  await expect(page2.locator('[data-studio="doc"]')).toHaveCount(0)
  await expect(toggle('Show artifact panel')).toHaveAttribute('aria-pressed', 'false')
  await ctx.close()
})

// ---- item 5: the 768-1100 px overlay has a scrim, closes on scrim click and Escape, and focus goes back ----

async function openDeckAt(browser, baseURL, width) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  // the panel only leaves room for a scrim when focus mode is off (focus mode takes the whole width)
  await ctx.addInitScript(() => localStorage.setItem('prism-deck-focus', '0'))
  const page = await ctx.newPage()
  await page.setViewportSize({ width, height: 800 })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const opener = page.getByText('Open in Slides Studio').first()
  await opener.waitFor()
  await opener.scrollIntoViewIfNeeded()
  await opener.click()
  await page.locator('[data-studio="deck"]').waitFor()
  return { ctx, page, opener }
}

test('overlay width: the deck panel has a scrim; a click on it closes the panel and focus returns to the opener', async ({ browser, baseURL }) => {
  const { ctx, page } = await openDeckAt(browser, baseURL, 1000)
  const deck = page.locator('[data-studio="deck"]')
  await expect(deck).toHaveAttribute('role', 'dialog')
  const scrim = page.locator('[data-studio-scrim]')
  await expect(scrim).toHaveCount(1)
  expect(await bg(scrim)).not.toBe('rgba(0, 0, 0, 0)') // painted, not just a hit area
  const panel = await deck.boundingBox()
  expect(panel.x).toBeGreaterThan(100) // the left of the screen is scrim
  await page.mouse.click(40, 400)
  await expect(deck).toHaveCount(0)
  await expect(page.locator('[data-studio-scrim]')).toHaveCount(0)
  // focus is back where the user opened it (the deck block's button), not lost on <body>
  await expect(page.locator('body')).not.toBeFocused()
  expect(await page.evaluate(() => document.activeElement?.textContent || '')).toContain('Open in Slides Studio')
  await ctx.close()
})

test('overlay width: Escape closes the deck panel and focus returns to the opener', async ({ browser, baseURL }) => {
  const { ctx, page } = await openDeckAt(browser, baseURL, 900)
  await expect(page.locator('[data-studio-scrim]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-studio="deck"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.textContent || '')).toContain('Open in Slides Studio')
  await ctx.close()
})

test('docked width (1440): no scrim, and a click beside the panel does not close it', async ({ browser, baseURL }) => {
  const { ctx, page } = await openDeckAt(browser, baseURL, 1440)
  await expect(page.locator('[data-studio-scrim]')).toHaveCount(0)
  await page.mouse.click(20, 300)
  await expect(page.locator('[data-studio="deck"]')).toBeVisible()
  await ctx.close()
})

// ---- item 6: Preferences shows the defaults for new chats and the read-aloud speed ----

const openPreferences = async (page, baseURL) => {
  await SCREENS['settings-preferences'](page, baseURL, ids)
  return page.getByRole('region', { name: /Preferences/ })
}

test('Preferences: the default model is the app model and follows a change; the tools line follows the org policy', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  await page.route('**/api/tool-policy', (r) => r.fulfill({ json: { policy: { 'image-gen': false }, keys: ['python', 'genie-one', 'image-gen'] } }))
  const prefs = await openPreferences(page, baseURL)
  const section = prefs.getByRole('region', { name: 'Defaults for new chats' }).or(prefs.locator('section', { has: page.getByRole('heading', { name: 'Defaults for new chats' }) }))
  const model = section.getByLabel('Model', { exact: true })
  await expect(model).toHaveValue('databricks-claude-sonnet-5-5')
  await model.selectOption('databricks-gpt-6-1-sol')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('[data-composer]').getByRole('button', { name: /^Model: GPT-6\.1 Sol/ })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('prism-model'))).toBe('databricks-gpt-6-1-sol')
  // the image generator is off by org policy: it is not promised to new chats
  await openPreferences(page, baseURL)
  await expect(page.locator('[data-defaults-tools]')).toHaveText('New chats start with: Genie One. Change them per chat in the message box.')
  await ctx.close()
})

test('Preferences: the read-aloud speed is stored, offered back after a reload and used by the sample and by "Listen"', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  await ctx.addInitScript(() => {
    window.__spoken = []
    const synth = window.speechSynthesis
    synth.speak = (u) => void window.__spoken.push({ text: u.text, rate: u.rate })
    synth.cancel = () => {}
  })
  const page = await ctx.newPage()
  const prefs = await openPreferences(page, baseURL)
  const speed = prefs.getByLabel('Read aloud', { exact: true })
  await expect(speed).toHaveValue('1')
  await speed.selectOption('1.5')
  expect(await page.evaluate(() => localStorage.getItem('prism-voice-rate'))).toBe('1.5')
  await prefs.getByRole('button', { name: 'Play a sample' }).click()
  await expect.poll(() => page.evaluate(() => window.__spoken.at(-1)?.rate)).toBe(1.5)
  // the same speed reaches the real read-aloud of an answer
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Q3 revenue by region — analysis', exact: true }).click()
  await page.getByRole('button', { name: 'Listen to response' }).first().waitFor({ state: 'attached' })
  await page.evaluate(() => (window.__spoken.length = 0))
  await page.getByRole('button', { name: 'Listen to response' }).first().click({ force: true })
  await expect.poll(() => page.evaluate(() => window.__spoken.length)).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__spoken[0].rate)).toBe(1.5)
  // and it survives a reload
  await page.reload()
  const again = await openPreferences(page, baseURL)
  await expect(again.getByLabel('Read aloud', { exact: true })).toHaveValue('1.5')
  await ctx.close()
})

// ---- item 10: 390 px, every screen of SCREENS ----

test('390 px: no screen scrolls sideways and every control is at least 44 px in BOTH dimensions', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const { SCREENS: ALL } = await import('./lib.mjs')
  for (const [name, go] of Object.entries(ALL)) {
    const ctx = await newVariantContext(browser, { theme: 'light', mobile: true })
    const page = await ctx.newPage()
    await go(page, baseURL, ids)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(wide, `${name}: horizontal overflow`).toBeLessThanOrEqual(1)
    // buttons and form controls the user taps (links inside prose and the iframe-hosted slide are not targets of the app chrome)
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, select, input:not([type=hidden]), [role=button], [role=switch]')]
        .filter((e) => {
          const r = e.getBoundingClientRect()
          const cs = getComputedStyle(e)
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('iframe, [inert]')
        })
        .map((e) => ({ label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }))
        .filter((x) => x.h < 44 || x.w < 44)
    )
    expect(small, `${name}: controls under 44x44 on touch`).toEqual([])
    await ctx.close()
  }
})

// ---- item 7 (steer from W2-1): the app has exactly one page-level <h1> on every screen, outside any iframe ----

for (const theme of ['light', 'dark']) {
  test(`every screen of SCREENS has exactly one app-level h1 (${theme})`, async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const { SCREENS: ALL } = await import('./lib.mjs')
    const ctx = await newVariantContext(browser, { theme, mobile: false })
    for (const [name, go] of Object.entries(ALL)) {
      const page = await ctx.newPage()
      await go(page, baseURL, ids)
      // document.querySelectorAll does not enter iframes: a deck slide's own <h1> can never satisfy this
      const headings = await page.evaluate(() => [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()))
      expect(headings, `${name}: app-level h1`).toHaveLength(1)
      expect(headings[0], `${name}: h1 has text`).not.toBe('')
      await page.close()
    }
    await ctx.close()
  })
}

// ---- item 10: on a phone Home opens at its top (the greeting is the first thing seen) ----

test('390 px: Home opens scrolled to the top, greeting visible, composer reachable', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: true })
  const page = await ctx.newPage()
  await SCREENS.welcome(page, baseURL, ids)
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport()
  await expect(page.locator('[data-composer]')).toBeInViewport()
  await ctx.close()
})

// ---- QA r1: Share while the projects list is loading or has failed ----

const PROJECTS_BODY = { projects: [PROJECT], limits: LIMITS }

test('Share on a personal chat when GET /api/projects fails shows an error and stays on the chat', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  await page.route('**/api/projects', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.locator('[data-topbar-share]').click()
  await expect(page.getByRole('alert').filter({ hasText: /Could not load your projects/ })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  await expect(page.getByRole('dialog', { name: /Move/ })).toHaveCount(0)
  await ctx.close()
})

test('a Share clicked while projects load is dropped if the user has opened another chat by the time they arrive', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  let release
  const held = new Promise((r) => (release = r))
  await page.route('**/api/projects', async (r) => {
    await held
    return r.fulfill({ json: PROJECTS_BODY })
  })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const share = page.locator('[data-topbar-share]')
  await share.click()
  await expect(share).toHaveAttribute('aria-busy', 'true') // a visible pending state, not a dead click
  await page.getByRole('button', { name: 'Fix flaky pytest in ingestion job', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))
  const delivered = page.waitForResponse((r) => r.url().endsWith('/api/projects'))
  release()
  await delivered
  // two frames: the app has handled the response (and would have opened the dialog) before the absence is asserted
  await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))
  await expect(page.getByRole('dialog', { name: /Move/ })).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s2}$`))
  await ctx.close()
})
