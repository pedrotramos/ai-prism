// The next-runs card the owner sees while editing and the admin sees on the review card: the description, three instants in
// the schedule's zone, and, for a cron that restricts both day fields, the notice that it runs on days matching EITHER.
// A .tsx Node cannot import: bundled with esbuild together with React so both share one instance (as ChartBlock.test.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let dir: string | undefined
// any: a test-only dynamic import of the bundled component and React helpers
let mod: any

before(async () => {
  const out = await build({
    stdin: {
      contents:
        "export { default as Card } from './SchedulePreviewCard.tsx'\nexport { I18nProvider } from '../../lib/i18n.tsx'\nexport { createElement } from 'react'\nexport { renderToStaticMarkup } from 'react-dom/server'\n",
      resolveDir: HERE,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  dir = mkdtempSync(path.join(tmpdir(), 'schedulepreview-test-'))
  const file = path.join(dir, 'card.mjs')
  writeFileSync(file, (out.outputFiles[0] as { text: string }).text)
  mod = await import(pathToFileURL(file).href)
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const DATA = { description: 'Custom schedule: 0 9 1,15 * 1 (UTC)', next: ['2026-12-01T09:00:00.000Z', '2026-12-07T09:00:00.000Z', '2026-12-14T09:00:00.000Z'] }
const html = (cron: string, uiLang = 'en', preview: object = { state: 'ok', data: DATA }) =>
  mod.renderToStaticMarkup(mod.createElement(mod.I18nProvider, { uiLang }, mod.createElement(mod.Card, { schedule: { freq: 'custom', cron, tz: 'UTC' }, preview })))

test('the card shows the description and the next three runs', () => {
  const out = html('0 9 1,15 * 1')
  assert.match(out, /Next runs/)
  assert.match(out, /Custom schedule: 0 9 1,15 \* 1 \(UTC\)/)
  assert.equal((out.match(/<li/g) ?? []).length, 3)
})

test('both day fields set: the approver and the owner are told it runs on either', () => {
  assert.match(html('0 9 1,15 * 1'), /runs on the days that match either one/)
  assert.match(html('0 9 1,15 * 1', 'pt'), /roda nos dias que combinam com qualquer um/)
  assert.match(html('0 9 1,15 * 1', 'es'), /se ejecuta en los días que coinciden con cualquiera/)
})

test('one day field set (or a *-led one): no such notice', () => {
  assert.doesNotMatch(html('0 9 * * 1'), /either/)
  assert.doesNotMatch(html('0 9 1,15 * *'), /either/)
  assert.doesNotMatch(html('0 9 */2 * 1'), /either/, 'a *-led day field makes it AND')
})

test('an unavailable preview says so, unless the cron field already shows the reason', () => {
  assert.match(html('0 9 * * 1', 'en', { state: 'error' }), /could not be checked/)
  const quiet = mod.renderToStaticMarkup(
    mod.createElement(mod.I18nProvider, { uiLang: 'en' }, mod.createElement(mod.Card, { schedule: { freq: 'custom', cron: 'x', tz: 'UTC' }, preview: { state: 'error', code: 'cron_invalid' }, hideError: true })),
  )
  assert.doesNotMatch(quiet, /could not be checked/)
})
