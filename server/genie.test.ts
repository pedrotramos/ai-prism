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
