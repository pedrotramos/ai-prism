// N7 item 18: at startup the hook read each project's sessions twice (once when the
// projects list arrived, once when the caller's own chat list did). A read already
// in flight for a project is now shared, so a burst of triggers is one request per
// project; a trigger after it settled reads again (a refresh after a turn/move).
// Counts requests, never time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readProjectSessions } from './useProjectChats.js'

function fakeApi() {
  const calls = []
  const gates = []
  return {
    calls,
    release: (v = { sessions: [] }) => gates.splice(0).forEach((g) => g(v)),
    sessions: (id) => {
      calls.push(id)
      return new Promise((resolve) => gates.push(resolve))
    },
  }
}

test('N7-18: two reads of the same project while one is in flight are one request', async () => {
  const api = fakeApi()
  const a = readProjectSessions('7', api)
  const b = readProjectSessions('7', api)
  assert.deepEqual(api.calls, ['7'])
  api.release({ sessions: [{ id: 1 }] })
  assert.deepEqual(await a, await b)
  assert.equal(api.calls.length, 1)
})

test('N7-18: different projects are not merged', async () => {
  const api = fakeApi()
  const p = Promise.all([readProjectSessions('1', api), readProjectSessions('2', api)])
  assert.deepEqual(api.calls, ['1', '2'])
  api.release()
  await p
})

test('N7-18: after the read settled, the next trigger reads again (a refresh is not swallowed)', async () => {
  const api = fakeApi()
  const first = readProjectSessions('7', api)
  api.release()
  await first
  const second = readProjectSessions('7', api)
  assert.deepEqual(api.calls, ['7', '7'])
  api.release()
  await second
})

test('N7-18: a failed read frees the slot (the next trigger retries, the error reaches every joined caller)', async () => {
  const calls = []
  const api = { sessions: (id) => (calls.push(id), Promise.reject(new Error('boom'))) }
  const [x, y] = await Promise.allSettled([readProjectSessions('7', api), readProjectSessions('7', api)])
  assert.equal(x.status, 'rejected')
  assert.equal(y.status, 'rejected')
  assert.equal(calls.length, 1)
  await assert.rejects(readProjectSessions('7', api))
  assert.equal(calls.length, 2)
})
