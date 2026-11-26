import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dsBackgroundSwatches, marginsToPadding, gridColumns } from './slideDesign.ts'

test('swatches come from the active DS tokens only, deduplicated, colours only', () => {
  const sw = dsBackgroundSwatches({
    backgroundColor: '#F9F7F4',
    primaryColor: '#1B3139',
    accentColor: '#f9f7f4', // same colour as the background: one swatch
    palette: [
      { varName: '--brand-teal', value: '#00A67E' },
      { varName: '--font-size', value: '16px' }, // not a colour
      { varName: '--ink', name: 'Ink', value: 'rgb(10, 20, 30)' },
      null,
    ],
  })
  assert.deepEqual(sw.map((s) => s.value), ['#F9F7F4', '#1B3139', '#00A67E', 'rgb(10, 20, 30)'])
  assert.deepEqual(sw.map((s) => s.label), ['background', 'primary', 'brand-teal', 'Ink'])
})

test('another DS yields its own swatches; no template, no swatches', () => {
  assert.deepEqual(dsBackgroundSwatches({ primaryColor: '#123456' }).map((s) => s.value), ['#123456'])
  assert.deepEqual(dsBackgroundSwatches(null), [])
  assert.deepEqual(dsBackgroundSwatches({ palette: [{ varName: '--x', value: 'var(--y)' }] }), [])
})

test('margins become one padding shorthand', () => {
  assert.equal(marginsToPadding({ top: 40, right: 52, bottom: 30, left: 52 }), '40px 52px 30px 52px')
})

test('grid columns sit inside the slide margins and are separated by the gutter', () => {
  const cols = gridColumns(1280, { left: 80, right: 80 }, 4, 24)
  assert.equal(cols.length, 4)
  assert.equal(cols[0]!.x, 80)
  const last = cols[3]!
  assert.ok(Math.abs(last.x + last.w - (1280 - 80)) < 1e-9)
  assert.ok(Math.abs(cols[1]!.x - (cols[0]!.x + cols[0]!.w + 24)) < 1e-9)
  assert.deepEqual(gridColumns(1280, { left: 700, right: 700 }, 4, 24), []) // no room: nothing drawn
  assert.equal(gridColumns(1280, { left: 0, right: 0 }, 99, 0).length, 24) // capped
})
