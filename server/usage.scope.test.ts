// runWithUsageScope / currentUsageTags (W4-4b): the usage scope of an unattended run, opened outside
// any HTTP request. Rows are owner-attributed and carry kind 'scheduled'; the scope waits for its own
// ledger inserts before it returns; onCost sees each priced row as it is recorded (the run's cost cap).
//
//   node --test server/usage.scope.test.ts
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

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

const usage = await import('./usage.ts')
const db = await import('./db.ts')

const RUN = randomUUID().slice(0, 8)
const OWNER = `scope-owner-${RUN}@test.invalid`
const MODEL = 'databricks-claude-sonnet-5-5'
const USAGE = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }

async function query(sql: string, params?: unknown[]): Promise<Loose[]> {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows
  } finally {
    await c.end()
  }
}

before(async () => {
  if (SKIP) return
  await db.ensureSchema(OWNER, 'x')
})
after(async () => {
  if (SKIP) return
  await query(`DELETE FROM usage_ledger WHERE user_email = $1`, [OWNER]).catch(() => {})
  await query(`DELETE FROM chat_sessions WHERE user_email = $1`, [OWNER]).catch(() => {})
})

test('currentUsageTags is null outside a scope and inside one without tags', async () => {
  assert.equal(usage.currentUsageTags(), null)
  await usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled' }, async () => {
    assert.equal(usage.currentUsageTags(), null)
  })
})

test('currentUsageTags carries the run kind and the agent ids (never the e-mail), across awaits', async () => {
  await usage.runWithUsageScope(
    { email: OWNER, token: 'sp', kind: 'scheduled', tags: { agent_id: '7', agent_run_id: '42' } },
    async () => {
      await new Promise((r) => setTimeout(r, 5))
      const tags = usage.currentUsageTags()
      assert.deepEqual(tags, { ai_prism_run_kind: 'scheduled', ai_prism_agent_id: '7', ai_prism_agent_run_id: '42' })
      assert.ok(!JSON.stringify(tags).includes(OWNER))
    }
  )
  assert.equal(usage.currentUsageTags(), null, 'the scope does not leak')
})

test('runWithUsageScope returns the value of fn and rethrows its error after flushing', async () => {
  assert.equal(await usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled' }, async () => 'v'), 'v')
  await assert.rejects(
    usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled' }, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
})

test('onCost is called once per recorded row with its cost (null when unpriced)', { skip: SKIP }, async () => {
  const seen: Array<number | null> = []
  await usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled', onCost: (c) => seen.push(c) }, async () => {
    usage.recordUsage('chat', MODEL, USAGE)
    usage.recordUsage('chat', 'totally-unknown-model', USAGE)
  })
  assert.equal(seen.length, 2)
  assert.ok(typeof seen[0] === 'number' && seen[0]! > 0)
  assert.equal(seen[1], null)
})

test('rows are written for the owner with kind scheduled and the run session, and are there when the scope returns', { skip: SKIP }, async () => {
  const sessionId = await db.createSession(OWNER, 'sp', 'scope session', MODEL, '', [])
  await usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled', sessionId: String(sessionId) }, async () => {
    usage.recordUsage('chat', MODEL, USAGE)
    usage.recordUsage('title', MODEL, USAGE)
  })
  // no extra wait: runWithUsageScope awaited its own inserts
  const rows = await query(`SELECT kind, session_id::text AS session_id, user_email FROM usage_ledger WHERE user_email = $1 AND session_id = $2 ORDER BY id`, [OWNER, sessionId])
  assert.deepEqual(rows.map((r) => r.kind), ['scheduled', 'title'], "a request's 'chat' becomes 'scheduled'; other kinds keep their own")
  assert.ok(rows.every((r) => r.user_email === OWNER && r.session_id === String(sessionId)))
})

test('rows held until the session exists land on it; a late setUsageSession flushes them', { skip: SKIP }, async () => {
  const sessionId = await db.createSession(OWNER, 'sp', 'held session', MODEL, '', [])
  await usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled' }, async () => {
    usage.holdUsageUntilSession()
    usage.recordUsage('chat', MODEL, USAGE)
    usage.setUsageSession(String(sessionId))
  })
  const rows = await query(`SELECT kind FROM usage_ledger WHERE user_email = $1 AND session_id = $2`, [OWNER, sessionId])
  assert.deepEqual(rows.map((r) => r.kind), ['scheduled'])
})

test('buffered turn rows still held when fn ends are flushed, never dropped', { skip: SKIP }, async () => {
  const sessionId = await db.createSession(OWNER, 'sp', 'buffered session', MODEL, '', [])
  await usage.runWithUsageScope({ email: OWNER, token: 'sp', kind: 'scheduled', sessionId: String(sessionId) }, async () => {
    usage.bufferTurnUsage(usage.currentUsageScope())
    usage.recordUsage('chat', MODEL, USAGE)
  })
  const rows = await query(`SELECT 1 FROM usage_ledger WHERE user_email = $1 AND session_id = $2`, [OWNER, sessionId])
  assert.equal(rows.length, 1)
})

test('outside a scope recordUsage still attributes nothing (unchanged)', () => {
  assert.equal(usage.recordUsage('chat', MODEL, USAGE), null)
})
