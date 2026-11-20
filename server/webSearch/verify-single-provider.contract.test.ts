// Contract (W2-11b QA r1, AC-2): one Verify makes exactly ONE real provider
// search. From QA's failing patch, adapted to the per-entry Verify: the caller
// names the chain entry (index + kind); a missing or mismatched entry makes no
// provider call at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { webSearchStatus, webSearchDeps, resetWebSearchForTests } from './index.ts'

const ENV = { WEB_SEARCH_MCP_SERVICE: 'acme.search.firecrawl', BRAVE_SEARCH_API_KEY: 'test-key' }

function fakeProviders() {
  resetWebSearchForTests()
  const providerCalls: string[] = []
  // the fakes return the fields the adapter reads, not the full MCP listing/result shapes
  webSearchDeps.listServer = (async (url: string) => {
    const service = decodeURIComponent(String(url).split('/ai-gateway/mcp-services/')[1] || '')
    return { tools: [{ name: service === 'system.ai.web_search' ? 'web_search' : 'firecrawl_search', inputSchema: { properties: { query: { type: 'string' } } } }] }
  }) as unknown as typeof webSearchDeps.listServer
  webSearchDeps.callTool = (async (_url: string, _token: string, name: string) => {
    providerCalls.push(`mcp:${name}`)
    return { text: '', structuredContent: { results: [{ title: 'Result', url: 'https://example.com' }] } }
  }) as unknown as typeof webSearchDeps.callTool
  webSearchDeps.fetchImpl = async () => {
    providerCalls.push('brave')
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ web: { results: [{ title: 'Result', url: 'https://example.com', description: '' }] } })) }
  }
  return providerCalls
}

test('Verify makes one provider search request for the configured chain', async () => {
  const cases: [number, string, string][] = [
    [0, 'managed-mcp', 'mcp:web_search'],
    [1, 'external-mcp', 'mcp:firecrawl_search'],
    [2, 'brave', 'brave'],
  ]
  for (const [entry, kind, want] of cases) {
    const providerCalls = fakeProviders()
    const s = await webSearchStatus({ token: 'test-token', email: 'admin@example.com', verify: { entry, kind }, env: ENV })
    assert.equal(providerCalls.length, 1, `provider calls: ${providerCalls.join(', ')}`)
    assert.equal(providerCalls[0], want)
    assert.equal(s.chain[entry]!.state, 'up')
    assert.equal(s.chain[entry]!.resultCount, 1)
    assert.deepEqual(s.verified, { entry, kind, state: 'up', resultCount: 1 })
    // the other entries were not touched
    for (let i = 0; i < s.chain.length; i++) if (i !== entry) assert.equal(s.chain[i]!.state, 'unknown', `entry ${i}`)
  }
})

test('Verify without a valid entry makes no provider call', async () => {
  for (const verify of [true, {}, { entry: 3, kind: 'brave' }, { entry: -1, kind: 'brave' }, { entry: 1.5, kind: 'external-mcp' }, { entry: 1, kind: 'brave' }, { entry: '1', kind: 'external-mcp' }]) {
    const providerCalls = fakeProviders()
    await assert.rejects(
      webSearchStatus({ token: 'test-token', email: 'admin@example.com', verify, env: ENV }),
      (e: { code?: string }) => e.code === 'invalid_entry',
      JSON.stringify(verify)
    )
    assert.equal(providerCalls.length, 0, `${JSON.stringify(verify)} → ${providerCalls.join(', ')}`)
  }
})
