// W3-6 #4 and #5: one global placeholder rule that passes 4.5:1, and one cost term in the three locales.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pt, en, es } from './locales/index.ts'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}
const themeBlock = (sel: RegExp) => tokens.split('}').find((b) => sel.test(b)) || ''
const tok = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] as string

test('one global rule colours every input and textarea placeholder with --faint', () => {
  assert.match(css, /input::placeholder\s*,\s*textarea::placeholder\s*\{[^}]*color:\s*var\(--faint\)/)
})

test('--faint is at least 4.5:1 on --surface and --raised in both themes', () => {
  const light = themeBlock(/:root,\s*:root\[data-theme='light'\]/)
  const dark = themeBlock(/:root\[data-theme='dark'\]\s*\{/)
  for (const [name, b] of [['light', light], ['dark', dark]] as const) {
    for (const bg of ['surface', 'raised']) {
      assert.ok(ratio(tok(b, 'faint'), tok(b, bg)) >= 4.5, `${name} faint on ${bg}`)
    }
  }
})

const get = (m: unknown, k: string) => String((m as Record<string, unknown>)[k])
test('cost copy uses one term, "list price", and says negotiated discounts are excluded', () => {
  const cases: [unknown, RegExp, RegExp][] = [
    [pt, /preço de lista/i, /descontos negociados/i],
    [en, /list price/i, /negotiated discounts/i],
    [es, /precio de lista/i, /descuentos negociados/i],
  ]
  for (const [m, term, disc] of cases) {
    for (const k of ['costs.subtitle', 'meter.disclaimer']) {
      assert.match(get(m, k), term, k)
      assert.match(get(m, k), disc, k)
    }
    assert.match(get(m, 'sidebar.spendNote'), term, 'sidebar.spendNote')
  }
  assert.doesNotMatch(get(pt, 'sidebar.spendNote'), /tabela/i)
  assert.doesNotMatch(get(en, 'costs.subtitle'), /billed cost/i)
})
