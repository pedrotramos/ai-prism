import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertCompactionDivider, parseCompactCommand, compactionMarker } from './compaction.ts'

const m = (id: number, role: string) => ({ id: String(id), role, content: `m${id}` })

test('the divider goes right after its anchor message', () => {
  const list = [m(1, 'user'), m(2, 'assistant'), m(3, 'user'), m(4, 'assistant')]
  const out = insertCompactionDivider(list, { id: '9', uptoMessageId: '2', content: 'R', auto: false, messages: 2 })
  assert.deepEqual(out.map((x) => x.id), ['1', '2', 'compaction-9', '3', '4'])
  assert.equal(out[2]!.role, 'compaction')
})

test('a divider already in the list is not added twice', () => {
  const list = [m(1, 'user'), m(2, 'assistant')]
  const once = insertCompactionDivider(list, { id: '9', uptoMessageId: '2', content: 'R' })
  const twice = insertCompactionDivider(once, { id: '9', uptoMessageId: '2', content: 'R' })
  assert.equal(twice.length, 3)
})

test('a divider whose anchor is not in view is appended at the end', () => {
  const list = [m(1, 'user')]
  const out = insertCompactionDivider(list, { id: '5', uptoMessageId: '99', content: 'R' })
  assert.equal(out.at(-1)!.role, 'compaction')
})

test('the marker keeps the auto flag and the anchor as a string', () => {
  const k = compactionMarker({ id: 7, uptoMessageId: 12, content: 'R', auto: true, messages: 4 })
  assert.equal(k.compaction.auto, true)
  assert.equal(k.compaction.uptoMessageId, '12')
  assert.equal(k.id, 'compaction-7')
})

test('parseCompactCommand recognises /compactar with optional instructions', () => {
  assert.equal(parseCompactCommand('/compactar'), '')
  assert.equal(parseCompactCommand('  /Compactar  foco em preços  '), 'foco em preços')
  assert.equal(parseCompactCommand('/compactarx'), null)
  assert.equal(parseCompactCommand('compactar a conversa'), null)
  assert.equal(parseCompactCommand('oi'), null)
})
