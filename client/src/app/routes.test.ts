import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, routeHash } from './routes.ts'
import type { Route } from './routes.ts'

test('an empty hash, #/ and #/chat open a new chat', () => {
  for (const h of ['', '#', '#/', '#/chat', '#/chat/', 'chat']) {
    assert.deepEqual(parseRoute(h), { view: 'chat', sessionId: null }, h)
  }
})

test('#/chat/:id opens that conversation, the id as a string', () => {
  assert.deepEqual(parseRoute('#/chat/25'), { view: 'chat', sessionId: '25' })
  assert.deepEqual(parseRoute('#chat/25/'), { view: 'chat', sessionId: '25' })
})

test('an encoded id is decoded, and a malformed escape is kept as typed', () => {
  assert.deepEqual(parseRoute('#/chat/a%20b'), { view: 'chat', sessionId: 'a b' })
  assert.deepEqual(parseRoute('#/chat/%E0%A4%A'), { view: 'chat', sessionId: '%E0%A4%A' })
})

test('#/history, #/costs and #/projects[/:id] are recognised', () => {
  assert.deepEqual(parseRoute('#/history'), { view: 'history' })
  assert.deepEqual(parseRoute('#/history/'), { view: 'history' })
  assert.deepEqual(parseRoute('#/costs'), { view: 'costs' })
  assert.deepEqual(parseRoute('#/projects'), { view: 'projects', projectId: null })
  assert.deepEqual(parseRoute('#/projects/7'), { view: 'projects', projectId: '7' })
})

test('#/agents is recognised and built back', () => {
  assert.deepEqual(parseRoute('#/agents'), { view: 'agents' })
  assert.deepEqual(parseRoute('#/agents/'), { view: 'agents' })
  assert.deepEqual(parseRoute('#/agents?x=1'), { view: 'agents' })
  assert.equal(routeHash({ view: 'agents' }), '#/agents')
  assert.deepEqual(parseRoute('#/agents/7'), { view: 'chat', sessionId: null })
})

test('a query string after the route is ignored', () => {
  assert.deepEqual(parseRoute('#/chat/25?x=1'), { view: 'chat', sessionId: '25' })
  assert.deepEqual(parseRoute('#/history?q=deck'), { view: 'history' })
})

test('an unknown route falls back to a new chat instead of a blank page', () => {
  assert.deepEqual(parseRoute('#/settings/models'), { view: 'chat', sessionId: null })
  assert.deepEqual(parseRoute('#/chat/25/extra'), { view: 'chat', sessionId: null })
})

test('routeHash builds the hash parseRoute reads back', () => {
  const cases: [Route, string][] = [
    [{ view: 'chat', sessionId: null }, '#/chat'],
    [{ view: 'chat', sessionId: '25' }, '#/chat/25'],
    [{ view: 'chat', sessionId: 'a b' }, '#/chat/a%20b'],
    [{ view: 'history' }, '#/history'],
    [{ view: 'costs' }, '#/costs'],
    [{ view: 'projects', projectId: null }, '#/projects'],
    [{ view: 'projects', projectId: '7' }, '#/projects/7'],
  ]
  for (const [route, hash] of cases) {
    assert.equal(routeHash(route), hash)
    assert.deepEqual(parseRoute(hash), route)
  }
})
