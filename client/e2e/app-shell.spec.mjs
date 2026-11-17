// App shell: error containment, not-found, failed turns, toasts, the header at
// 390 px and its popovers. Runs on the built client with /api/* from fixtures;
// the few broken or missing backend answers these flows need are injected with
// page.route, so the shared fixture file and its "no misses" check stay intact.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, SCREENS, AXE_TAGS, VARIANTS, variantName } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx

async function open(browser, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

test('a stored message with attachments as objects does not blank the app', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  const body = JSON.parse(fx.routes[`GET /api/sessions/${ids.s2}/messages`].body)
  // the shape that used to throw React #31 and unmount the whole app
  body.messages[0] = { ...body.messages[0], attachments: JSON.stringify([{ name: 'report.pdf', size: 1024 }]) }
  await page.route(`**/api/sessions/${ids.s2}/messages`, (r) => r.fulfill({ json: body }))
  await page.goto(`${baseURL}/#/chat/${ids.s2}`)
  // Message coerces attachment items to their names (W1-8, ux#3), so the
  // message renders with the file name: no crash card, no white screen
  await expect(page.locator('main').getByText('report.pdf', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not display this message.' })).toHaveCount(0)
  expect(errors).toEqual([])
  // the rest of the shell keeps working
  await expect(page.locator('textarea').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await expect(page.locator('main').getByText(body.messages[1].content.slice(0, 20), { exact: false }).first()).toBeVisible()
  await ctx.close()
})

test('an unknown conversation id says so and leads back to history', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  // the server scopes reads by owner: an unknown or foreign id answers []
  await page.route('**/api/sessions/999999/messages', (r) => r.fulfill({ json: { messages: [] } }))
  await page.goto(`${baseURL}/#/chat/999999`)
  await expect(page.getByRole('heading', { name: 'Conversation not found' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to history' }).click()
  await expect(page).toHaveURL(/#\/history$/)
  await expect(page.getByText('Hiring plan Q1').first()).toBeVisible()
  // coming back from history is a fresh chat, not the not-found screen again
  await page.locator('header button[title="Back to conversation"]').click()
  await expect(page.getByRole('heading', { name: 'Conversation not found' })).toHaveCount(0)
  await expect(page.locator('textarea').first()).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('a failed send keeps the prompt, and Retry answers it in place', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  await page.evaluate(() => (window.__sseMode = 'http500'))
  await page.locator('textarea').first().fill('Summarise yesterday')
  await page.locator('button[title="Send"]').click()
  const card = page.getByRole('alert').filter({ hasText: 'This answer could not be generated.' })
  await expect(card).toBeVisible()
  await expect(page.locator('main').getByText('Summarise yesterday', { exact: true })).toHaveCount(1)
  // the empty assistant shell offers no Copy/Listen/Regenerate toolbar
  await expect(page.locator('main button[title="Regenerate"]')).toHaveCount(0)

  await page.evaluate(() => (window.__sseMode = 'stream'))
  // a draft typed after the failure survives the Retry
  await page.locator('textarea').first().fill('next question')
  await card.getByRole('button', { name: 'Retry' }).click()
  await page.waitForFunction(() => !!window.__sse)
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'token', value: 'Yesterday was quiet.' })
  }, ids.s2)
  await expect(page.getByText('Yesterday was quiet.')).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(page.locator('main').getByText('Summarise yesterday', { exact: true })).toHaveCount(1)
  await expect(page.locator('textarea').first()).toHaveValue('next question')
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })
  expect(errors).toEqual([])
  await ctx.close()
})

test('error toasts are announced, use the danger colour and wait while hovered', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.clock.install()
  await page.route('**/api/sessions', (r) => r.fulfill({ status: 503, json: { error: 'AI Gateway returned 503: upstream model temporarily unavailable' } }))
  await page.goto(`${baseURL}/#/chat`)
  const toast = page.getByRole('alert').filter({ hasText: 'The service is temporarily unavailable.' })
  await expect(toast).toBeVisible()
  const iconColour = await toast.locator('svg').first().evaluate((el) => getComputedStyle(el).color)
  const danger = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--danger)'
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
  expect(iconColour).toBe(danger)
  await toast.hover()
  await page.clock.fastForward(20_000)
  await expect(toast).toBeVisible()
  await page.mouse.move(5, 5)
  await page.clock.fastForward(20_000)
  await expect(toast).toHaveCount(0)
  await ctx.close()
})

for (const variant of VARIANTS.filter((v) => v.mobile)) {
  test(`header fits 390 px (${variantName(variant)})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    for (const screen of ['welcome', 'chat-rich']) {
      await SCREENS[screen](page, baseURL, ids)
      const probe = await page.evaluate(() => {
        const header = document.querySelector('main header')
        const box = (el) => el && el.getBoundingClientRect().toJSON()
        return {
          vw: window.innerWidth,
          overflow: [...header.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().right > window.innerWidth + 0.5).length,
          settings: box(header.querySelector('button[aria-label="Settings"]')),
          tools: box(header.querySelector('button[aria-haspopup="dialog"][title="Tools"]')),
          toolsIcon: box(header.querySelector('button[title="Tools"] img')),
          model: box(header.querySelector('button[aria-label^="Model:"]')),
          meter: box(header.querySelector('button[title^="Cost meter"]')),
          menu: box(header.querySelector('button[aria-label="Open menu"]')),
        }
      })
      expect(probe.overflow, `${screen}: header buttons past the viewport`).toBe(0)
      expect(probe.settings.right).toBeLessThanOrEqual(probe.vw)
      expect(probe.settings.width).toBeGreaterThanOrEqual(44)
      expect(probe.settings.height).toBeGreaterThanOrEqual(44)
      // every header control is a 44 px touch target on a phone (coarse pointer)
      for (const [name, b] of Object.entries({ settings: probe.settings, tools: probe.tools, model: probe.model, meter: probe.meter, menu: probe.menu })) {
        expect(b.width, `${screen}: ${name} width`).toBeGreaterThanOrEqual(44)
        expect(b.height, `${screen}: ${name} height`).toBeGreaterThanOrEqual(44)
      }
      expect(probe.toolsIcon.width).toBeGreaterThanOrEqual(16)
      expect(probe.meter.width, 'cost meter collapses to its icon').toBeLessThanOrEqual(48)
      expect(probe.model.right).toBeLessThanOrEqual(probe.tools.left)
    }
    await ctx.close()
  })
}

for (const variant of VARIANTS) {
  test(`header has no unnamed buttons (${variantName(variant)})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    await SCREENS['chat-rich'](page, baseURL, ids)
    const res = await new AxeBuilder({ page }).include('main header').withTags(AXE_TAGS).analyze()
    const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
    expect(res.violations.filter((v) => v.id === 'button-name')).toEqual([])
    expect(serious).toEqual([])
    await ctx.close()
  })
}

test('header popovers: dialog role, Escape closes and focus returns to the trigger', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  // the Tools popover lists the user's MCP connections (none recorded)
  await page.route('**/api/mcp/connections', (r) => r.fulfill({ json: { connections: [] } }))
  await SCREENS['chat-rich'](page, baseURL, ids)
  const header = page.locator('main header')
  for (const sel of ['button[aria-label^="Model:"]', 'button[title="Tools"]', 'button[title^="Cost meter"]']) {
    const trigger = header.locator(sel).first()
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const dialog = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`)
    await expect(dialog).toHaveAttribute('role', 'dialog')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  }
  await ctx.close()
})

test('the cost popover closes when the conversation changes', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await SCREENS['chat-rich'](page, baseURL, ids)
  const meter = page.locator('main header button[title^="Cost meter"]')
  await meter.click()
  await expect(page.getByRole('dialog', { name: 'Spent this month' })).toBeVisible()
  // browser back/forward (no click outside the popover to close it)
  await page.evaluate((id) => {
    history.pushState(null, '', `#/chat/${id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, ids.s3)
  await expect(page.getByText('Fix flaky pytest in ingestion job').last()).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Spent this month' })).toHaveCount(0)
  await ctx.close()
})

test('model picker: three recommended, the rest grouped and searchable, no Portuguese in English', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  await page.locator('main header').getByRole('button', { name: /^Model:/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Models via AI Gateway' })
  await expect(dialog.getByText('Recommended')).toBeVisible()
  await expect(dialog.locator('[data-model-item]')).toHaveCount(3)
  await expect(dialog).not.toContainText(/Modelos via|visão/)
  const total = JSON.parse(fx.routes['GET /api/models'].body).models.length
  await dialog.getByRole('button', { name: `More models (${total - 3})` }).click()
  await expect(dialog.getByRole('group', { name: 'Zhipu AI' })).toBeVisible()
  await dialog.getByRole('searchbox', { name: 'Search models' }).fill('glm')
  await expect(dialog.locator('[data-model-item]')).toHaveCount(2)
  // most models take images: only the text-only ones carry a badge
  await expect(dialog.getByText('Text only')).toHaveCount(1)
  await ctx.close()
})
