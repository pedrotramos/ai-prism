import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDeckUndo, writeDeckUndo, clearDeckUndo, isHtmlDeckShape, restoreSlide } from './deckStudioModel.js'

function memoryStore() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }
}

test('restoreSlide puts the slide back where it was, clamped to the deck', () => {
  assert.deepEqual(restoreSlide(['a', 'c'], 1, 'b'), ['a', 'b', 'c'])
  assert.deepEqual(restoreSlide(['a'], 5, 'b'), ['a', 'b'])
  assert.deepEqual(restoreSlide(['b'], -1, 'a'), ['a', 'b'])
})

test('the undo offer survives a reload of the same deck state, and only that', () => {
  const store = memoryStore()
  const now = 1_000_000
  writeDeckUndo({ deckId: '9', index: 1, slide: '<section>2</section>', after: 2, at: now, n: 2 }, store)
  // same deck, same slide count: offered again after a reload
  assert.equal(readDeckUndo('9', 2, now + 1000, store).slide, '<section>2</section>')
  // a different count means the deck changed elsewhere: dropped, and cleared
  assert.equal(readDeckUndo('9', 3, now + 1000, store), null)
  assert.equal(store.m.size, 0)
})

test('the undo offer expires and is cleared on undo/dismiss', () => {
  const store = memoryStore()
  writeDeckUndo({ deckId: '9', index: 0, slide: 'x', after: 1, at: 0, n: 1 }, store)
  assert.equal(readDeckUndo('9', 1, 31 * 60 * 1000, store), null)
  writeDeckUndo({ deckId: '9', index: 0, slide: 'x', after: 1, at: 0, n: 1 }, store)
  clearDeckUndo('9', store)
  assert.equal(readDeckUndo('9', 1, 1, store), null)
  assert.equal(readDeckUndo(null, 1, 1, store), null)
})

test('isHtmlDeckShape: API decks (format at the top), streamed decks and slides with notes', () => {
  assert.equal(isHtmlDeckShape({ format: 'html', slides: [{ html: '<section/>', notes: 'n' }] }), true)
  assert.equal(isHtmlDeckShape({ meta: { format: 'html' }, slides: [] }), true)
  // a note on slide 1 turns it into {html, notes}: still an HTML deck (the old check said "legacy")
  assert.equal(isHtmlDeckShape({ slides: [{ html: '<section/>', notes: 'n' }, '<section/>'] }), true)
  assert.equal(isHtmlDeckShape({ slides: ['<section/>'] }), true)
  // the removed semantic-tree format
  assert.equal(isHtmlDeckShape({ slides: [{ layout: 'bullets', title: 'x' }] }), false)
  assert.equal(isHtmlDeckShape(null), false)
})
