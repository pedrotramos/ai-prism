import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, friendlyError } from './errors.js'

// Messages copied from what the server and the browser really produce
// (server/index.js `res.status(500).json({ error: e.message })`, api.js
// `HTTP ${status}`, the fetch shim of the e2e harness, Chrome's fetch errors).
test('a gateway 503 relayed by the server is "unavailable"', () => {
  const r = classifyError(new Error('AI Gateway returned 503: upstream model temporarily unavailable'))
  assert.equal(r.kind, 'unavailable')
  assert.equal(r.status, 503)
  assert.equal(r.detail, 'AI Gateway returned 503: upstream model temporarily unavailable')
})

test('the browser losing the network is "network"', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')).kind, 'network')
  assert.equal(classifyError(new TypeError('NetworkError when attempting to fetch resource.')).kind, 'network')
  assert.equal(classifyError(new TypeError('Load failed')).kind, 'network')
})

test('a server that cannot reach a workspace URL is "unavailable", not the user being offline', () => {
  const r = classifyError('Failed to parse URL from https://<workspace_url>/serving-endpoints/embeddings')
  assert.equal(r.kind, 'unavailable')
})

test('HTTP status codes from api.js map to their kind', () => {
  assert.equal(classifyError(new Error('HTTP 429')).kind, 'rateLimited')
  assert.equal(classifyError(new Error('HTTP 401')).kind, 'unauthorized')
  assert.equal(classifyError(new Error('HTTP 403')).kind, 'forbidden')
  assert.equal(classifyError(new Error('HTTP 404')).kind, 'notFound')
  assert.equal(classifyError(new Error('HTTP 413')).kind, 'tooLarge')
  assert.equal(classifyError(new Error('HTTP 504')).kind, 'timeout')
  assert.equal(classifyError(new Error('HTTP 502')).kind, 'unavailable')
  assert.equal(classifyError(new Error('HTTP 500')).kind, 'server')
})

test('an explicit status on the error object wins over the text', () => {
  const e = Object.assign(new Error('something odd'), { status: 429 })
  assert.equal(classifyError(e).kind, 'rateLimited')
  assert.equal(classifyError(e).status, 429)
})

test('a non-numeric session id rejected by Postgres reads as "notFound"', () => {
  assert.equal(classifyError('invalid input syntax for type bigint: "abc"').kind, 'notFound')
})

test('permission and token problems in the text are classified without a status', () => {
  assert.equal(classifyError('PERMISSION_DENIED: User does not have USE CATALOG').kind, 'forbidden')
  assert.equal(classifyError('Invalid Token').kind, 'unauthorized')
  assert.equal(classifyError('Request timed out after 120s').kind, 'timeout')
  assert.equal(classifyError('Rate limit exceeded for endpoint').kind, 'rateLimited')
})

test('an abort is "aborted" so callers can stay silent', () => {
  const e = new Error('The user aborted a request.')
  e.name = 'AbortError'
  assert.equal(classifyError(e).kind, 'aborted')
})

test('anything else is "unknown" and keeps the raw text as the detail', () => {
  const r = classifyError(new Error('Tool não reconhecida pelo servidor.'))
  assert.equal(r.kind, 'unknown')
  assert.equal(r.status, null)
  assert.equal(r.detail, 'Tool não reconhecida pelo servidor.')
})

test('empty input is "unknown" with no detail', () => {
  assert.deepEqual(classifyError(undefined), { kind: 'unknown', status: null, detail: '' })
  assert.deepEqual(classifyError(''), { kind: 'unknown', status: null, detail: '' })
})

test('a very long backend message is cut to 2,000 characters in the detail', () => {
  assert.equal(classifyError('x'.repeat(5000)).detail.length, 2000)
})

test('friendlyError translates the kind and keeps the raw text as the detail', () => {
  const seen = []
  const t = (k) => {
    seen.push(k)
    return `T(${k})`
  }
  const r = friendlyError(t, new Error('HTTP 429'))
  assert.deepEqual(r, { kind: 'rateLimited', message: 'T(appError.rateLimited)', detail: 'HTTP 429' })
  assert.deepEqual(seen, ['appError.rateLimited'])
})

test('friendlyError drops a detail that would repeat the message', () => {
  const t = () => 'Same text'
  assert.equal(friendlyError(t, 'Same text').detail, '')
})
