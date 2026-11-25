// QA-only regressions for W2-4. These assertions intentionally fail on the
// reviewed head and are delivered as a patch with the report.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, SCREENS } from './lib.mjs'

const { ids } = loadFixtures()

test('QA: Share waits for the project list before choosing the personal-chat flow', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  let releaseProjects
  let projectsStarted
  const projectResponse = new Promise((resolve) => { releaseProjects = resolve })
  const projectRequestStarted = new Promise((resolve) => { projectsStarted = resolve })
  await page.route('**/api/projects*', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/projects') return route.fallback()
    projectsStarted()
    await projectResponse
    return route.fulfill({
      json: {
        projects: [{ id: '3', name: 'Alpha', description: '', instructions: '', created_by: 'e2e-user@example.com', role: 'owner' }],
        limits: { nameMaxChars: 200, descriptionMaxChars: 2000, instructionsMaxChars: 20000 },
      },
    })
  })
  try {
    await page.goto(`${baseURL}/#/chat/${ids.s1}`)
    await projectRequestStarted
    await page.locator('[data-topbar-share]').click()
    releaseProjects()
    await expect(page.getByRole('dialog', { name: /Move/ })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  } finally {
    releaseProjects()
    await ctx.close()
  }
})

test('QA: new Preferences controls meet the 44 px touch-target rule on 390 px', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: true })
  const page = await ctx.newPage()
  try {
    await SCREENS['settings-preferences'](page, baseURL, ids)
    const prefs = page.getByRole('region', { name: /Preferences/ })
    const controls = [
      prefs.getByLabel('Model', { exact: true }),
      prefs.getByLabel('Read aloud', { exact: true }),
      prefs.getByRole('button', { name: 'Play a sample' }),
    ]
    for (const control of controls) {
      const box = await control.boundingBox()
      expect(box, 'control is rendered and measurable').not.toBeNull()
      expect(box.height, `${await control.getAttribute('aria-label') || await control.textContent()} height`).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
    }
  } finally {
    await ctx.close()
  }
})

test('QA: every SCREENS route has 44-by-44 px controls on 390 px', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: true })
  const violations = []
  try {
    for (const [screen, go] of Object.entries(SCREENS)) {
      const page = await ctx.newPage()
      try {
        await go(page, baseURL, ids)
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('button, select, input:not([type=hidden]), [role=button], [role=switch]')]
            .filter((e) => {
              const r = e.getBoundingClientRect()
              const cs = getComputedStyle(e)
              return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('iframe, [inert]')
            })
            .map((e) => {
              const r = e.getBoundingClientRect()
              return { label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40), width: Math.round(r.width), height: Math.round(r.height) }
            })
            .filter((r) => r.width < 44 || r.height < 44)
        )
        if (small.length) violations.push({ screen, controls: small })
      } finally {
        await page.close()
      }
    }
    expect(violations, 'all visible controls must meet the 44-by-44 px touch-target minimum').toEqual([])
  } finally {
    await ctx.close()
  }
})

