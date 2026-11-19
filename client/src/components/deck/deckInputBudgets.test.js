import { test } from 'node:test'
import assert from 'node:assert/strict'
import catalogs from '../../lib/locales/index.js'
import {
  DECK_NOTE_MAX_BYTES,
  DECK_IMAGE_MAX_BYTES,
  DECK_MAX_IMAGES,
  noteOverBudget,
  imagesOverBudget,
  filesOverBudget,
  budgetRejection,
  budgetMessage,
} from './deckInputBudgets.js'

const MiB = 1024 * 1024
// the catalogs as the app's t() reads them: {name} interpolation (lib/i18n.jsx)
const translate = (locale, key, vars = {}) => catalogs[locale][key].replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
const imageOf = (bytes, tag = 'A') => 'data:image/png;base64,' + tag.repeat((bytes / 3) * 4)

test('the budgets are 9 MiB per note, 6 MiB per attachment and 4 attachments', () => {
  assert.equal(DECK_NOTE_MAX_BYTES, 9437184)
  assert.equal(DECK_IMAGE_MAX_BYTES, 6291456)
  assert.equal(DECK_MAX_IMAGES, 4)
})

test('a note of exactly 9 MiB fits; one byte more names its 1-based slide', () => {
  assert.equal(noteOverBudget(['<section/>', { html: '<section/>', notes: 'n'.repeat(9 * MiB) }]), null)
  assert.deepEqual(noteOverBudget(['<section/>', { html: '<section/>', notes: 'n'.repeat(9 * MiB + 1) }]), { code: 'deck_note_too_large', limit: 9437184, slide: 2 })
})

test('the note budget is UTF-8 bytes: 3,145,729 "€" (9 MiB + 3 bytes) is over', () => {
  assert.equal(noteOverBudget([{ html: '<section/>', notes: '€'.repeat(3145728) }]), null) // exactly 9 MiB
  assert.equal(noteOverBudget([{ html: '<section/>', notes: '€'.repeat(3145729) }])?.code, 'deck_note_too_large')
})

test('attachments: four of exactly 6 MiB fit; a 7 MiB one or a fifth is over', () => {
  const four = ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: imageOf(6 * MiB, t) }))
  assert.equal(imagesOverBudget(four), null)
  assert.deepEqual(imagesOverBudget([four[0], { dataUrl: imageOf(7 * MiB - 1) }]), { code: 'deck_image_too_large', limit: 6291456, image: 2 })
  assert.deepEqual(imagesOverBudget([...four, { dataUrl: imageOf(3) }]), { code: 'deck_too_many_images', limit: 4 })
})

test('an SVG attachment counts its separate raster vision copy; a raster whose copy is itself counts once', () => {
  const svg = 'data:image/svg+xml;base64,' + 'P'.repeat(((5 * MiB - 2) / 3) * 4)
  assert.equal(imagesOverBudget([{ dataUrl: svg, visionUrl: imageOf(1.5 * MiB) }])?.code, 'deck_image_too_large')
  const raster = imageOf(6 * MiB)
  assert.equal(imagesOverBudget([{ dataUrl: raster, visionUrl: raster }]), null)
})

test('picked files: the ones over 6 MiB are named, and the ones past the 4th are counted', () => {
  const f = (name, size) => ({ name, size, type: 'image/png' })
  assert.deepEqual(filesOverBudget(3, [f('ok.png', 6 * MiB), f('big.png', 6 * MiB + 1), f('late.png', 10)]), { tooLarge: ['big.png'], overCount: 1 })
  assert.deepEqual(filesOverBudget(0, [f('a.png', 1)]), { tooLarge: [], overCount: 0 })
  // non-images are not the budget's business
  assert.deepEqual(filesOverBudget(4, [{ name: 'notes.txt', size: 99 * MiB, type: 'text/plain' }]), { tooLarge: [], overCount: 0 })
})

test('a server 413 with a budget code becomes a violation; any other answer is not one', () => {
  assert.deepEqual(budgetRejection(413, { error: 'x', code: 'deck_note_too_large', limit: 9437184, slide: 3 }), { code: 'deck_note_too_large', limit: 9437184, slide: 3 })
  assert.equal(budgetRejection(413, { code: 'payload_too_large' }), null)
  assert.equal(budgetRejection(500, { code: 'deck_note_too_large' }), null)
  assert.equal(budgetRejection(413, null), null)
})

test('the rejection copy names the limit in every language', () => {
  for (const locale of ['en', 'pt', 'es']) {
    const t = (k, v) => translate(locale, k, v)
    const note = budgetMessage(t, { code: 'deck_note_too_large', limit: 9437184, slide: 2 })
    assert.match(note, /9 MiB/, locale)
    assert.match(note, /\b2\b/, locale)
    assert.match(budgetMessage(t, { code: 'deck_image_too_large', limit: 6291456, image: 1 }), /6 MiB/, locale)
    assert.match(budgetMessage(t, { code: 'deck_too_many_images', limit: 4 }), /\b4\b/, locale)
  }
  const en = budgetMessage((k, v) => translate('en', k, v), { code: 'deck_too_many_images', limit: 4 })
  assert.notEqual(budgetMessage((k, v) => translate('pt', k, v), { code: 'deck_too_many_images', limit: 4 }), en)
  assert.notEqual(budgetMessage((k, v) => translate('es', k, v), { code: 'deck_too_many_images', limit: 4 }), en)
  assert.equal(
    budgetMessage((k, v) => translate('en', k, v), { code: 'deck_note_too_large', limit: 9437184, slide: 2 }),
    'The speaker note on slide 2 is over the 9 MiB limit. Shorten it to save.',
  )
})
