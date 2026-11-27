// The A2A agents as chat tools (server/tools.ts): which catalog agents are offered, how a call is routed to the
// right credential, and the authorization descriptor a tool returns (A2A or an MCP service that is not connected)
// so the turn can pause for the user's own authorization.
//
//   node --test server/a2aTools.test.ts
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolDefs, invokeTool } from './tools.ts'
import { startEchoAgent } from './testing/a2aEchoAgent.ts'
import type { EchoAgent } from './testing/a2aEchoAgent.ts'
import { forgetObservedStatuses, observedStatus } from './a2aClient.ts'
import type { A2aAgentRow } from './db/a2a.ts'

const ME = 'ana@example.com'
const TOKEN = 'dapi-user-token'

let echo: EchoAgent
before(async () => {
  echo = await startEchoAgent()
  process.env.A2A_ALLOW_INSECURE_LOCAL = '1'
  process.env.A2A_ALLOWED_HOSTS = new URL(echo.url).host
})
after(async () => {
  await echo.close()
  delete process.env.A2A_ALLOW_INSECURE_LOCAL
  delete process.env.A2A_ALLOWED_HOSTS
})

const agent = (over: Partial<A2aAgentRow> = {}): A2aAgentRow => ({
  id: '3',
  slug: 'echo',
  displayName: 'Echo',
  cardUrl: echo.cardUrl,
  appName: '',
  authStrategy: 'none',
  authProvider: null,
  card: { description: 'Echoes things', skills: [{ id: 'echo', name: 'Echo', description: 'Repeats', tags: [], examples: [] }] },
  cardPublic: true,
  enabled: true,
  configStatus: 'ok',
  configError: null,
  configCheckedAt: null,
  addedByHash: null,
  createdAt: new Date().toISOString(),
  ...over,
})

test('buildToolDefs offers each usable catalog agent as a2a__<slug>, last-but-one in the list and never twice', async () => {
  const built = await buildToolDefs([], TOKEN, ME, { includePython: false, a2aAgents: [agent(), agent({ id: '4', slug: 'off', enabled: false }), agent({ id: '5', slug: 'gone', authStrategy: 'oauth2-user', authProvider: 'removed-provider' })] })
  const names = built.tools.map((t) => t.function.name)
  assert.deepEqual(names, ['a2a__echo'], 'a disabled agent and one whose provider no longer exists are not offered')
  assert.equal(built.resolvers.get('a2a__echo')?.kind, 'a2a')
  assert.match(built.tools[0]?.function.description || '', /protocolo A2A/)
  const none = await buildToolDefs([], TOKEN, ME, { includePython: false, a2aAgents: null })
  assert.equal(none.tools.length, 0)
})

test('invoking the tool calls the agent with the strategy\'s credential and returns the framed answer', async () => {
  forgetObservedStatuses(ME)
  const built = await buildToolDefs([], TOKEN, ME, { includePython: false, a2aAgents: [agent()] })
  const resolver = built.resolvers.get('a2a__echo') as NonNullable<ReturnType<typeof built.resolvers.get>>
  echo.requests.length = 0
  const out = await invokeTool(TOKEN, resolver, { message: 'ping' }, { email: ME, sessionId: undefined, lang: 'en' })
  assert.match(out.resultText, /Echo: ping/)
  assert.match(out.resultText, /untrusted/)
  assert.equal(observedStatus(ME, '3')?.status, 'connected')
  assert.ok(echo.requests.every((r) => r.authorization === null))
})

test('a2a tool of an agent that cannot be used answers with the fixed unavailable text (the descriptor path is in a2aClient.test.ts)', async () => {
  const resolver = { kind: 'a2a', agent: agent({ authStrategy: 'oauth2-user', authProvider: 'removed-provider' }) }
  const out = await invokeTool(TOKEN, resolver, { message: 'ping' }, { email: ME, lang: 'en' })
  assert.equal(out.isError, true)
  assert.match(out.resultText, /^ERROR \[a2a:unavailable\]/)
  assert.equal(out.auth, undefined)
})

test('an MCP service the gateway says is not connected for this user becomes an authorization descriptor with its sign-in page', async () => {
  process.env.DATABRICKS_HOST = 'https://adb-1.azuredatabricks.net'
  try {
    const resolver = { kind: 'mcp-external-error', connectionName: 'main.mcp.github', label: 'GitHub', error: 'The connection main.mcp.github is not connected for this user, or its credential has expired or been revoked. Log in at /mcp-service-login?name=main.mcp.github' }
    const out = await invokeTool(TOKEN, resolver, {}, { email: ME, lang: 'en' })
    assert.equal(out.auth.kind, 'mcp')
    assert.equal(out.auth.id, 'main.mcp.github')
    assert.equal(out.auth.loginUrl, 'https://adb-1.azuredatabricks.net/mcp-service-login?name=main.mcp.github')
    assert.match(out.resultText, /^AUTH_REQUIRED/)
    // an ordinary failure stays an ordinary error
    const plain = await invokeTool(TOKEN, { ...resolver, error: 'connect ECONNREFUSED' }, {}, { email: ME })
    assert.equal(plain.auth, undefined)
    assert.match(plain.resultText, /^ERROR: /)
    // a missing grant is an access problem, not an authorization one
    const grant = await invokeTool(TOKEN, { ...resolver, error: 'PERMISSION_DENIED: missing USE CONNECTION on main.mcp.github' }, {}, { email: ME })
    assert.equal(grant.auth, undefined)
  } finally {
    delete process.env.DATABRICKS_HOST
  }
})
