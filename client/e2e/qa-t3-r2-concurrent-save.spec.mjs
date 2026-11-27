import { test, expect } from '@playwright/test'
import { newVariantContext, SCREENS } from './lib.mjs'

async function openAdmin(browser, baseURL) {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  const state = { origins: ['https://revoke.example.com'], envOrigins: ['https://env.example.com'], mode: 'enforce' }
  const view = () => ({
    origins: state.origins,
    envOrigins: state.envOrigins,
    effective: [...state.envOrigins, ...state.origins],
    mode: state.mode,
  })
  await page.route('**/api/me', (r) => r.fulfill({ json: { email: 'e2e-admin@example.com', isAdmin: true, isOwner: true } }))
  await page.route('**/api/admins', (r) => r.fulfill({ json: { owner: 'owner@example.com', admins: [] } }))
  await page.route('**/api/admins/candidates', (r) => r.fulfill({ json: { candidates: [] } }))
  await page.route('**/api/admin/egress/settings', (r) => r.fulfill({ json: view() }))
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Administrators', exact: true }).click()
  return { ctx, page, dialog }
}

test('QA r2: an older concurrent save can restore an origin the admin removed', async ({ browser, baseURL }) => {
  const { ctx, page, dialog } = await openAdmin(browser, baseURL)
  const card = dialog.getByTestId('egress-origins-admin-card')
  const save = card.getByRole('button', { name: 'Save', exact: true })
  const submitted = []
  let serverHeld = ['https://revoke.example.com']
  let releaseFirst
  const olderRequestGate = new Promise((resolve) => { releaseFirst = resolve })

  await page.route('**/api/admin/egress/settings', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { origins: serverHeld, envOrigins: ['https://env.example.com'], effective: ['https://env.example.com', ...serverHeld], mode: 'enforce' },
      })
    }
    const origins = route.request().postDataJSON().origins
    submitted.push([...origins])
    if (submitted.length === 1) await olderRequestGate
    serverHeld = [...origins]
    return route.fulfill({
      json: { origins, envOrigins: ['https://env.example.com'], effective: ['https://env.example.com', ...origins], mode: 'enforce' },
    })
  })

  try {
    await card.getByLabel('Allowed origin').fill('https://first.example.com')
    await card.getByRole('button', { name: 'Add', exact: true }).click()
    await save.click()
    await expect.poll(() => submitted.length).toBe(1)

    await card.getByRole('button', { name: /Remove.*revoke\.example\.com/i }).click()
    // remove() resets SaveState to idle while request one is still pending, enabling a concurrent write.
    await expect(save).toBeEnabled()
    await save.click()
    await expect.poll(() => submitted.length).toBe(2)
    await expect(card.getByText('Saved', { exact: true })).toBeVisible()
    expect(submitted).toEqual([
      ['https://revoke.example.com', 'https://first.example.com'],
      ['https://first.example.com'],
    ])

    const olderResponse = page.waitForResponse((r) =>
      r.request().method() === 'PUT' && r.request().postDataJSON().origins.length === 2
    )
    releaseFirst()
    await olderResponse
    expect(serverHeld).toEqual(['https://revoke.example.com', 'https://first.example.com'])

    await page.reload()
    await page.locator('button[title="Settings"]').first().click()
    const reloaded = page.getByRole('dialog', { name: 'Settings' })
    await reloaded.getByRole('button', { name: 'Administrators', exact: true }).click()
    const reloadedCard = reloaded.getByTestId('egress-origins-admin-card')
    await expect(reloadedCard.getByText('https://first.example.com', { exact: true })).toBeVisible()
    // Expected contract: an admin's removal must survive both successful saves.
    await expect(reloadedCard.getByText('https://revoke.example.com', { exact: true })).toHaveCount(0)
  } finally {
    releaseFirst()
    await ctx.close()
  }
})
