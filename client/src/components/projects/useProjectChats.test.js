// N7 item 18 (ADR-N7-18): readProjectSessions is a plain read with NO cache and no time
// window. Startup de-duplication is the readiness gate of useProjectChats (proved with
// the real shell in client/e2e/projects.spec.mjs); here only the read itself: a second
// read a second later, or at any time, goes to the server. Counts requests, never time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readProjectSessions } from './useProjectChats.js'

test('N7-18: a real refresh one second after startup reads again', async () => {
  const calls = []
  const api = { sessions: async (id) => (calls.push(id), { sessions: [] }) }
  let now = 1000
  await readProjectSessions('7', api, () => now)
  now += 1000
  await readProjectSessions('7', api, () => now)
  assert.deepEqual(calls, ['7', '7'])
})

test('N7-18: a failed read retries, the error reaches the caller and nothing is remembered', async () => {
  const calls = []
  const api = { sessions: (id) => (calls.push(id), Promise.reject(new Error('boom'))) }
  await assert.rejects(readProjectSessions('7', api))
  await assert.rejects(readProjectSessions('7', api))
  assert.equal(calls.length, 2)
})
