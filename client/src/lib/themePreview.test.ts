// The Preferences theme cards draw a miniature of each theme. Their colours
// come from styles/tokens.css (the single source), not from hex in JSX.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseThemeTokens } from './themePreview.ts'

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')

test('reads both themes from tokens.css', () => {
  const p = parseThemeTokens(css)
  assert.equal(p.dark.bg, '#0b0d0f')
  assert.equal(p.light.bg, '#f7f8fa')
  for (const theme of ['dark', 'light'] as const) {
    for (const k of ['bg', 'rail', 'line', 'bubble', 'accent']) assert.match(p[theme][k as keyof typeof p.dark], /^#[0-9a-f]{6}$/i, `${theme}.${k}`)
  }
  assert.notEqual(p.dark.rail, p.light.rail)
})

test('a missing token falls back to a neutral value instead of throwing', () => {
  const p = parseThemeTokens(':root { --bg: #000000; }')
  assert.equal(p.dark.bg, '#000000')
  assert.equal(typeof p.light.bg, 'string')
})
