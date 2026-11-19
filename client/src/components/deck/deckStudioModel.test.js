import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDeckUndo, writeDeckUndo, clearDeckUndo, isHtmlDeckShape, restoreSlide, deckFingerprint, undoTimeLeft, UNDO_TTL_MS } from './deckStudioModel.js'

function memoryStore() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }
}

test('restoreSlide puts the slide back where it was, clamped to the deck', () => {
  assert.deepEqual(restoreSlide(['a', 'c'], 1, 'b'), ['a', 'b', 'c'])
  assert.deepEqual(restoreSlide(['a'], 5, 'b'), ['a', 'b'])
  assert.deepEqual(restoreSlide(['b'], -1, 'a'), ['a', 'b'])
})

const deck = (over = {}) => ({ id: '9', title: 'Q3', slides: ['<section>1</section>', '<section>3</section>'], ...over })

test('the undo offer survives a reload of exactly the content this tab saved', () => {
  const store = memoryStore()
  const now = 1_000_000
  const saved = deck()
  writeDeckUndo({ id: 'u1', deckId: '9', index: 1, slide: '<section>2</section>', at: now, n: 2, afterHash: deckFingerprint(saved) }, store)
  assert.equal(readDeckUndo(saved, now + 1000, store).slide, '<section>2</section>')
})

test('a same-count edit elsewhere (title, slide text or notes) drops the offer', () => {
  const now = 1_000_000
  for (const other of [
    deck({ title: 'Edited in another tab' }),
    deck({ slides: ['<section>1</section>', '<section>3 edited</section>'] }),
    deck({ slides: [{ html: '<section>1</section>', notes: 'new note' }, '<section>3</section>'] }),
  ]) {
    const store = memoryStore()
    writeDeckUndo({ id: 'u1', deckId: '9', index: 1, slide: 'x', at: now, n: 2, afterHash: deckFingerprint(deck()) }, store)
    assert.equal(other.slides.length, 2, 'same slide count')
    assert.equal(readDeckUndo(other, now + 1000, store), null)
    assert.equal(store.m.size, 0, 'and cleared')
  }
})

test('the fingerprint ignores representation only: bare string vs {html} without notes', () => {
  assert.equal(deckFingerprint(deck()), deckFingerprint(deck({ slides: [{ html: '<section>1</section>' }, '<section>3</section>'] })))
  assert.notEqual(deckFingerprint(deck()), deckFingerprint(deck({ audience: 'Board' })))
})

test('an offer whose deletion was never saved (afterHash null) is not offered', () => {
  const store = memoryStore()
  writeDeckUndo({ id: 'u1', deckId: '9', index: 1, slide: 'x', at: 1, n: 2, afterHash: null }, store)
  assert.equal(readDeckUndo(deck(), 2, store), null)
})

test('the undo offer expires (load and in-session timer share undoTimeLeft) and is cleared on undo/dismiss', () => {
  const store = memoryStore()
  const h = deckFingerprint(deck())
  writeDeckUndo({ id: 'u1', deckId: '9', index: 0, slide: 'x', at: 0, n: 1, afterHash: h }, store)
  assert.equal(readDeckUndo(deck(), UNDO_TTL_MS + 1, store), null)
  assert.ok(undoTimeLeft({ at: 0 }, UNDO_TTL_MS - 1) > 0)
  assert.ok(undoTimeLeft({ at: 0 }, UNDO_TTL_MS + 1) <= 0)
  writeDeckUndo({ id: 'u1', deckId: '9', index: 0, slide: 'x', at: 0, n: 1, afterHash: h }, store)
  clearDeckUndo('9', store)
  assert.equal(readDeckUndo(deck(), 1, store), null)
  assert.equal(readDeckUndo(null, 1, store), null)
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
