import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMissingConversation, shouldRecordConfirmedStyle, withSessionPrompt } from './useSessions.ts'

const sessions = [{ id: '24' }, { id: '25' }]

test('an id that is not in the list and has no messages is missing', () => {
  assert.equal(isMissingConversation({ id: '999999', sessions, messages: [] }), true)
})

test('an id in the list is not missing even when it has no messages yet', () => {
  assert.equal(isMissingConversation({ id: '25', sessions, messages: [] }), false)
})

test('an id outside the (paged) list that has messages is not missing', () => {
  assert.equal(isMissingConversation({ id: '3', sessions, messages: [{ id: '1', role: 'user' }] }), false)
})

test('ids compare as strings (the hash gives "25", an API may give 25)', () => {
  assert.equal(isMissingConversation({ id: '25', sessions: [{ id: 25 }], messages: [] }), false)
})

test('a load that failed with a not-found error is missing; any other failure is not', () => {
  assert.equal(isMissingConversation({ id: 'abc', sessions, messages: [], error: new Error('invalid input syntax for type bigint: "abc"') }), true)
  assert.equal(isMissingConversation({ id: '999', sessions, messages: [], error: new Error('HTTP 503') }), false)
})

test('a server error whose text merely says "not found" is a load error, not a missing chat', () => {
  assert.equal(isMissingConversation({ id: '5', sessions, messages: [], error: new Error('Genie space not found') }), false)
  assert.equal(isMissingConversation({ id: '5', sessions, messages: [], error: new Error('HTTP 404') }), true)
})

// W2-4 item 8: a style the server accepted must survive leaving and reopening the chat. The loader reads the
// prompt from the sessions snapshot, so a confirmed save has to land in that snapshot (a failed one must not).
test('withSessionPrompt puts a confirmed style into the snapshot row of that chat only', () => {
  const list = [
    { id: '24', title: 'a', system_prompt: null },
    { id: 25, title: 'b', system_prompt: 'old' },
  ]
  const next = withSessionPrompt(list, '25', 'Executive')
  assert.equal(next[1]!.system_prompt, 'Executive') // ids compare as strings (number in the row, string from the URL)
  assert.equal(next[0], list[0]) // untouched rows keep their identity
  assert.notEqual(next, list)
  assert.equal(list[1]!.system_prompt, 'old') // the input is not mutated
})

test('withSessionPrompt leaves the list as it is when the chat is not in it', () => {
  const list = [{ id: '24', system_prompt: 'x' }]
  assert.equal(withSessionPrompt(list, '999', 'y'), list)
  assert.equal(withSessionPrompt(list, null, 'y'), list)
})

test('shouldRecordConfirmedStyle: an older save that lands after a newer accepted one does not overwrite it', () => {
  assert.equal(shouldRecordConfirmedStyle(0, 1), true)
  assert.equal(shouldRecordConfirmedStyle(2, 3), true)
  assert.equal(shouldRecordConfirmedStyle(3, 2), false)
  assert.equal(shouldRecordConfirmedStyle(3, 3), false)
})
