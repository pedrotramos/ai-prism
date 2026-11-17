// Composer flows: the "/" command menu, the "+" menu, attachments (picker,
// paste, drag and drop), Enter/Shift+Enter/Esc, touch-target sizes, the
// disabled-send token and axe on the open menus. Each flow runs with the
// keyboard only, and the "+" menu also with the mouse. English UI (the
// harness context is en-US), so the selectors use the English copy.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, SCREENS, VARIANTS, variantName, AXE_TAGS } from './lib.mjs'

const { ids } = loadFixtures()

async function open(browser, baseURL, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await SCREENS.welcome(page, baseURL, ids)
  const box = page.getByRole('textbox', { name: 'Message' })
  return { ctx, page, errors, box }
}

const slashMenu = (page) => page.getByRole('menu', { name: 'Commands' })
const plusButton = (page) => page.getByRole('button', { name: 'Add files and more' })
const plusMenu = (page) => page.getByRole('menu', { name: 'Add files and more' })

test('the message box is a multiline textbox', async ({ browser, baseURL }) => {
  const { ctx, box, errors } = await open(browser, baseURL)
  await expect(box).toHaveAttribute('aria-multiline', 'true')
  expect(errors).toEqual([])
  await ctx.close()
})

test('keyboard: "/" opens the command menu, arrows move, Esc closes, Enter runs /help', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.type('/')
  const menu = slashMenu(page)
  await expect(menu).toBeVisible()
  const items = menu.getByRole('menuitem')
  await expect(items.filter({ hasText: '/compact' })).toHaveCount(1)
  await expect(items.filter({ hasText: '/help' })).toHaveCount(1)
  // the highlighted item is announced through aria-activedescendant
  const first = await box.getAttribute('aria-activedescendant')
  expect(first).toBeTruthy()
  await page.keyboard.press('ArrowDown')
  const second = await box.getAttribute('aria-activedescendant')
  expect(second).toBeTruthy()
  expect(second).not.toBe(first)
  await expect(page.locator(`#${second}`)).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(box).toHaveValue('/')
  // typing again reopens and filters
  await page.keyboard.type('hel')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(1)
  await page.keyboard.press('Enter')
  const help = page.getByRole('region', { name: 'Commands and shortcuts' })
  await expect(help).toBeVisible()
  await expect(box).toHaveValue('')
  await expect(box).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the command filter is accent- and case-insensitive and knows every language', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.fill('/AJÚ')
  await expect(slashMenu(page).getByRole('menuitem')).toHaveCount(1)
  await expect(slashMenu(page).getByRole('menuitem').first()).toContainText('/help')
  await box.fill('/compactar')
  await expect(slashMenu(page).getByRole('menuitem').first()).toContainText('/compact')
  await box.fill('/nothing-matches')
  await expect(slashMenu(page)).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('a typed command with trailing spaces runs on Enter and is not sent to the model', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.type('/help   ')
  await expect(slashMenu(page)).toBeHidden()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Commands and shortcuts' })).toBeVisible()
  expect(await page.evaluate(() => !!window.__sse)).toBe(false)
  expect(errors).toEqual([])
  await ctx.close()
})

test('/compact in English reaches the compaction path without a confirm dialog', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  let dialogs = 0
  page.on('dialog', (d) => {
    dialogs++
    d.dismiss()
  })
  await box.fill('/compact ')
  await box.press('Enter')
  // a brand-new chat has nothing to compact: the app's toast answers, no turn starts
  await expect(page.getByText('Send a message before compacting')).toBeVisible()
  expect(await page.evaluate(() => !!window.__sse)).toBe(false)
  expect(dialogs).toBe(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('the command menu renders within 100 ms of the keystroke', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.evaluate(() => {
    window.__slashTiming = {}
    document.addEventListener('keydown', (e) => {
      if (e.key === '/') window.__slashTiming.down = performance.now()
    }, { capture: true })
    new MutationObserver(() => {
      if (!window.__slashTiming.shown && document.querySelector('[role="menu"][aria-label="Commands"]')) {
        window.__slashTiming.shown = performance.now()
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.keyboard.type('/')
  await expect(slashMenu(page)).toBeVisible()
  const { down, shown } = await page.evaluate(() => window.__slashTiming)
  expect(shown - down).toBeLessThan(100)
  expect(errors).toEqual([])
  await ctx.close()
})

test('Enter sends, Shift+Enter adds a line, and the user bubble shows before the server answers', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.type('first line')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  await expect(box).toHaveValue('first line\nsecond line')
  expect(await page.evaluate(() => !!window.__sse)).toBe(false)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !!window.__sse)
  // no SSE event yet (not even meta): the bubble is already in the thread
  await expect(page.getByText('second line').first()).toBeVisible()
  await expect(box).toHaveValue('')
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'token', value: 'Noted.' })
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  }, ids.s2)
  await expect(page.getByText('Noted.')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('keyboard: the + menu opens, roves with arrows, closes on Esc and attaches a file', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.press('Tab')
  await expect(plusButton(page)).toBeFocused()
  await expect(plusButton(page)).toHaveAttribute('aria-haspopup', 'menu')
  await page.keyboard.press('Enter')
  const menu = plusMenu(page)
  await expect(menu).toBeVisible()
  await expect(plusButton(page)).toHaveAttribute('aria-expanded', 'true')
  const items = menu.getByRole('menuitem')
  const count = await items.count()
  expect(count).toBeGreaterThanOrEqual(2)
  expect(count).toBeLessThanOrEqual(7)
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(plusButton(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(items.first()).toBeFocused()
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles({ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
  await expect(page.getByRole('button', { name: 'Remove report.csv' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove report.csv' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Remove report.csv' })).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('mouse: the + menu adds images through an image-only picker', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, baseURL)
  await plusButton(page).click()
  const chooser = page.waitForEvent('filechooser')
  await plusMenu(page).getByRole('menuitem', { name: /Add images/ }).click()
  const fc = await chooser
  expect(await fc.element().getAttribute('accept')).toBe('image/*')
  await fc.setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') })
  await expect(page.getByRole('button', { name: 'Remove chart.png' })).toBeVisible()
  // clicking outside closes a menu that is open
  await plusButton(page).click()
  await expect(plusMenu(page)).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(plusMenu(page)).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('pasting an image and dropping a file both attach them', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.evaluate(() => {
    const ta = document.querySelector('textarea')
    const paste = new DataTransfer()
    paste.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }))
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: paste, bubbles: true, cancelable: true }))
    const drop = new DataTransfer()
    drop.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    ta.dispatchEvent(new DragEvent('dragover', { dataTransfer: drop, bubbles: true, cancelable: true }))
    ta.dispatchEvent(new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('button', { name: /^Remove pasted-1-/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the disabled Send uses the disabled token, not a faded accent', async ({ browser, baseURL }) => {
  for (const theme of ['dark', 'light']) {
    const { ctx, page, errors } = await open(browser, baseURL, { theme, mobile: false })
    const send = page.getByRole('button', { name: 'Send' })
    await expect(send).toBeDisabled()
    const { bg, expected, opacity } = await send.evaluate((el) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--disabled-bg)'
      document.body.appendChild(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundColor, expected, opacity: cs.opacity }
    })
    expect(bg, theme).toBe(expected)
    expect(opacity, theme).toBe('1')
    expect(errors).toEqual([])
    await ctx.close()
  }
})

for (const mobile of [false, true]) {
  test(`touch targets: send, attach, mic and voice are >= ${mobile ? 44 : 32} px at ${mobile ? 390 : 1440} px`, async ({ browser, baseURL }) => {
    const { ctx, page, box, errors } = await open(browser, baseURL, { theme: 'dark', mobile })
    await box.fill('x')
    const min = mobile ? 44 : 32
    const names = ['Send', 'Add files and more', 'Voice mode — talk with the AI']
    if (await page.getByRole('button', { name: 'Dictate (speech to text)' }).count()) names.push('Dictate (speech to text)')
    for (const name of names) {
      const b = await page.getByRole('button', { name, exact: true }).boundingBox()
      expect(b, name).toBeTruthy()
      expect(Math.round(b.width), `${name} width`).toBeGreaterThanOrEqual(min)
      expect(Math.round(b.height), `${name} height`).toBeGreaterThanOrEqual(min)
    }
    expect(errors).toEqual([])
    await ctx.close()
  })
}

for (const variant of VARIANTS) {
  test(`axe: composer with each menu open has no serious/critical issue (${variantName(variant)})`, async ({ browser, baseURL }) => {
    const { ctx, page, box, errors } = await open(browser, baseURL, variant)
    const scan = async (label) => {
      const res = await new AxeBuilder({ page }).include('[data-composer]').withTags(AXE_TAGS).analyze()
      const severe = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(severe.map((v) => `${v.id} (${v.nodes.length})`), label).toEqual([])
    }
    await box.fill('/')
    await expect(slashMenu(page)).toBeVisible()
    await scan('slash menu')
    await box.fill('')
    await plusButton(page).click()
    await expect(plusMenu(page)).toBeVisible()
    await scan('plus menu')
    await page.keyboard.press('Escape')
    await box.fill('/help ')
    await box.press('Enter')
    await expect(page.getByRole('region', { name: 'Commands and shortcuts' })).toBeVisible()
    await scan('help panel')
    expect(errors).toEqual([])
    await ctx.close()
  })
}
