import { test } from 'node:test'
import assert from 'node:assert/strict'
import catalogs from '../../lib/locales/index.ts'
import {
  DECK_NOTE_MAX_BYTES,
  DECK_IMAGE_MAX_BYTES,
  DECK_MAX_IMAGES,
  noteOverBudget,
  imagesOverBudget,
  filesOverBudget,
  budgetRejection,
  budgetMessage,
  DECK_REQUEST_MAX_BYTES,
  requestOverBudget,
  deckRequest,
} from './deckInputBudgets.js'

const MiB = 1024 * 1024
// the catalogs as the app's t() reads them: {name} interpolation (lib/i18n.tsx)
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
  assert.deepEqual(imagesOverBudget([...four, { dataUrl: imageOf(3) }]), { code: 'deck_too_many_images', limit: 4, image: 5 })
})

test('an SVG attachment counts its separate raster vision copy; a raster whose copy is itself counts once', () => {
  const svg = 'data:image/svg+xml;base64,' + 'P'.repeat(((5 * MiB - 2) / 3) * 4)
  assert.equal(imagesOverBudget([{ dataUrl: svg, visionUrl: imageOf(1.5 * MiB) }])?.code, 'deck_image_too_large')
  const raster = imageOf(6 * MiB)
  assert.equal(imagesOverBudget([{ dataUrl: raster, visionUrl: raster }]), null)
})

test('picked files: only the ones that get a slot are admitted; over 6 MiB are named, past the 4th are counted', () => {
  const f = (name, size) => ({ name, size, type: 'image/png' })
  const names = (r) => ({ ...r, admitted: r.admitted.map((x) => x.name) })
  assert.deepEqual(names(filesOverBudget(3, [f('ok.png', 6 * MiB), f('big.png', 6 * MiB + 1), f('late.png', 10)])), { admitted: ['ok.png'], tooLarge: ['big.png'], overCount: 1 })
  assert.deepEqual(names(filesOverBudget(0, [f('a.png', 1)])), { admitted: ['a.png'], tooLarge: [], overCount: 0 })
  // slots already taken by an earlier batch still being read count too
  assert.deepEqual(names(filesOverBudget(3, ['x', 'y', 'z'].map((n) => f(`${n}.png`, 1)))), { admitted: ['x.png'], tooLarge: [], overCount: 2 })
  // non-images are not the budget's business
  assert.deepEqual(names(filesOverBudget(4, [{ name: 'notes.txt', size: 99 * MiB, type: 'text/plain' }])), { admitted: [], tooLarge: [], overCount: 0 })
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

// ---- N7 item 7: the total request, not only its parts

test('the request budget is the 46 MiB studioMedia class of the server', () => {
  assert.equal(DECK_REQUEST_MAX_BYTES, 46 * MiB)
})

test('the worst request the per-part budgets admit (4 x 6 MiB images + ONE 9 MiB note + 40 slides) fits', () => {
  const slides = Array.from({ length: 40 }, (_, i) => (i === 0 ? { html: '<section>' + 'a'.repeat(59_000) + '</section>', notes: 'n'.repeat(9 * MiB) } : '<section>' + 'a'.repeat(59_000) + '</section>'))
  const images = [0, 1, 2, 3].map((i) => ({ dataUrl: imageOf(6 * MiB, 'ABCD'[i]) }))
  assert.equal(requestOverBudget({ instruction: 'x', slides, images }), null)
})

test('two 9 MiB notes next to 4 x 6 MiB images exceed the class: a coded violation, before sending', () => {
  const slides = [0, 1].map(() => ({ html: '<section/>', notes: 'n'.repeat(9 * MiB) }))
  const images = [0, 1, 2, 3].map((i) => ({ dataUrl: imageOf(6 * MiB, 'ABCD'[i]) }))
  assert.deepEqual(requestOverBudget({ instruction: 'x', slides, images }), { code: 'deck_request_too_large', limit: DECK_REQUEST_MAX_BYTES })
})

test('requestOverBudget counts UTF-8 bytes, not characters', () => {
  // 16M euro signs = 16M chars but 48M bytes
  assert.equal(requestOverBudget({ slides: [{ html: '<section/>', notes: '€'.repeat(16 * MiB) }] })?.code, 'deck_request_too_large')
  assert.equal(requestOverBudget({ slides: ['<section/>'] }), null)
})

test('the request copy names the limit in every language', () => {
  for (const locale of ['en', 'pt', 'es']) {
    const m = budgetMessage((k, v) => translate(locale, k, v), { code: 'deck_request_too_large', limit: DECK_REQUEST_MAX_BYTES })
    assert.match(m, /46 MiB/, locale)
  }
  assert.notEqual(
    budgetMessage((k, v) => translate('pt', k, v), { code: 'deck_request_too_large', limit: DECK_REQUEST_MAX_BYTES }),
    budgetMessage((k, v) => translate('en', k, v), { code: 'deck_request_too_large', limit: DECK_REQUEST_MAX_BYTES }),
  )
})

test('deckRequest refuses an over-budget body without calling fetch, with the violation on the error', async () => {
  const realFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => ((called = true), { ok: true, json: async () => ({}) })
  try {
    const slides = [0, 1].map(() => ({ html: '<section/>', notes: 'n'.repeat(9 * MiB) }))
    const images = [0, 1, 2, 3].map((i) => ({ dataUrl: imageOf(6 * MiB, 'ABCD'[i]) }))
    await assert.rejects(deckRequest('POST', '/api/decks/1/tweak', { slides, images }), (e) => e.budget?.code === 'deck_request_too_large')
    assert.equal(called, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a bare 413 from the server (the body class answers without a code) is read as the request budget', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 413, json: async () => { throw new Error('html, not json') } })
  try {
    await assert.rejects(deckRequest('PATCH', '/api/decks/1', { slides: ['<section/>'] }), (e) => e.budget?.code === 'deck_request_too_large' && e.status === 413)
  } finally {
    globalThis.fetch = realFetch
  }
})
