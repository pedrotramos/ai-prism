// Accessibility regression bar: axe on 4 screens × 2 themes × 2 widths, the
// touch-target / accessible-name scan, Lighthouse accessibility on 3 pages
// and the one-off style audit, compared with client/e2e/baseline.json.
// Report: client/e2e/.output/a11y-report.json (+ the GitHub step summary).
import { test, expect, chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import lighthouse from 'lighthouse'
import desktopConfig from 'lighthouse/core/config/desktop-config.js'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENS, VARIANTS, LIGHTHOUSE_PAGES, AXE_TAGS, loadFixtures, newVariantContext, touchTargets, variantName } from './lib.mjs'
import { aggregateRuns, compareToBaseline, strictFailures, baselineFor, readBaselineFile, writeBaseline } from './baseline.mjs'
import { auditTokens } from './token-audit.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '.output')
const { ids } = loadFixtures()
const runs = []
const lighthouseScores = {}
let tokens = null

test.describe.configure({ mode: 'serial' })

for (const variant of VARIANTS) {
  for (const [screen, go] of Object.entries(SCREENS)) {
    test(`axe ${screen} ${variantName(variant)}`, async ({ browser, baseURL }) => {
      const ctx = await newVariantContext(browser, variant)
      try {
        const page = await ctx.newPage()
        await go(page, baseURL, ids)
        const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
        const touch = await touchTargets(page)
        runs.push({
          screen,
          variant: variantName(variant),
          axe: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
          touch: { total: touch.total, under24: touch.under24, noName: touch.noName },
        })
      } finally {
        await ctx.close()
      }
    })
  }
}

for (const [name, url] of Object.entries(LIGHTHOUSE_PAGES)) {
  test(`lighthouse ${name} dark-desktop`, async ({ baseURL }) => {
    // Lighthouse drives Chrome over CDP on its own tab; a fresh profile means
    // the default (dark) theme, like the baseline run.
    const port = 9300 + Object.keys(LIGHTHOUSE_PAGES).indexOf(name)
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] })
    try {
      const result = await lighthouse(url(baseURL, ids), { port, output: 'json', logLevel: 'error', onlyCategories: ['accessibility'] }, desktopConfig)
      lighthouseScores[name] = Math.round(result.lhr.categories.accessibility.score * 100)
    } finally {
      await browser.close()
    }
  })
}

test('one-off style audit', async () => {
  tokens = auditTokens(path.resolve(HERE, '..', 'src'))
})

test('regression bar', async ({ baseURL }) => {
  const misses = await (await fetch(`${baseURL}/__fixtures/misses`)).json()
  const metrics = { ...aggregateRuns(runs), lighthouse: lighthouseScores, oneOff: tokens.oneOff }
  const platform = process.platform
  mkdirSync(OUT, { recursive: true })

  if (process.env.E2E_UPDATE_BASELINE === '1') {
    writeBaseline(platform, metrics, 'fixture-backed harness (client/e2e), Playwright chromium')
  }
  const file = readBaselineFile()
  const baseline = baselineFor(file, platform)
  const { regressions, improvements } = compareToBaseline(metrics, baseline)
  const strict = process.env.E2E_STRICT === '1' ? strictFailures(metrics) : []
  const report = { platform, strict: process.env.E2E_STRICT === '1', metrics, baseline, reference: file.reference, regressions, improvements, strictFailures: strict, fixtureMisses: misses, runs }
  writeFileSync(path.join(OUT, 'a11y-report.json'), JSON.stringify(report, null, 2))

  const lines = [
    '### Accessibility regression bar',
    '',
    `| metric | now | bar |`,
    `|---|---|---|`,
    ...Object.keys({ ...baseline.axe, ...metrics.axe }).sort().map((r) => `| axe ${r} | ${metrics.axe[r] || 0} | ${baseline.axe[r] || 0} |`),
    `| serious/critical nodes | ${metrics.seriousCritical} | ${baseline.seriousCritical} |`,
    `| touch targets < 24 px | ${metrics.touchUnder24} | ${baseline.touchUnder24} |`,
    `| unnamed interactive | ${metrics.unnamed} | ${baseline.unnamed} |`,
    ...Object.keys(baseline.lighthouse).map((p) => `| lighthouse ${p} | ${metrics.lighthouse[p] ?? '—'} | ${baseline.lighthouse[p]} |`),
    `| one-off styles | ${metrics.oneOff.total} | ${baseline.oneOff.total} |`,
    '',
    regressions.length ? `**Regressions:** ${regressions.join('; ')}` : 'No regressions.',
    improvements.length ? `Improvements (record with \`E2E_UPDATE_BASELINE=1\`): ${improvements.join('; ')}` : '',
    misses.length ? `Requests without a fixture: ${misses.join(', ')}` : '',
  ]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')

  expect(regressions, 'a count rose above client/e2e/baseline.json').toEqual([])
  expect(strict, 'E2E_STRICT=1').toEqual([])
})
