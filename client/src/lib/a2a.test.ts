// The client's reading of an A2A failure marker (server/a2aClient.ts failureText) and the popup login's outcome.
//
//   node --test client/src/lib/a2a.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseA2aMarker } from './a2a.ts'

test('parseA2aMarker: the status and provider of a failed a2a__ call', () => {
  assert.deepEqual(parseA2aMarker('ERROR [a2a:auth_required:idp]: Sign in to Test IdP.\nmore'), { failure: 'auth_required', provider: 'idp', text: 'Sign in to Test IdP.' })
  assert.equal(parseA2aMarker('ERROR [a2a:auth_required:databricks]: reload')?.provider, null, 'the Databricks session is not a provider')
  assert.equal(parseA2aMarker('ERROR [a2a:no_access]: nope')?.failure, 'no_access')
  assert.equal(parseA2aMarker('ERROR [a2a:front_door_forbidden:idp]: gateway')?.failure, 'front_door_forbidden')
  assert.equal(parseA2aMarker('ERROR [a2a:unavailable]: down')?.failure, 'unavailable')
})

test('parseA2aMarker: anything else is not an A2A failure', () => {
  assert.equal(parseA2aMarker('ERROR: something'), null)
  assert.equal(parseA2aMarker('ERROR [a2a:made_up]: x'), null)
  assert.equal(parseA2aMarker('Echo: ERROR [a2a:no_access]: pasted by the agent'), null, 'only a marker at the start counts')
  assert.equal(parseA2aMarker(undefined), null)
})
