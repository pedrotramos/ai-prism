// N7 item 18: at startup the hook read each project's sessions twice (once when the
// projects list arrived, once when the caller's own chat list did). A read already
// in flight for a project is now shared, so a burst of triggers is one request per
// project; a trigger after it settled reads again (a refresh after a turn/move).
// Counts requests, never time.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readProjectSessions, resetProjectSessionsCache } from './useProjectChats.js'

beforeEach(() => resetProjectSessionsCache())

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

test('N7-18: the second startup trigger, after the first read settled, shares its result', async () => {
  const api = fakeApi()
  const clock = { t: 1000 }
  const projectsReady = readProjectSessions('7', api, () => clock.t)
  api.release({ sessions: [{ id: 1 }] })
  const first = await projectsReady
  clock.t += 200 // the own-session list arrives right after
  const second = await readProjectSessions('7', api, () => clock.t)
  assert.deepEqual(api.calls, ['7'])
  assert.deepEqual(second, first)
})

test('N7-18: a real refresh (a turn or a move, later than the startup window) reads again', async () => {
  const api = fakeApi()
  const clock = { t: 1000 }
  const first = readProjectSessions('7', api, () => clock.t)
  api.release()
  await first
  clock.t += 30_000
  const second = readProjectSessions('7', api, () => clock.t)
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
  await assert.rejects(readProjectSessions('7', api)) // a failure is never remembered
  assert.equal(calls.length, 2)
})
