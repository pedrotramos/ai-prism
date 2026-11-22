// runTurnHeadless (W4-4b): the chat turn without a browser. Same prepareTurn → runAssistantTurn → finishTurn
// as the three routes, on the fake AI Gateway and the local pgvector Postgres, as the app's service principal.
//
//   node --test server/turnHeadless.test.ts
//
// Without the database these are SKIPPED with the reason; CI runs --fail-on-skip.
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { startFakeGateway } from '../scripts/fake-gateway.mjs'

type Loose = any

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.LOCAL_PGVECTOR = '1'
env.APPKIT_BOOT = '1'
env.RATE_LIMIT_API_PER_MIN = '0'
env.RATE_LIMIT_TURNS_PER_MIN = '0'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL
for (const k of ['WEB_SEARCH_DISABLED', 'WEB_SEARCH_BACKEND', 'WEB_SEARCH_MCP_SERVICE', 'WEB_SEARCH_CONNECTION', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'SEARXNG_URL']) delete env[k]

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 })
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed in this Postgres'
  } catch (e: Loose) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false
const gw: Loose = SKIP ? null : await startFakeGateway({ port: 0 })
if (gw) env.DATABRICKS_HOST = gw.url

const turn = await import('./turn.ts')
const db = await import('./db.ts')
const usage = await import('./usage.ts')
const { withRunIdentity } = await import('./runIdentity.ts')
const tools = await import('./tools.ts')
const mcpWarm = await import('./mcpWarm.ts')
const { primeMcpServerCache } = await import('./mcpClient.ts')
const ext = await import('./externalMcp.ts')

const RUN = randomUUID().slice(0, 8)
const OWNER = `headless-${RUN}@test.invalid`
const SP = 'sp-token-not-a-user'
const MODEL = 'databricks-claude-sonnet-5-5'
const DOC_PROMPT = `Crie um documento com o título "Relatório ${RUN}" [fake:tool:create_document]`

let server: Loose
let base = ''

async function query(sql: string, params?: unknown[]): Promise<Loose[]> {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows
  } finally {
    await c.end()
  }
}

/** waits for a condition (fire-and-forget work), not for a fixed time */
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`never became true: ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

const asSp = <T>(fn: () => Promise<T>) => withRunIdentity({ runAs: 'app_sp' }, fn)

/** One headless turn the way executeAgentRun drives it: a session, its user message, the usage scope, the SP identity. */
async function headless(prompt: string, o: { toolRefs?: string[]; signal?: AbortSignal; onEvent?: (e: Loose) => void; agentId?: string; runId?: string } = {}) {
  const sessionId = String(await db.createSession(OWNER, SP, `agent · ${RUN}`, MODEL, '', []))
  await db.addMessage(OWNER, SP, { sessionId, role: 'user', content: prompt, attachments: null })
  const agentId = o.agentId ?? '7'
  const runId = o.runId ?? '42'
  const result = await asSp(() =>
    usage.runWithUsageScope({ email: OWNER, token: SP, kind: 'scheduled', sessionId, tags: { agent_id: agentId, agent_run_id: runId } }, () =>
      turn.runTurnHeadless({
        email: OWNER,
        token: SP,
        requestId: `req-${randomUUID().slice(0, 6)}`,
        sessionId,
        userText: prompt,
        opts: { model: MODEL, systemPrompt: 'Você é um agente.', reasoningEffort: null, toolRefs: o.toolRefs ?? [], lang: 'en' },
        signal: o.signal ?? new AbortController().signal,
        onEvent: o.onEvent,
      })
    )
  )
  return { sessionId, result }
}

const as = (email: string, init: Loose = {}) => ({ ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } })
async function messagesVia(sessionId: string) {
  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, as(OWNER))
  return (await res.json()).messages as Loose[]
}
/** the persisted shape of a turn, minus ids, times and session-specific text */
function shape(msgs: Loose[]) {
  return msgs.map((m) => ({
    role: m.role,
    keys: Object.keys(m).sort(),
    toolcalls: (m.toolCalls || m.tool_calls || []).map((t: Loose) => ({ name: t.name, status: t.status })),
    hasMarker: /\{\{toolcall:/.test(String(m.content || '')),
    blocks: (m.blocks || []).map((b: Loose) => b.type),
  }))
}

before(async () => {
  if (SKIP) return
  const { app }: Loose = await import('./index.js')
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
  await db.ensureSchema(OWNER, 'x')
})
after(async () => {
  if (SKIP) return
  await new Promise((r) => {
    server?.close(r)
    server?.closeAllConnections()
  })
  await gw?.close()
  await query(`DELETE FROM usage_ledger WHERE user_email = $1`, [OWNER]).catch(() => {})
  await query(`DELETE FROM chat_sessions WHERE user_email = $1`, [OWNER]).catch(() => {})
})

describe('runTurnHeadless', { skip: SKIP }, () => {
  test('AC2: outside app_sp it throws, before touching anything', async () => {
    const input = { email: OWNER, token: SP, requestId: 'r', sessionId: '1', userText: 'x', opts: { model: MODEL, systemPrompt: '', reasoningEffort: null, toolRefs: [], lang: 'en' as const }, signal: new AbortController().signal }
    await assert.rejects(() => turn.runTurnHeadless(input), /app_sp/)
    await assert.rejects(() => withRunIdentity({ runAs: 'user' }, () => turn.runTurnHeadless(input)), /app_sp/)
  })

  test('AC3: persists the same message and tool-call shape as /api/chat', async () => {
    const events: Loose[] = []
    const { sessionId, result } = await headless(DOC_PROMPT, { toolRefs: ['artifact:document'], onEvent: (e) => events.push(e) })
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.errorCode, null)
    assert.deepEqual(result.toolNames, ['create_document'])
    assert.ok(result.messageId)
    assert.ok(events.some((e) => e.type === 'tool_call') && events.some((e) => e.type === 'token'), 'onEvent sees the turn events')

    // the same prompt through /api/chat
    const form = new FormData()
    form.append('payload', JSON.stringify({ prompt: DOC_PROMPT, model: MODEL, enabledTools: [] }))
    const res = await fetch(`${base}/api/chat`, as(OWNER, { method: 'POST', body: form }))
    assert.equal(res.status, 200)
    const meta = (await res.text()).split('\n\n').map((f) => f.trim()).filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5))).find((e) => e.type === 'meta')
    const viaChat = shape(await messagesVia(String(meta.sessionId)))
    const viaHeadless = shape(await messagesVia(sessionId))
    assert.deepEqual(viaHeadless, viaChat)
    assert.deepEqual(viaHeadless.map((m) => m.role), ['user', 'assistant'])
    assert.ok(viaHeadless[1]!.blocks.includes('document'), 'the artifact the tool staged is committed with the answer')
  })

  test('AC3: ledger rows are kind scheduled, for the owner, on the run session; the gateway sees the run tags', async () => {
    const before = gw.requests.length
    const { sessionId, result } = await headless(`Responda OK (${RUN}-tags)`, { agentId: '123', runId: '456' })
    assert.equal(result.status, 'ok')
    const rows = await query(`SELECT kind, user_email, session_id::text AS session_id FROM usage_ledger WHERE session_id = $1`, [sessionId])
    assert.ok(rows.length >= 1)
    assert.ok(rows.every((r) => r.kind === 'scheduled' && r.user_email === OWNER && r.session_id === sessionId), JSON.stringify(rows))
    const calls = gw.requests.slice(before).filter((r: Loose) => r.path === '/serving-endpoints/chat/completions')
    assert.ok(calls.length >= 1)
    for (const c of calls) {
      assert.equal(c.body.usage_context.ai_prism_run_kind, 'scheduled')
      assert.equal(c.body.usage_context.ai_prism_agent_id, '123')
      assert.equal(c.body.usage_context.ai_prism_agent_run_id, '456')
      assert.ok(!JSON.stringify(c.body.usage_context).includes(OWNER), 'never the e-mail')
    }
  })

  test('AC3: a user turn sends no run tags', async () => {
    const before = gw.requests.length
    const form = new FormData()
    form.append('payload', JSON.stringify({ prompt: `Responda OK (${RUN}-plain)`, model: MODEL, enabledTools: [] }))
    const plainRes = await fetch(`${base}/api/chat`, as(OWNER, { method: 'POST', body: form }))
    assert.equal(plainRes.status, 200)
    await plainRes.text() // the whole stream: its hooks and tail are done before the next test
    for (const c of gw.requests.slice(before).filter((r: Loose) => r.path === '/serving-endpoints/chat/completions')) {
      assert.equal(c.body.usage_context.ai_prism_run_kind, undefined)
      assert.equal(c.body.usage_context.ai_prism_agent_id, undefined)
    }
  })

  test('AC4: context providers and completion hooks are skipped headless unless registered {headless:true} (counted)', async () => {
    const calls = { plain: 0, optIn: 0, hookPlain: 0, hookOptIn: 0 }
    const un = [
      turn.registerTurnContextProvider(async () => (calls.plain++, ['memória do usuário'])),
      turn.registerTurnContextProvider(async () => (calls.optIn++, []), { headless: true }),
      turn.registerTurnCompletionHook(() => void calls.hookPlain++),
      turn.registerTurnCompletionHook(() => void calls.hookOptIn++, { headless: true }),
    ]
    try {
      const { result } = await headless(`Responda OK (${RUN}-providers)`)
      assert.equal(result.status, 'ok')
      await until(() => calls.hookOptIn === 1, 'the opt-in hook ran') // hooks are fire-and-forget
      assert.deepEqual(calls, { plain: 0, optIn: 1, hookPlain: 0, hookOptIn: 1 })
      // the same registry still serves the routes
      const form = new FormData()
      form.append('payload', JSON.stringify({ prompt: `Responda OK (${RUN}-providers-chat)`, model: MODEL, enabledTools: [] }))
      const chatRes = await fetch(`${base}/api/chat`, as(OWNER, { method: 'POST', body: form }))
      assert.equal(chatRes.status, 200)
      await chatRes.text()
      await until(() => calls.hookPlain === 1, 'the plain hook ran on the route')
      assert.equal(calls.plain, 1)
      assert.equal(calls.hookPlain, 1)
    } finally {
      un.forEach((f) => f())
    }
  })

  test('only the admitted tools reach the model: no python, no web search, no artifact tools the agent did not list', async () => {
    const before = gw.requests.length
    await headless(`Crie um documento e uma planilha e pesquise na web (${RUN}-tools)`, { toolRefs: ['artifact:document'] })
    const stream = gw.requests.slice(before).find((r: Loose) => r.body?.stream)
    const names = (stream.body.tools || []).map((t: Loose) => t.function.name)
    assert.deepEqual(names, ['create_document', 'update_document'].filter((n) => names.includes(n)))
    assert.ok(names.includes('create_document'))
    assert.ok(!names.some((n: string) => /python|web_|spreadsheet|deck|genie|mcp_/.test(n)), names.join(','))
  })

  test('AC6: an abort flushes the ledger rows of the turn and commits the partial answer', async () => {
    // round 1 calls a tool (and spends); round 2 is held, then the run is aborted
    const ac = new AbortController()
    const events: Loose[] = []
    const roundTwo = gw.hold((r: Loose) => r.path === '/serving-endpoints/chat/completions' && r.body?.stream && (r.body.messages || []).some((m: Loose) => m.role === 'tool'))
    const running = headless(DOC_PROMPT, { toolRefs: ['artifact:document'], signal: ac.signal, onEvent: (e) => events.push(e) })
    await roundTwo.entered
    ac.abort(new Error('timeout'))
    roundTwo.release()
    const { sessionId, result } = await running
    assert.equal(result.status, 'aborted')
    const rows = await query(`SELECT kind FROM usage_ledger WHERE session_id = $1`, [sessionId])
    assert.ok(rows.length >= 1, 'the spend of round 1 is on the meter')
    assert.ok(rows.every((r) => r.kind === 'scheduled'))
    const msgs = await query(`SELECT role FROM chat_messages WHERE session_id = $1 ORDER BY id`, [sessionId])
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant'], 'the partial answer is committed')
  })

  test('a gateway failure comes back as status error with a code, never the message', async () => {
    const { result } = await headless(`quebra [fake:error] (${RUN})`)
    assert.equal(result.status, 'error')
    assert.equal(result.errorCode, 'gateway_error')
    assert.ok(!JSON.stringify(result).includes('503'), 'no message text in the result')
  })

  test('a turn already running on the session is refused, not queued', async () => {
    const sessionId = String(await db.createSession(OWNER, SP, 'busy', MODEL, '', []))
    await db.addMessage(OWNER, SP, { sessionId, role: 'user', content: 'oi', attachments: null })
    const { turnLock } = await import('./turnLock.ts')
    const release = turnLock.acquire(sessionId, { by: OWNER })
    try {
      await assert.rejects(
        asSp(() =>
          usage.runWithUsageScope({ email: OWNER, token: SP, kind: 'scheduled', sessionId }, () =>
            turn.runTurnHeadless({ email: OWNER, token: SP, requestId: 'r', sessionId, userText: 'oi', opts: { model: MODEL, systemPrompt: '', reasoningEffort: null, toolRefs: [], lang: 'en' }, signal: new AbortController().signal })
          )
        ),
        /turn_in_flight/
      )
    } finally {
      release?.()
    }
  })
})

describe('personal credentials under app_sp', { skip: SKIP }, () => {
  const PERSONAL = 'acme.tools.personal'
  const LISTING: Loose = { tools: [{ name: 'do_thing', description: 'x', inputSchema: { type: 'object', properties: {} } }], instructions: '' }

  test('AC5: buildToolDefs refuses a per-user MCP connection with sp_no_user_credentials; a user run still gets its tools', async () => {
    primeMcpServerCache(ext.externalMcpUrl(PERSONAL), OWNER, LISTING)
    const refs = [{ kind: 'mcp-external', connectionName: PERSONAL }]
    const admission = () => ({ ok: true, credentialClass: 'per_user' })
    const viaSp = () => asSp(() => tools.buildToolDefs(refs, SP, OWNER, { mcpAdmission: admission }))
    await assert.rejects(viaSp, (e: Loose) => e.code === 'sp_no_user_credentials')
    const asUser = await withRunIdentity({ runAs: 'user' }, () => tools.buildToolDefs(refs, 'user-token', OWNER, { mcpAdmission: admission }))
    const mcpNames = (b: Loose) => b.tools.map((t: Loose) => t.function.name).filter((n: string) => n.startsWith('mcp_'))
    assert.equal(mcpNames(asUser).length, 1)
    assert.equal(mcpNames(await tools.buildToolDefs(refs, 'user-token', OWNER, { mcpAdmission: admission })).length, 1, 'outside any run it behaves as before')
  })

  test('AC5: a catalog MCP service of class databricks is allowed under app_sp (D21)', async () => {
    primeMcpServerCache(ext.externalMcpUrl(PERSONAL), OWNER, LISTING)
    const built = await asSp(() => tools.buildToolDefs([{ kind: 'mcp-external', connectionName: PERSONAL }], SP, OWNER, { mcpAdmission: () => ({ ok: true, credentialClass: 'databricks' }) }))
    assert.equal(built.tools.filter((t: Loose) => t.function.name.startsWith('mcp_')).length, 1)
  })

  test('AC5: the MCP warm-up refuses to run under app_sp', async () => {
    mcpWarm.resetMcpWarm()
    await assert.rejects(() => asSp(() => mcpWarm.warmUserMcpConnections(SP, OWNER, { listUserMcpConnections: async () => [] })), (e: Loose) => e.code === 'sp_no_user_credentials')
    await mcpWarm.warmUserMcpConnections('user-token', OWNER, { listUserMcpConnections: async () => [] }) // a user run is unchanged
  })

  test('the owner’s adopted connections are never added to a headless turn', async () => {
    await query(`INSERT INTO user_mcp_connections (user_email, connection_name, comment, status) VALUES ($1, $2, '', 'connected') ON CONFLICT DO NOTHING`, [OWNER, PERSONAL])
    primeMcpServerCache(ext.externalMcpUrl(PERSONAL), OWNER, LISTING)
    const before = gw.requests.length
    const { result } = await headless(`Responda OK (${RUN}-adopted)`)
    assert.equal(result.status, 'ok')
    const stream = gw.requests.slice(before).find((r: Loose) => r.body?.stream)
    assert.ok(!(stream.body.tools || []).some((t: Loose) => /^mcp_/.test(t.function.name)))
    await query(`DELETE FROM user_mcp_connections WHERE user_email = $1`, [OWNER])
  })
})
