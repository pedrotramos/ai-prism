// The app chrome has its own look (indigo accent, IBM Plex). Generated
// artifacts (slides, DS previews, template cards) follow the design system a
// workspace uploads, so none of their renderers may read an app token or name
// an app font. A renderer that did would paint every company's deck indigo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)) // client/src/
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const isSource = (p: string) => /\.(tsx?|jsx?|css)$/.test(p) && !/\.test\.[tj]sx?$/.test(p)
// HtmlSlideInspector.tsx is the editor's side panel (layer tree and properties):
// app chrome that sits beside the slide, not a renderer of it, so it uses app tokens.
const CHROME = new Set(['components/deck/HtmlSlideInspector.tsx'])
const TARGETS = [
  ...walk(join(root, 'components/deck')).filter(isSource),
  join(root, 'components/HtmlDeckPreview.tsx'),
  join(root, 'components/TemplateSlidePreview.tsx'),
  join(root, 'lib/themePreview.ts'),
].filter((f) => !CHROME.has(f.slice(root.length)))

// Tokens only the app chrome defines: never allowed in a renderer.
const APP_ONLY = /var\(\s*--(?:raised|sunk|spectrum|spectrum-conic|action|on-action|code-bg|chart-neg|accent-soft|accent-text|accent-strong|surface-[23]|bubble-user)\b/
// `--accent` is also a design-system role name. Inside a slide iframe it is
// the DS's own value when it carries a fallback (`var(--accent, #2D7FF9)`);
// a bare `var(--accent)` in renderer code would be read as the app's.
const APP_ACCENT = /var\(\s*--accent\s*\)/
const APP_FONT = /IBM Plex/i

test('the isolation gate covers real files', () => {
  assert.ok(TARGETS.length >= 8, `only ${TARGETS.length} files matched`)
  for (const f of TARGETS) assert.ok(statSync(f).isFile(), f)
})

for (const f of TARGETS) {
  const rel = f.slice(root.length)
  test(`${rel} reads no app token and names no app font`, () => {
    const src = readFileSync(f, 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      assert.doesNotMatch(line, APP_ONLY, `${rel}:${i + 1} reads an app token: ${line.trim()}`)
      assert.doesNotMatch(line, APP_ACCENT, `${rel}:${i + 1} reads the app --accent: ${line.trim()}`)
      assert.doesNotMatch(line, APP_FONT, `${rel}:${i + 1} names an app font: ${line.trim()}`)
    })
  })
}

test('the app token set it guards is real: every guarded token is defined in tokens.css', () => {
  const css = readFileSync(join(root, 'styles/tokens.css'), 'utf8')
  for (const t of ['raised', 'spectrum', 'action', 'accent']) {
    assert.match(css, new RegExp(`--${t}\\s*:`), `--${t}`)
  }
})
