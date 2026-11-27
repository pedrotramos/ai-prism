// md-exfil T3: the admin card for external asset origins (Administrators tab). Built client + page.route for the
// egress endpoint (the recorded fixtures do not carry it), so the shared fixture file and its "no misses" check stay intact.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, newVariantContext, SCREENS } from './lib.mjs'

const LIGHT = { theme: 'light', mobile: false }

async function stub(page, { me = { email: 'e2e-user@example.com', isAdmin: true, isOwner: true }, settings = {}, puts = [], calls = [] } = {}) {
  const state = { origins: [], envOrigins: ['https://env.example.com'], mode: 'enforce', ...settings }
  const view = () => ({ origins: state.origins, envOrigins: state.envOrigins, effective: [...state.envOrigins, ...state.origins], mode: state.mode })
  await page.route('**/api/me', (r) => r.fulfill({ json: me }))
  await page.route('**/api/admins', (r) => r.fulfill({ json: { owner: 'owner@example.com', admins: [] } }))
  await page.route('**/api/admins/candidates', (r) => r.fulfill({ json: { candidates: [] } }))
  await page.route('**/api/admin/egress/settings', (r) => {
    calls.push(r.request().method())
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON()
      puts.push(body)
      const bad = body.origins.filter((o) => /server-rejects/.test(o))
      if (bad.length) return r.fulfill({ status: 400, json: { error: 'invalid_origin', code: 'invalid_origin', rejected: bad } })
      state.origins = body.origins
    }
    return r.fulfill({ json: view() })
  })
}

async function open(browser, baseURL, opts) {
  const ctx = await newVariantContext(browser, LIGHT)
  const page = await ctx.newPage()
  const puts = []
  const calls = []
  await stub(page, { puts, calls, ...opts })
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Administrators', exact: true }).click()
  return { ctx, page, dialog, puts, calls }
}

test('T3: an admin adds an origin, saves, and sees it persisted (reload keeps it)', async ({ browser, baseURL }) => {
  const { ctx, dialog, puts, page } = await open(browser, baseURL)
  const card = dialog.getByTestId('egress-origins-admin-card')
  await expect(card).toBeVisible()
  // env floor read-only, mode shown, exfiltration + timing help visible
  await expect(card.getByText('https://env.example.com', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: /Remove.*env\.example\.com/i })).toHaveCount(0)
  await expect(card.getByTestId('egress-mode')).toContainText(/enforce/i)
  await expect(card.getByText(/image URL/i).first()).toBeVisible()
  await expect(card.getByText(/15 s|15 seconds/i).first()).toBeVisible()

  await card.getByLabel('Allowed origin').fill('https://fonts.example.com')
  await card.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(card.getByText('https://fonts.example.com', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => puts.at(-1)).toEqual({ origins: ['https://fonts.example.com'] })
  await expect(card.getByText('Saved')).toBeVisible()

  // reopen: the list comes from the server
  await page.reload()
  await page.locator('button[title="Settings"]').first().click()
  const d2 = page.getByRole('dialog', { name: 'Settings' })
  await d2.getByRole('button', { name: 'Administrators', exact: true }).click()
  await expect(d2.getByTestId('egress-origins-admin-card').getByText('https://fonts.example.com', { exact: true })).toBeVisible()
  await ctx.close()
})

test('T3: a wildcard (or http, path) is refused inline and never sent', async ({ browser, baseURL }) => {
  const { ctx, dialog, puts } = await open(browser, baseURL)
  const card = dialog.getByTestId('egress-origins-admin-card')
  for (const bad of ['https://*.example.com', 'http://fonts.example.com', 'https://fonts.example.com/css']) {
    await card.getByLabel('Allowed origin').fill(bad)
    await card.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(card.getByRole('alert')).toContainText(bad)
    await expect(card.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
  }
  expect(puts).toEqual([])
  await ctx.close()
})

test('T3: the origins the server rejects are listed, nothing is shown as saved', async ({ browser, baseURL }) => {
  const { ctx, dialog, puts } = await open(browser, baseURL)
  const card = dialog.getByTestId('egress-origins-admin-card')
  await card.getByLabel('Allowed origin').fill('https://server-rejects.example.com')
  await card.getByRole('button', { name: 'Add', exact: true }).click()
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => puts.length).toBe(1)
  await expect(card.getByRole('alert')).toContainText('https://server-rejects.example.com')
  await expect(card.getByText('Saved')).toHaveCount(0)
  await ctx.close()
})

test('T3: remove then save sends the shorter list; report mode is shown', async ({ browser, baseURL }) => {
  const { ctx, dialog, puts } = await open(browser, baseURL, { settings: { origins: ['https://a.example.com', 'https://b.example.com'], mode: 'report' } })
  const card = dialog.getByTestId('egress-origins-admin-card')
  await expect(card.getByTestId('egress-mode')).toContainText(/report/i)
  await card.getByRole('button', { name: /^Remove.*a\.example\.com/i }).click()
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => puts.at(-1)).toEqual({ origins: ['https://b.example.com'] })
  await ctx.close()
})

test('T3: a non-admin never sees the card and the endpoint is never called', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, LIGHT)
  const page = await ctx.newPage()
  const calls = []
  await stub(page, { me: { email: 'user@example.com', isAdmin: false, isOwner: false }, calls })
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('button', { name: 'Administrators', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('egress-origins-admin-card')).toHaveCount(0)
  expect(calls).toEqual([])
  await ctx.close()
})

test('T3: axe finds no violation on the card (light and dark)', async ({ browser, baseURL }) => {
  for (const theme of ['light', 'dark']) {
    const ctx = await newVariantContext(browser, { theme, mobile: false })
    const page = await ctx.newPage()
    await stub(page, { settings: { origins: ['https://a.example.com'] } })
    await SCREENS.welcome(page, baseURL)
    await page.locator('button[title="Settings"]').first().click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Administrators', exact: true }).click()
    await expect(dialog.getByTestId('egress-origins-admin-card')).toBeVisible()
    const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).include('[data-testid="egress-origins-admin-card"]').analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    await ctx.close()
  }
})
