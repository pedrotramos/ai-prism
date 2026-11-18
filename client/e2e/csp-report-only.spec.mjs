// W1-4: the deck preview, the deck HTML editor and the design-system preview
// keep working under the production headers (enforced CSP from h1 plus the new
// report-only policy). Report-only must never block: every violation the
// browser raises has disposition "report", and nothing throws on the page.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, SCREENS } from './lib.mjs'

const { ids } = loadFixtures()

// collects securitypolicyviolation events from the page and every frame
const VIOLATION_PROBE = `(() => {
  const push = (e) => {
    try {
      const top = window.top
      ;(top.__cspViolations = top.__cspViolations || []).push({ directive: e.effectiveDirective, disposition: e.disposition })
    } catch {}
  }
  document.addEventListener('securitypolicyviolation', push, true)
})()`

async function open(browser) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  await ctx.addInitScript(VIOLATION_PROBE)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

async function enforcedViolations(page) {
  const seen = await page.evaluate(() => window.__cspViolations || [])
  return seen.filter((v) => v.disposition !== 'report')
}

test('every response carries the report-only CSP next to the enforced one', async ({ request, baseURL }) => {
  for (const path of ['/', '/api/me']) {
    const r = await request.get(`${baseURL}${path}`)
    const h = r.headers()
    expect(h['content-security-policy-report-only'], path).toContain("default-src 'self'; script-src 'self'")
    expect(h['content-security-policy-report-only'], path).toContain('report-uri /api/csp-report')
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'self'")
    expect(h['permissions-policy'], path).toBe('microphone=(self), camera=()')
  }
})

test('deck studio preview and the HTML editor render the slide under report-only CSP', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS['deck-studio'](page, baseURL, ids)
  const title = 'Revenue grew 8.4% QoQ, led by LATAM and EMEA'
  const frameWith = async (text) => {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue
      if (await f.getByText(text).first().isVisible().catch(() => false)) return true
    }
    return false
  }
  await expect.poll(() => frameWith(title), { timeout: 15_000 }).toBe(true)

  await page.getByTitle('Edit the slide directly: click any element to adjust it').click()
  await expect(page.getByText('Elements').first()).toBeVisible()
  await expect.poll(() => frameWith(title), { timeout: 15_000 }).toBe(true)

  expect(await enforcedViolations(page)).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})

test('the design-system preview (sandboxed srcdoc) renders under report-only CSP', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  // a DS whose specimen card (dsCards, rendered with allow-scripts) has inline
  // styles, a data: image and an inline script, like a real imported design
  // system; enforcing the policy would block that script
  const card =
    '<section style="width:1280px;height:720px;background:#123;color:#fff;font:600 64px system-ui;padding:80px">' +
    '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:8px;height:8px">' +
    '<span id="ds-probe">Specimen slide</span><script>document.getElementById("ds-probe").dataset.ran="1"</script></section>'
  await page.route('**/api/deck-templates', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ templates: [{ id: 501, name: 'Probe DS', scope: 'user', dsCards: [{ group: 'Templates', html: card }], primaryColor: '#123' }] }),
    })
  )
  await page.goto(`${baseURL}/#/chat`)
  await page.locator('textarea').first().waitFor()
  await page.locator('button[title="Settings"]').first().click()
  await page.getByRole('button', { name: 'Design system', exact: true }).first().click()
  const frame = page.frameLocator('iframe[title="Probe DS"]')
  await expect(frame.getByText('Specimen slide')).toBeVisible({ timeout: 15_000 })
  // the DS's own inline script ran: report-only did not block it
  await expect(frame.locator('#ds-probe')).toHaveAttribute('data-ran', '1')
  expect(await enforcedViolations(page)).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})
