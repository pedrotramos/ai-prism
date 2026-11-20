// N5: contrastOn picks the ink with the higher real WCAG 2.x contrast ratio
// (sRGB-linearized relative luminance), not a BT.601 luminance threshold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeLuminance, contrastRatio, contrastOn, resolveDeckTheme } from './deckTheme.js'

const WHITE = '#FFFFFF'
const INK = '#1A1A1A'

// pure, mid greys, saturated brand colors, and the W3-8 audit case where the
// old threshold picked white at 3.61:1 (dark ink gives ~5.8:1).
const BACKGROUNDS = [
  '#FFFFFF', '#000000', '#808080', '#767676', '#959595', '#BDBDBD', '#555555',
  '#FF3621', '#2272B4', '#1B3139', '#E63946', '#F4A261', '#2A9D8F', '#FFD60A', '#0066CC', '#00A86B',
  '#E8743B', // 3.61:1 vs white in the audit
]

test('relativeLuminance and contrastRatio match the WCAG 2.x definitions', () => {
  assert.equal(relativeLuminance('#FFFFFF'), 1)
  assert.equal(relativeLuminance('#000000'), 0)
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#000000') - 21) < 1e-9)
  assert.ok(Math.abs(contrastRatio('#777777', '#FFFFFF') - 4.48) < 0.01) // well-known value
  assert.equal(contrastRatio('#123456', '#654321'), contrastRatio('#654321', '#123456'))
  assert.equal(relativeLuminance('FF0000'), relativeLuminance('#ff0000')) // # optional, case-insensitive
})

test('contrastOn: the chosen ink never has lower contrast than the other candidate (AC1)', () => {
  for (const bg of BACKGROUNDS) {
    const chosen = contrastOn(bg)
    const other = chosen === WHITE ? INK : WHITE
    assert.ok([WHITE, INK].includes(chosen), bg)
    assert.ok(contrastRatio(bg, chosen) >= contrastRatio(bg, other), `${bg}: ${chosen}`)
  }
})

test('contrastOn: reaches 4.5:1 whenever any candidate can (AC1)', () => {
  for (const bg of BACKGROUNDS) {
    const best = Math.max(contrastRatio(bg, WHITE), contrastRatio(bg, INK))
    if (best >= 4.5) assert.ok(contrastRatio(bg, contrastOn(bg)) >= 4.5, bg)
  }
})

test('contrastOn: the audit mid-tone that the BT.601 threshold got wrong now gets dark ink', () => {
  // old rule: 0.299r+0.587g+0.114b < 0.55 → white at ~3.6:1
  assert.ok(contrastRatio('#E8743B', WHITE) < 4)
  assert.equal(contrastOn('#E8743B'), INK)
  assert.ok(contrastRatio('#E8743B', INK) >= 5.5)
  assert.equal(contrastOn('#FFFFFF'), INK)
  assert.equal(contrastOn('#000000'), WHITE)
})

test('contrastOn: exhaustive grey ramp is always at least as good as the alternative', () => {
  for (let v = 0; v < 256; v++) {
    const h = v.toString(16).padStart(2, '0').toUpperCase()
    const bg = `#${h}${h}${h}`
    const chosen = contrastOn(bg)
    const other = chosen === WHITE ? INK : WHITE
    assert.ok(contrastRatio(bg, chosen) >= contrastRatio(bg, other), bg)
  }
})

test('contrastOn: tie goes to dark ink', () => {
  // find the grey where both candidates are closest; at an exact tie the result must be dark
  const tieL = (Math.sqrt(1.05 * (relativeLuminance(INK) + 0.05)) - 0.05) // L where ratios are equal
  assert.ok(tieL > 0 && tieL < 1)
  // tie logic is exercised through the comparator: equal ratios never pick white
  const bgs = []
  for (let v = 0; v < 256; v++) { const h = v.toString(16).padStart(2, '0'); bgs.push(`#${h}${h}${h}`) }
  for (const bg of bgs) {
    if (contrastRatio(bg, WHITE) === contrastRatio(bg, INK)) assert.equal(contrastOn(bg), INK)
  }
})

test('resolveDeckTheme ink tokens follow the new rule', () => {
  const t = resolveDeckTheme({ primaryColor: '#E8743B', secondaryColor: '#1B3139', accentColor: '#2272B4', backgroundColor: '#FFFFFF' })
  assert.equal(t.onPrimary, INK)
  assert.equal(t.onAccent, WHITE)
  assert.equal(t.onBackground, INK)
})
