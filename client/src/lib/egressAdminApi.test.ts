// md-exfil T3: the helpers behind the admin "external asset origins" card.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchEgressSettings, saveEgressOrigins, validateOriginInput, EgressSaveError } from './egressAdminApi.ts'

const realFetch = globalThis.fetch
let calls: Array<{ url: string; init?: RequestInit }> = []
const reply = (status: number, body: unknown) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
beforeEach(() => {
  calls = []
})
afterEach(() => {
  globalThis.fetch = realFetch
})

test('fetchEgressSettings reads GET /api/admin/egress/settings', async () => {
  const body = { origins: ['https://a.example.com'], envOrigins: ['https://env.example.com'], effective: ['https://env.example.com', 'https://a.example.com'], mode: 'enforce' }
  reply(200, body)
  assert.deepEqual(await fetchEgressSettings(), body)
  assert.equal(calls[0]!.url, '/api/admin/egress/settings')
})

test('saveEgressOrigins PUTs { origins } and returns the settings', async () => {
  const body = { origins: ['https://fonts.example.com'], envOrigins: [], effective: ['https://fonts.example.com'], mode: 'enforce' }
  reply(200, body)
  assert.deepEqual(await saveEgressOrigins(['https://fonts.example.com']), body)
  assert.equal(calls[0]!.init?.method, 'PUT')
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { origins: ['https://fonts.example.com'] })
})

test('a 400 invalid_origin throws EgressSaveError carrying the server rejected list', async () => {
  reply(400, { error: 'invalid_origin', code: 'invalid_origin', rejected: ['https://*.evil.com'] })
  await assert.rejects(saveEgressOrigins(['https://*.evil.com']), (e: unknown) => {
    assert.ok(e instanceof EgressSaveError)
    assert.deepEqual(e.rejected, ['https://*.evil.com'])
    assert.equal(e.status, 400)
    return true
  })
})

test('a 500 throws EgressSaveError with an empty rejected list', async () => {
  reply(500, { error: 'internal_error' })
  await assert.rejects(saveEgressOrigins([]), (e: unknown) => e instanceof EgressSaveError && e.rejected.length === 0 && e.status === 500)
})

test('validateOriginInput uses parseAllowedOrigins: canonical origin, wildcard/http/path/platform refused', () => {
  assert.deepEqual(validateOriginInput('HTTPS://Fonts.Example.com', 'app.example.org'), { ok: true, origin: 'https://fonts.example.com' })
  for (const bad of ['https://*.example.com', 'http://fonts.example.com', 'https://fonts.example.com/css', 'https://x.cloud.databricks.com', 'https://app.example.org', '', '  ']) {
    assert.equal(validateOriginInput(bad, 'app.example.org').ok, false, bad)
  }
})
