// Pure helpers behind the Memory section (W3-3): request wrapper that never throws
// on an HTTP error, error → catalog-key mapping, and the per-entry sensitive
// opt-in rules. The React parts are covered by client/e2e/memory.spec.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryRequest, memoryErrorKey, categoryOptions, buildPayload, isSensitiveCategory } from './memoryUi.js'

const CATS = ['preference', 'profile', 'work', 'project', 'other', 'health', 'politics', 'religion', 'personal_finance']
const SENSITIVE = ['health', 'politics', 'religion', 'personal_finance']

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('memoryRequest returns status + server error code instead of throwing', async () => {
  const f = async () => res(409, { error: 'memory_duplicate' })
  assert.deepEqual(await memoryRequest('POST', '/api/memory', { content: 'x' }, f), { ok: false, status: 409, code: 'memory_duplicate', data: { error: 'memory_duplicate' } })
})

test('memoryRequest sends JSON for a body and nothing for DELETE; 204 has no data', async () => {
  const seen = []
  const f = async (url, init) => (seen.push([url, init]), { ok: true, status: 204, json: async () => { throw new Error('no body') } })
  const r = await memoryRequest('DELETE', '/api/memory/7', undefined, f)
  assert.equal(r.ok, true)
  assert.equal(r.status, 204)
  assert.equal(r.data, null)
  assert.equal(seen[0][1].method, 'DELETE')
  assert.equal(seen[0][1].body, undefined)
  await memoryRequest('PATCH', '/api/memory/7', { content: 'a' }, f)
  assert.equal(seen[1][1].body, '{"content":"a"}')
  assert.equal(seen[1][1].headers['Content-Type'], 'application/json')
})

test('memoryRequest maps a network failure to status 0 / code network', async () => {
  const r = await memoryRequest('GET', '/api/memory', undefined, async () => { throw new TypeError('offline') })
  assert.deepEqual([r.ok, r.status, r.code], [false, 0, 'network'])
})

test('memoryErrorKey: 409 duplicate / limit, 400, 404, 403, other', () => {
  assert.equal(memoryErrorKey({ status: 409, code: 'memory_duplicate' }), 'memory.err.duplicate')
  assert.equal(memoryErrorKey({ status: 409, code: 'memory_limit' }), 'memory.err.limit')
  assert.equal(memoryErrorKey({ status: 400, code: 'content must be 1..500 characters' }), 'memory.err.invalid')
  assert.equal(memoryErrorKey({ status: 404, code: 'not_found' }), 'memory.err.notFound')
  assert.equal(memoryErrorKey({ status: 403, code: 'memory_disabled' }), 'memory.err.disabled')
  assert.equal(memoryErrorKey({ status: 0, code: 'network' }), 'memory.err.network')
  assert.equal(memoryErrorKey({ status: 500, code: 'internal_error' }), 'memory.err.generic')
})

test('isSensitiveCategory follows the list the server sent', () => {
  assert.equal(isSensitiveCategory('health', SENSITIVE), true)
  assert.equal(isSensitiveCategory('work', SENSITIVE), false)
})

test('sensitive categories are disabled without the opt-in, except the entry\'s own current one', () => {
  const off = categoryOptions(CATS, SENSITIVE, { optIn: false, current: 'work' })
  assert.deepEqual(off.filter((o) => o.disabled).map((o) => o.value), SENSITIVE)
  const own = categoryOptions(CATS, SENSITIVE, { optIn: false, current: 'health' })
  assert.deepEqual(own.filter((o) => o.disabled).map((o) => o.value), ['politics', 'religion', 'personal_finance'])
  const on = categoryOptions(CATS, SENSITIVE, { optIn: true, current: 'work' })
  assert.equal(on.some((o) => o.disabled), false)
})

test('buildPayload: sensitiveOptIn only travels true for a sensitive category with the opt-in', () => {
  assert.deepEqual(buildPayload({ content: '  I run  ', category: 'health', optIn: true }, SENSITIVE), { content: 'I run', category: 'health', sensitiveOptIn: true })
  assert.deepEqual(buildPayload({ content: 'a', category: 'health', optIn: false }, SENSITIVE), { content: 'a', category: 'health', sensitiveOptIn: false })
  assert.deepEqual(buildPayload({ content: 'a', category: 'work', optIn: true }, SENSITIVE), { content: 'a', category: 'work', sensitiveOptIn: false })
})
