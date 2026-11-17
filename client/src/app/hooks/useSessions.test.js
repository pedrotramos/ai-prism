import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMissingConversation } from './useSessions.js'

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
