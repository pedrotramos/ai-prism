// N7 item 18 (ADR-N7-18): readProjectSessions is a plain read with NO cache and no time
// window. Startup de-duplication is the readiness gate of useProjectChats (proved with
// the real shell in client/e2e/projects.spec.mjs); here only the read itself: a second
// read a second later, or at any time, goes to the server. Counts requests, never time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readProjectSessions } from './useProjectChats.ts'
import type { ChatRow } from './projectsLogic.ts'

test('N7-18: a real refresh one second after startup reads again', async () => {
  const calls: string[] = []
  const api = { sessions: async (id: string | number) => (calls.push(String(id)), { sessions: [] as ChatRow[] }) }
  await readProjectSessions('7', api)
  await readProjectSessions('7', api)
  assert.deepEqual(calls, ['7', '7'])
})

test('N7-18: a failed read retries, the error reaches the caller and nothing is remembered', async () => {
  const calls: string[] = []
  const api = { sessions: (id: string | number) => (calls.push(String(id)), Promise.reject(new Error('boom'))) }
  await assert.rejects(readProjectSessions('7', api))
  await assert.rejects(readProjectSessions('7', api))
  assert.equal(calls.length, 2)
})
