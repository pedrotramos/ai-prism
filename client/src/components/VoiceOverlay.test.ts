// VoiceOverlay: with a `model` it shows the provider mark and the model name in
// the hint line (W1-3); without one it shows only the footer. Bundled with
// esbuild like ErrorBoundary.test.ts, rendered with react-dom/server (effects do not run).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let dir: string | undefined
let m: any // the dynamically imported esbuild bundle

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'voice-overlay-test-'))
  const out = await build({
    stdin: {
      contents: `
        export { default as VoiceOverlay } from './VoiceOverlay.tsx'
        export { I18nProvider } from '../lib/i18n.tsx'
        export { createElement } from 'react'
        export { renderToStaticMarkup } from 'react-dom/server'
      `,
      resolveDir: HERE,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'silent',
  })
  const file = path.join(dir, 'bundle.mjs')
  writeFileSync(file, out.outputFiles[0]!.text)
  m = await import(pathToFileURL(file).href)
})

after(() => dir && rmSync(dir, { recursive: true, force: true }))

const render = (props: Record<string, unknown>) =>
  m.renderToStaticMarkup(m.createElement(m.I18nProvider, { uiLang: 'en' }, m.createElement(m.VoiceOverlay, { open: true, onClose() {}, onSend: async () => '', ...props })))

test('with a model, the hint shows its mark (an svg with paths) and its name', () => {
  const html = render({ model: { id: 'databricks-claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'Anthropic' } })
  assert.match(html, /role="dialog"/)
  assert.match(html, /<svg[^>]*aria-hidden[^>]*><path /)
  assert.match(html, /Model: Claude Sonnet 5\.5/)
})

test('without a model, no model hint is drawn', () => {
  const html = render({})
  assert.doesNotMatch(html, /Model:/)
  assert.match(html, /Voice mode/)
})
