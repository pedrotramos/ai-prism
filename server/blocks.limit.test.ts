// N7 item 9: more than MAX_BLOCKS (12) valid prism-blocks in one answer are no
// longer dropped silently: extractPrismBlocks reports how many were left out and
// the turn appends a localized notice (applyBlocksDroppedNotice).
//
//   node --test server/blocks.limit.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPrismBlocks } from './blocks.ts'
import { applyBlocksDroppedNotice } from './turn.ts'

// `any`: loosely-typed fixtures, the tests assert shapes at runtime.
type Json = any

const fence = (obj: Json) => '```prism-block\n' + JSON.stringify(obj) + '\n```'
const doc = (i: Json) => fence({ type: 'document', title: `Doc ${i}`, markdown: `# ${i}` })
const answer = (n: Json) => Array.from({ length: n }, (_, i) => doc(i)).join('\n\n')

test('N7-9: 14 valid blocks keep 12 and report 2 dropped', () => {
  const out = extractPrismBlocks(answer(14))
  assert.equal(out.blocks.length, 12)
  assert.equal(out.droppedBlocks, 2)
})

test('N7-9: at or under the limit nothing is reported; a malformed fence is not counted as dropped', () => {
  assert.equal(extractPrismBlocks(answer(12)).droppedBlocks, 0)
  assert.equal(extractPrismBlocks(answer(3)).droppedBlocks, 0)
  const bad = '```prism-block\n{"type":"nope"}\n```'
  assert.equal(extractPrismBlocks(answer(12) + '\n\n' + bad).droppedBlocks, 0)
})

test('N7-9: the notice names the count in the response language, is appended and sent as an event', () => {
  const sent: Json[] = []
  const send = (e: Json) => sent.push(e)
  const out = applyBlocksDroppedNotice(2, 'Resposta', send, 'pt')
  assert.match(out, /^Resposta\n\n/)
  assert.match(out, /2/)
  assert.match(out, /12/)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'error')
  assert.notEqual(applyBlocksDroppedNotice(2, 'x', () => {}, 'en'), applyBlocksDroppedNotice(2, 'x', () => {}, 'es'))
  assert.equal(applyBlocksDroppedNotice(0, 'Resposta', send, 'pt'), 'Resposta')
  assert.equal(sent.length, 1, 'nothing sent when nothing was dropped')
})
