import { test } from 'node:test'
import assert from 'node:assert/strict'
import { genieOneUrl, GENIE_ONE_MCP_SERVICE } from './genie.ts'

const HOST = 'https://ws.example.com'

test('genieOneUrl: defaults to the UC AI Gateway MCP service, with ?o= when the workspace id is known', () => {
  assert.equal(GENIE_ONE_MCP_SERVICE, 'system.ai.genie_one_mcp')
  const env = { DATABRICKS_HOST: HOST, DATABRICKS_WORKSPACE_ID: '1234567890' }
  assert.equal(genieOneUrl(env), `${HOST}/ai-gateway/mcp-services/system.ai.genie_one_mcp?o=1234567890`)
})

test('genieOneUrl: without a numeric workspace id the gateway URL has no ?o=', () => {
  assert.equal(
    genieOneUrl({ DATABRICKS_HOST: HOST, DATABRICKS_WORKSPACE_ID: 'abc' }),
    `${HOST}/ai-gateway/mcp-services/system.ai.genie_one_mcp`
  )
})

test('genieOneUrl: GENIE_ONE_MCP_URL replaces the whole URL (e.g. the Beta endpoint until 2026-11-30)', () => {
  const beta = `${HOST}/api/2.0/mcp/genie`
  assert.equal(genieOneUrl({ DATABRICKS_HOST: HOST, GENIE_ONE_MCP_URL: ` ${beta} ` }), beta)
  assert.equal(genieOneUrl({ DATABRICKS_HOST: HOST, GENIE_ONE_MCP_URL: '   ' }), `${HOST}/ai-gateway/mcp-services/system.ai.genie_one_mcp`)
})

// ---- transient-error retry -------------------------------------------------------------

import { fetchWithRetry, GENIE_RETRIES } from './genie.ts'

const reply = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers })
// a fetch that answers with the given outcomes in order (an Error is thrown), counting the calls
function script(...outcomes: (Response | Error)[]) {
  const calls: number[] = []
  const fetchImpl = (async () => {
    const next = outcomes[calls.length] ?? outcomes[outcomes.length - 1]
    calls.push(1)
    if (next instanceof Error) throw next
    return next as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}
const waits = () => {
  const list: number[] = []
  return { list, sleep: async (ms: number) => void list.push(ms) }
}

test('fetchWithRetry: two retries by default, backing off 0.5 s then 1.5 s', async () => {
  assert.equal(GENIE_RETRIES, 2)
  const { fetchImpl, calls } = script(reply(503), reply(503), reply(200))
  const w = waits()
  const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep: w.sleep })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 3)
  assert.deepEqual(w.list, [500, 1500])
})

test('fetchWithRetry: after the retries are spent the last transient response is returned, not hidden', async () => {
  const { fetchImpl, calls } = script(reply(502), reply(503), reply(504))
  const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep: waits().sleep })
  assert.equal(res.status, 504)
  assert.equal(calls.length, 3)
})

test('fetchWithRetry: a dropped connection is transient; the last network error is thrown', async () => {
  const ok = script(new TypeError('fetch failed'), reply(200))
  assert.equal((await fetchWithRetry('https://x', {}, { fetchImpl: ok.fetchImpl, sleep: waits().sleep })).status, 200)
  const down = script(new TypeError('fetch failed'))
  await assert.rejects(fetchWithRetry('https://x', {}, { fetchImpl: down.fetchImpl, sleep: waits().sleep }), /fetch failed/)
  assert.equal(down.calls.length, 3)
})

test('fetchWithRetry: 429 honours Retry-After (capped at 5 s)', async () => {
  const { fetchImpl } = script(reply(429, { 'retry-after': '2' }), reply(429, { 'retry-after': '120' }), reply(200))
  const w = waits()
  await fetchWithRetry('https://x', {}, { fetchImpl, sleep: w.sleep })
  assert.deepEqual(w.list, [2000, 5000])
})

test('fetchWithRetry: a final answer is not retried (400, 401, 403, 404, 500)', async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    const { fetchImpl, calls } = script(reply(status))
    const w = waits()
    assert.equal((await fetchWithRetry('https://x', {}, { fetchImpl, sleep: w.sleep })).status, status)
    assert.equal(calls.length, 1, `status ${status}`)
    assert.deepEqual(w.list, [])
  }
})

test('fetchWithRetry: an abort by the caller is not retried', async () => {
  const ctl = new AbortController()
  ctl.abort()
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const { fetchImpl, calls } = script(abort)
  await assert.rejects(fetchWithRetry('https://x', { signal: ctl.signal }, { fetchImpl, sleep: waits().sleep }), /aborted/)
  assert.equal(calls.length, 1)
})
