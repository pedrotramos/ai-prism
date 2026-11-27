// md-exfil T9: importing a design-system kit that still points at external
// http(s) content (Google Fonts <link>, CDN url() fonts) warns, non-blocking,
// listing what will not load. A clean kit shows no warning.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import JSZip from 'jszip'
import { AXE_TAGS, newVariantContext, SCREENS } from './lib.mjs'

const MANIFEST = JSON.stringify({ namespace: 'kit_ab12', globalCssPaths: ['colors_and_type.css'], cards: [{ path: 'cards/type.html', group: 'Type' }] })

async function kitZip({ external }) {
  const zip = new JSZip()
  zip.file('_ds_manifest.json', MANIFEST)
  zip.file('README.md', '# Kit\nBrand rules.')
  zip.file(
    'colors_and_type.css',
    ':root{--brand:#0e6b5c;--bg:#ffffff}' + (external ? '\n@font-face{font-family:Brand;src:url(https://cdn.example.com/brand.woff2) format("woff2")}' : ''),
  )
  zip.file(
    'cards/type.html',
    '<html><head>' +
      (external ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' : '') +
      '</head><body><h1>Type</h1></body></html>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function importKit(browser, baseURL, opts, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  await page.route('**/api/deck-templates', (r) => r.fulfill({ json: { templates: [] } }))
  await page.route('**/api/skills', (r) => r.fulfill({ json: { skills: [], isAdmin: true } }))
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  if (variant.mobile) await dialog.getByRole('group', { name: 'Settings area' }).getByRole('button', { name: 'Organization' }).click()
  await dialog.getByRole('button', { name: 'Design system', exact: true }).click()
  const buffer = await kitZip(opts)
  await dialog.locator('input[type=file][accept*=".zip"]').setInputFiles({ name: 'kit.zip', mimeType: 'application/zip', buffer })
  return { ctx, page, dialog }
}

test('a kit with a Google Fonts <link> and a CDN url() font warns with both hosts, non-blocking', async ({ browser, baseURL }) => {
  const { ctx, page, dialog } = await importKit(browser, baseURL, { external: true })
  const warn = dialog.getByTestId('ds-external-refs')
  await expect(warn).toBeVisible()
  await expect(warn).toContainText('fonts.googleapis.com')
  await expect(warn).toContainText('cdn.example.com')
  await expect(warn).toContainText('inside the .zip')
  // the import itself completed: the review form is open with the import report
  await expect(dialog.getByText('Import report')).toBeVisible()
  const res = await new AxeBuilder({ page }).include('[role="dialog"][aria-modal="true"]').withTags(AXE_TAGS).analyze()
  expect(res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await ctx.close()
})

test('a clean kit shows no external-reference warning', async ({ browser, baseURL }) => {
  const { ctx, dialog } = await importKit(browser, baseURL, { external: false })
  await expect(dialog.getByText('Import report')).toBeVisible()
  await expect(dialog.getByTestId('ds-external-refs')).toHaveCount(0)
  await ctx.close()
})

test('390 px: the warning fits the viewport without horizontal overflow', async ({ browser, baseURL }) => {
  const { ctx, page, dialog } = await importKit(browser, baseURL, { external: true }, { theme: 'light', mobile: true })
  const warn = dialog.getByTestId('ds-external-refs')
  await expect(warn).toBeVisible()
  const box = await warn.boundingBox()
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await ctx.close()
})
