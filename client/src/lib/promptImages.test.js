// Wire format and size budget of the AI-edit image attachments (deck and
// spreadsheet tweaks): a raster image travels ONCE, and the attachments of one
// request always fit the studio body limit with the deck JSON beside them.
//
//   node --test client/src/lib/promptImages.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { tweakImagePayload, wireChars, admitPromptImages, MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGE_CHARS } from './promptImages.js'

const MiB = 1024 * 1024
// the data URL of a 6 MiB raster file, the largest the picker admits
const raster = (bytes = 6 * MiB, tag = 'a') => 'data:image/png;base64,' + tag.repeat(Math.ceil(bytes / 3) * 4)
const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
const png = 'data:image/png;base64,iVBORw0KGgo='

test('a raster attachment is sent once: no duplicated visionUrl', () => {
  const big = raster()
  assert.deepEqual(tweakImagePayload([{ id: '1', dataUrl: big, visionUrl: big }]), [{ dataUrl: big }])
})

test('an SVG keeps its separate raster vision copy', () => {
  assert.deepEqual(tweakImagePayload([{ id: '1', dataUrl: svg, visionUrl: png }]), [{ dataUrl: svg, visionUrl: png }])
})

test('wireChars counts what goes on the wire', () => {
  const big = raster()
  assert.equal(wireChars({ dataUrl: big, visionUrl: big }), big.length)
  assert.equal(wireChars({ dataUrl: svg, visionUrl: png }), svg.length + png.length)
})

test('four 6 MiB rasters (the picker maximum) fit the budget, and the budget leaves room for the deck under 40 MiB', () => {
  const four = Array.from({ length: 4 }, (_, i) => ({ id: String(i), dataUrl: raster(6 * MiB, String(i)), visionUrl: raster(6 * MiB, String(i)) }))
  const kept = admitPromptImages([], four)
  assert.equal(kept.length, 4)
  const wire = kept.reduce((n, im) => n + wireChars(im), 0)
  assert.ok(wire <= MAX_PROMPT_IMAGE_CHARS, `wire ${wire}`)
  // 48 MiB is the studio-media limit: the attachments, 40 slides x 60,000 chars
  // and a 9 MiB speaker note (the worst QA measured; notes are not capped yet)
  assert.ok(MAX_PROMPT_IMAGE_CHARS + 40 * 60_000 + 9 * MiB + 64 * 1024 < 48 * MiB)
})

test('admitPromptImages: count cap and total budget, existing images first', () => {
  const small = (id) => ({ id, dataUrl: png, visionUrl: png })
  assert.equal(admitPromptImages([small('a'), small('b'), small('c')], [small('d'), small('e')]).length, MAX_PROMPT_IMAGES)
  const huge = { id: 'h', dataUrl: raster(6 * MiB, 'h'), visionUrl: raster(6 * MiB, 'h') }
  const budget = 2 * wireChars(huge) + 1000
  const kept = admitPromptImages([huge, { ...huge, id: 'h2' }], [{ ...huge, id: 'h3' }, small('s')], { maxChars: budget })
  assert.deepEqual(kept.map((im) => im.id), ['h', 'h2', 's'], 'an image that does not fit is skipped; a smaller one still fits')
})
