import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyCredential,
  catalogAdmits,
  catalogClass,
  classifyMcpService,
  MANAGED_MCP_CLASSES,
} from './mcpCredentials.ts'

test('classifyCredential: per-user and shared credential types from metadata', () => {
  assert.equal(classifyCredential({ credentialType: 'OAUTH_U2M_MAPPING' }).credentialClass, 'per_user')
  assert.equal(classifyCredential({ credentialType: 'oauth_dcr' }).credentialClass, 'per_user')
  assert.equal(classifyCredential({ credentialType: 'BEARER_TOKEN' }).credentialClass, 'shared')
  assert.equal(classifyCredential({ credentialType: 'OAUTH_M2M' }).credentialClass, 'shared')
  assert.equal(classifyCredential({ credentialType: 'OAUTH_U2M' }).credentialClass, 'shared')
})

test('classifyCredential: a per-user login or an oauth provider means per_user, never databricks', () => {
  assert.equal(classifyCredential({ userLogin: 'per_user' }).credentialClass, 'per_user')
  assert.equal(classifyCredential({ oauthProvider: 'github' }).credentialClass, 'per_user')
  assert.equal(classifyCredential({ oauthProvider: 'UNSPECIFIED' }).credentialClass, 'unverified')
  assert.notEqual(classifyCredential({ credentialType: null, userLogin: 'none' }).credentialClass, 'databricks')
})

test('classifyCredential: nothing readable stays unverified', () => {
  assert.deepEqual(classifyCredential({}), { credentialClass: 'unverified', credentialType: null })
  assert.equal(classifyCredential({ credentialType: 'SOMETHING_NEW' }).credentialClass, 'unverified')
})

test('catalogAdmits: shared credentials are refused under the default policy', () => {
  assert.deepEqual(catalogAdmits('shared'), { ok: false, code: 'shared_credential' })
  assert.equal(catalogAdmits('shared', 'badge').ok, true)
  assert.equal(catalogAdmits('shared', 'badge').badge, 'shared')
  assert.equal(catalogAdmits('per_user').ok, true)
  assert.equal(catalogAdmits('databricks').ok, true)
  assert.deepEqual(catalogAdmits('unverified'), { ok: false, code: 'credential_unverified' })
  assert.deepEqual(catalogAdmits(null), { ok: false, code: 'credential_unchecked' })
})

test('catalogClass: stored class wins, managed system.ai services fall back to their known class', () => {
  assert.equal(catalogClass({ connectionName: 'acme.ai.svc', credentialClass: 'shared' }), 'shared')
  assert.equal(catalogClass({ connectionName: 'system.ai.dbsql' }), 'databricks')
  assert.equal(catalogClass({ connectionName: 'system.ai.gmail' }), 'per_user')
  assert.equal(catalogClass({ connectionName: 'acme.ai.svc' }), null)
  assert.equal(MANAGED_MCP_CLASSES.get('system.ai.genie_one_mcp'), 'databricks')
})

// fake fetch: answers by URL suffix, everything else 404
function fakeFetch(routes: Record<string, [number, unknown]>) {
  return async (url: string) => {
    const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))
    const [status, body] = hit ? hit[1] : [404, { message: 'not found' }]
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, text: async () => text }
  }
}
const env = { DATABRICKS_HOST: 'https://ws.example.com' }

test('classifyMcpService: reads the source connection credential type and refuses a shared one', async () => {
  const fetchImpl = fakeFetch({
    '/mcp-services/acme.ai.svc': [200, { config: { source_connection: { name: 'acme_conn' } } }],
    '/connections/acme_conn': [200, { credential_type: 'BEARER_TOKEN' }],
  })
  const r = await classifyMcpService('acme.ai.svc', { metadataToken: 'sp', fetchImpl, env })
  assert.equal(r.credentialClass, 'shared')
  assert.equal(r.credentialType, 'BEARER_TOKEN')
  assert.equal(r.admission.ok, false)
  assert.equal(r.admission.code, 'shared_credential')
})

test('classifyMcpService: unreadable metadata stays unverified; managed services keep their known class', async () => {
  const fetchImpl = fakeFetch({})
  const custom = await classifyMcpService('acme.ai.svc', { metadataToken: 'sp', fetchImpl, env })
  assert.equal(custom.credentialClass, 'unverified')
  const managed = await classifyMcpService('system.ai.web_search', { metadataToken: 'sp', fetchImpl, env })
  assert.equal(managed.credentialClass, 'databricks')
  assert.equal(managed.admission.ok, true)
})

test('classifyMcpService: no host configured degrades to the managed table, never throws', async () => {
  const r = await classifyMcpService('system.ai.slack', { metadataToken: null, env: {} })
  assert.equal(r.credentialClass, 'per_user')
  const u = await classifyMcpService('acme.ai.svc', { metadataToken: null, env: {} })
  assert.equal(u.credentialClass, 'unverified')
})

test('classifyMcpService: unknown credential type + a per-user login from the admin check = per_user', async () => {
  const fetchImpl = fakeFetch({
    '/mcp-services/acme.ai.svc/user-credentials': [200, {}],
    '/mcp-services/acme.ai.svc': [200, { config: { source_connection: { name: 'acme_conn' } } }],
    '/connections/acme_conn': [200, { credential_type: 'SOMETHING_NEW' }],
  })
  const r = await classifyMcpService('acme.ai.svc', { metadataToken: 'sp', adminToken: 'admin', fetchImpl, env })
  assert.equal(r.credentialClass, 'per_user')
})
