// N7 item 11: the capability of an artifact already in the thread stays warm on
// a follow-up with no artifact noun ("deixe mais escuro"). The stored deck block
// is `deck-html` (server/artifactTools.ts BLOCK_TYPE), so the stickiness and the
// intent-classifier gate must look for that type, not only the retired `deck`.
//
//   node --test server/blocks.sticky.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectCapabilities, shouldClassifyIntent } from './blocks.ts'

// `any`: loosely-typed fixtures, the tests assert shapes at runtime.
type Json = any

const history = (type: Json) => [
  { role: 'user', content: 'x' },
  { role: 'assistant', content: 'ok', blocks: [{ type, title: 't' }] },
]

test('N7-11: a deck-html block in the thread keeps the deck capability on a bare follow-up', () => {
  const caps = detectCapabilities('deixe mais escuro', history('deck-html'))
  assert.equal(caps.deck, true)
})

test('N7-11: ...and does not bleed into an explicit intent for another type', () => {
  const caps = detectCapabilities('gere uma imagem de um gato', history('deck-html'))
  assert.equal(caps.deck, false)
})

test('N7-11: a short tweak on a deck-html thread skips the intent classifier (clear by essence)', () => {
  assert.equal(shouldClassifyIntent('deixe as vendas em tom mais escuro', history('deck-html'), {}), false)
})

test('N7-11: the other artifact types keep working (control)', () => {
  assert.equal(detectCapabilities('mais formal', history('document')).document, true)
  assert.equal(detectCapabilities('mais formal', history('spreadsheet')).spreadsheet, true)
})
