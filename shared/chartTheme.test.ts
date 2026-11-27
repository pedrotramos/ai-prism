// The exported-chart palette must stay the AI Prism light tokens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXPORT_THEME, SERIES_TOKENS, THEME_TOKENS } from './chartTheme.ts'
import { contrastRatio } from './chartValue.ts'

const css = readFileSync(fileURLToPath(new URL('../client/src/styles/tokens.css', import.meta.url)), 'utf8')
const light = css.slice(css.indexOf(":root[data-theme='light']"), css.indexOf('/* ---------- Theme-independent'))
const token = (name: string) => light.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase()

test('every exported-chart colour is the value of its light-theme token', () => {
  for (const [key, name] of Object.entries(THEME_TOKENS)) {
    assert.equal((EXPORT_THEME as unknown as Record<string, string>)[key], token(name), `${key} = ${name}`)
  }
  assert.deepEqual(EXPORT_THEME.series, SERIES_TOKENS.map(token))
})

test('series colours and text are legible on the white figure background (WCAG non-text 3:1, text 4.5:1)', () => {
  for (const c of EXPORT_THEME.series) assert.ok(contrastRatio(c, EXPORT_THEME.bg) >= 3, c)
  for (const c of [EXPORT_THEME.text, EXPORT_THEME.muted, EXPORT_THEME.faint]) assert.ok(contrastRatio(c, EXPORT_THEME.bg) >= 4.5, c)
})
