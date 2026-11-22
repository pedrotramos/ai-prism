// W4-5 (QA r1): the sessions/messages projection of a message whose tool call carries an MCP App, against a real Postgres and
// the real db.ts as the app role (the isolation suite's setup). A UI record shows up as metadata (`hasUi`, service name, tool call
// id, declared domains); its HTML never appears in the serialized payload, and only the owner can read it back through the view read.
//
//   node --test server/mcpApps.projection.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE ||= '1'
env.LOCAL_PGVECTOR = '1'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
const SUPERUSER = env.PGUSER
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const opts = () => ({ host: env.PGHOST, port: Number(env.PGPORT), user: SUPERUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 })

async function skipReason(): Promise<string | null> {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client(opts())
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as { code?: string }).code || (e as Error).message})`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = await skipReason()
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const A = `proj-a-${stamp}@test.invalid`
const B = `proj-b-${stamp}@test.invalid`
const SENTINEL = `<p id="html-sentinel-${stamp}">secret view body</p>`
const UI = {
  v: 1, uri: 'ui://x/y.html', serviceName: 'main.apps.chart', toolName: 'show_chart', html: SENTINEL,
  csp: { connectDomains: ['https://api.example.com'], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  prefersBorder: true, sha256: 'x', fetchedAt: new Date().toISOString(), structuredContent: null,
}

let raw: pg.Client
let db: typeof import('./db.ts')
let mcpDb: typeof import('./db/mcpApps.ts')
let sessionId: string
let messageId: string

if (!SKIP) {
  raw = new pg.Client(opts())
  await raw.connect()
  if (!(await raw.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).rows.length && APP_ROLE === 'ai_prism_app') {
    await raw.query(fs.readFileSync(path.join(HERE, '..', 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
  }
  const { migrateUp } = await import('./db/migrate.ts')
  const { applyAppGrants } = await import('./db/grants.ts')
  const quiet = { log() {}, warn() {} }
  await migrateUp(raw, { log: quiet })
  await applyAppGrants(raw, { role: APP_ROLE, log: quiet })
  env.PGUSER = APP_ROLE
  db = await import('./db.ts')
  mcpDb = await import('./db/mcpApps.ts')
  await db.ensureSchema(A, 'token-a')
  sessionId = await db.createSession(A, 'token-a', 'Sessão', 'm1', null, [])
  await db.addMessage(A, 'token-a', { sessionId, role: 'user', content: 'show the chart' })
  const a = await db.addMessage(A, 'token-a', { sessionId, role: 'assistant', content: 'here', model: 'm1', promptTokens: 1, completionTokens: 1 })
  messageId = a.id
  await db.addToolCalls(A, 'token-a', a.id, [
    { id: 'c1', name: 'mcp_chart__show_chart', args: { series: 'a' }, status: 'ok', result: 'chart ready', uiResource: UI },
    { id: 'c2', name: 'mcp_chart__plain', args: {}, status: 'ok', result: 'plain' },
  ])
}
const skip = SKIP || false

after(async () => {
  if (!raw) return
  await raw.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[A, B]]).catch(() => {})
  await raw.end().catch(() => {})
})

test('the messages projection carries hasUi metadata for an App and never its HTML', { skip }, async () => {
  const msgs = await db.listMessages(A, 'token-a', sessionId)
  const assistant = msgs.find((m: { id: string }) => String(m.id) === String(messageId))!
  const [withUi, plain] = assistant.tool_calls as Array<Record<string, unknown>>
  assert.equal(withUi!.hasUi, true)
  assert.equal(withUi!.uiServiceName, 'main.apps.chart')
  assert.match(String(withUi!.uiToolCallId), /^\d+$/)
  assert.deepEqual(withUi!.uiCsp, UI.csp)
  assert.equal(plain!.hasUi, false)
  assert.equal('uiToolCallId' in plain!, false)
  const wire = JSON.stringify(msgs)
  assert.equal(wire.includes(`html-sentinel-${stamp}`), false, 'no HTML in the serialized session payload')
  assert.equal(wire.includes('secret view body'), false)
  assert.equal('html' in (withUi as object), false)
})

test('the stored record is readable back only by the owner, through the view read', { skip }, async () => {
  const msgs = await db.listMessages(A, 'token-a', sessionId)
  const id = String((msgs.find((m: { id: string }) => String(m.id) === String(messageId))!.tool_calls as Array<Record<string, unknown>>)[0]!.uiToolCallId)
  const mine = await mcpDb.getUiToolCall(A, 'token-a', id)
  assert.equal(mine?.ui.html, SENTINEL)
  assert.equal(await mcpDb.getUiToolCall(B, 'token-b', id), null)
  assert.deepEqual(await db.listMessages(B, 'token-b', sessionId), [], 'B sees no message of A')
})
