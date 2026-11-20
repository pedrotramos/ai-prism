// Temporary (ephemeral) chats (W3-6). The "+" menu starts one; the first message
// creates it with `ephemeral: true`; the sidebar row and the chat header carry the
// localized "Temporary" badge; leaving the chat (a new chat, another chat, closing
// the tab) deletes it on the server. Every endpoint is answered with page.route (no
// backend): the mock keeps the "server" state, so "gone server-side" is its state.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, VARIANTS, newVariantContext, SCREENS, variantName } from './lib.mjs'

const TEMP_ID = '9001'
const NORMAL_ID = '9002'

async function open(browser, baseURL, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  // records the payload of every /api/chat call (the shim of lib.mjs answers it in the page)
  await ctx.addInitScript(() => {
    window.__payloads = []
    const prev = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (/\/api\/chat$/.test(url) && init?.body instanceof FormData) window.__payloads.push(JSON.parse(init.body.get('payload')))
      return prev(input, init)
    }
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const server = {
    sessions: [{ id: NORMAL_ID, title: 'Quarterly numbers', model: 'databricks-claude-sonnet-5-5', system_prompt: '', enabled_tools: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), project_id: null, ephemeral: false, attachment_names: [] }],
    deleted: [],
  }
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: server.sessions } }))
  await page.route('**/api/sessions/*/messages', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const known = server.sessions.some((s) => s.id === id)
    return route.fulfill({
      json: { messages: known ? [{ id: '1', role: 'user', content: 'a private question' }, { id: '2', role: 'assistant', content: 'an answer' }] : [] },
    })
  })
  await page.route(/\/api\/sessions\/\d+$/, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const id = new URL(route.request().url()).pathname.split('/')[3]
    server.deleted.push(id)
    server.sessions = server.sessions.filter((s) => s.id !== id)
    return route.fulfill({ json: { ok: true } })
  })
  await SCREENS.welcome(page, baseURL, {})
  return { ctx, page, errors, server }
}

// "+" → Temporary chat → type → send; answers the stream and registers the session as the server would
async function startTemporaryAndSend(page, server, text = 'a private question') {
  await page.getByRole('button', { name: 'Add files and more' }).click()
  await page.getByRole('menuitem', { name: /Temporary chat/ }).click()
  await page.locator('textarea').first().fill(text)
  await page.locator('button[title="Send"]').click()
  await page.waitForFunction(() => !!window.__sse)
  server.sessions.unshift({ id: TEMP_ID, title: '💬 Nova conversa', model: 'databricks-claude-sonnet-5-5', system_prompt: '', enabled_tools: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), project_id: null, ephemeral: true, attachment_names: [] })
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'token', value: 'an answer' })
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  }, TEMP_ID)
  await expect(page.getByText('an answer').first()).toBeVisible()
}

// a round trip through the mocked server: every request the page sent before it has been handled
// (the routes answer in order), so a negative check right after it is not a guess about timing
const roundTrip = (page) => page.evaluate(() => fetch('/api/sessions').then((r) => r.text()))
// every running CSS animation / transition has finished (the 250 ms fade-ins), so axe sees the final paint
const animationsDone = (page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))))

const headerBadge = (page) => page.locator('header [data-temporary-badge]')
const rowBadge = (page) => page.locator('nav [data-temporary-badge]')

test('AC1/AC5: + menu starts a temporary chat; the first message creates it as one; a new chat deletes it server-side', async ({ browser, baseURL }) => {
  const { ctx, page, errors, server } = await open(browser, baseURL)
  await page.getByRole('button', { name: 'Add files and more' }).click()
  await page.getByRole('menuitem', { name: /Temporary chat/ }).click()
  // marked before anything exists on the server
  await expect(headerBadge(page)).toHaveCount(1)
  await page.locator('textarea').first().fill('a private question')
  await page.locator('button[title="Send"]').click()
  await page.waitForFunction(() => !!window.__sse)
  expect(await page.evaluate(() => window.__payloads)).toMatchObject([{ ephemeral: true, sessionId: null }])
  server.sessions.unshift({ id: TEMP_ID, title: '💬 Nova conversa', model: 'm', system_prompt: '', enabled_tools: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), project_id: null, ephemeral: true, attachment_names: [] })
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'token', value: 'an answer' })
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  }, TEMP_ID)
  await expect(page.getByText('an answer').first()).toBeVisible()
  // the chat is temporary in the header and in the sidebar row; the normal chat has no badge
  await expect(headerBadge(page)).toHaveCount(1)
  await expect(rowBadge(page)).toHaveCount(1)
  await expect(rowBadge(page)).toHaveText('Temporary')
  await expect(page.locator('nav li', { hasText: 'Quarterly numbers' }).locator('[data-temporary-badge]')).toHaveCount(0)
  // the + menu no longer offers it while the open chat already is one
  await page.getByRole('button', { name: 'Add files and more' }).click()
  await expect(page.getByRole('menuitem', { name: /Temporary chat/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // a follow-up message does not carry the flag
  // (the chat exists: the server ignores it anyway, the client does not send it)
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect.poll(() => server.deleted).toEqual([TEMP_ID])
  expect(server.sessions.map((s) => s.id)).toEqual([NORMAL_ID])
  await expect(rowBadge(page)).toHaveCount(0)
  await expect(headerBadge(page)).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC5: opening another chat deletes the temporary one; opening a normal chat deletes nothing', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL)
  await startTemporaryAndSend(page, server)
  await page.locator('nav li', { hasText: 'Quarterly numbers' }).getByRole('button').first().click()
  await expect.poll(() => server.deleted).toEqual([TEMP_ID])
  // now on a normal chat: leaving it deletes nothing
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await expect(page).toHaveURL(/#\/chat$/)
  await roundTrip(page)
  expect(server.deleted).toEqual([TEMP_ID])
  await ctx.close()
})

test('AC5: closing the tab (pagehide) deletes the temporary chat with a keepalive request; a normal chat is left alone', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL)
  await startTemporaryAndSend(page, server)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await expect.poll(() => server.deleted).toEqual([TEMP_ID])
  await ctx.close()

  const b = await open(browser, baseURL)
  await b.page.locator('nav li', { hasText: 'Quarterly numbers' }).getByRole('button').first().click()
  await b.page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await roundTrip(b.page)
  expect(b.server.deleted).toEqual([])
  await b.ctx.close()
})

test('a temporary chat is not listed in the history page', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL)
  await startTemporaryAndSend(page, server)
  await page.goto(`${baseURL}/#/history`)
  await expect(page.getByRole('main').getByText('Quarterly numbers').first()).toBeVisible()
  await expect(page.getByRole('main').getByText('Nova conversa')).toHaveCount(0)
  await ctx.close()
})

for (const variant of VARIANTS) {
  test(`AC6: the badge is localized with an accessible name and axe is clean (${variantName(variant)})`, async ({ browser, baseURL }) => {
    const { ctx, page, server } = await open(browser, baseURL, variant)
    await startTemporaryAndSend(page, server)
    const scan = async (label, scope) => {
      await animationsDone(page)
      const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).include(scope).analyze()
      expect(
        r.violations
          .filter((v) => ['serious', 'critical'].includes(v.impact))
          .map((v) => `${label} ${v.id}: ${v.nodes.map((n) => `${n.target} ${n.any[0]?.message ?? ''}`).join(' | ')}`)
      ).toEqual([])
    }
    // header: the word is the accessible name (phone width keeps the padlock and a screen-reader-only word)
    const hb = headerBadge(page)
    await expect(hb).toHaveCount(1)
    await expect(hb).toHaveText('Temporary')
    await expect(hb).toHaveAttribute('title', /not saved/i)
    await scan('header', 'header')
    // sidebar row: on a phone the sidebar is a drawer
    if (variant.mobile) await page.getByRole('button', { name: 'Open menu' }).click()
    const row = page.locator('nav li', { hasText: 'Nova conversa' }).getByRole('button').first()
    await expect(row).toContainText('Temporary')
    await expect(rowBadge(page)).toBeVisible()
    await scan('sidebar', 'nav')
    if (variant.mobile) await page.keyboard.press('Escape')
    await ctx.close()
  })
}

test('the badge and the + item are localized (pt-BR, es)', async ({ browser, baseURL }) => {
  for (const [locale, plus, word] of [['pt-BR', /Chat temporário/, 'Temporário'], ['es-ES', /Chat temporal/, 'Temporal']]) {
    const ctx = await browser.newContext({ locale, viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' })
    await ctx.addInitScript((await import('./lib.mjs')).FETCH_SHIM)
    const page = await ctx.newPage()
    await page.route('**/api/sessions', (route) =>
      route.fulfill({ json: { sessions: [{ id: TEMP_ID, title: 'chat', model: 'm', system_prompt: '', enabled_tools: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), project_id: null, ephemeral: true, attachment_names: [] }] } })
    )
    await page.goto(`${baseURL}/#/chat`)
    await page.locator('textarea').first().waitFor()
    await expect(page.locator('nav [data-temporary-badge]')).toHaveText(word)
    await page.locator('[aria-haspopup="menu"]').first().click()
    await expect(page.getByRole('menuitem', { name: plus })).toBeVisible()
    await ctx.close()
  }
})
