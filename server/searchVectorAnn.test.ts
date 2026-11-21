// N3: Q5 (searchSessionsByVector) with an HNSW candidate path behind SEARCH_VECTOR_ANN.
//
// The flag is read once at import (like HISTORY_RETRIEVAL), so this file asserts
// the state it was started in. Run it twice:
//   node --test server/searchVectorAnn.test.ts                       (exact, default)
//   SEARCH_VECTOR_ANN=on node --test server/searchVectorAnn.test.ts  (HNSW candidates)
// Scoping (AC3) and diversity (AC4) must hold in both states; AC1 only applies
// with the flag unset, AC2 only with it on. Same SKIP probe and DB defaults as
// isolation.test.js: a local Postgres with pgvector, db.js connected as the
// NOSUPERUSER/NOBYPASSRLS app role.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// any: pg rows are untyped
type Row = any
import { spawnSync } from 'node:child_process'
import { ownSessionSql } from './ownerScopedWrites.ts'

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
const ANN_ON = env.SEARCH_VECTOR_ANN === 'on'
const SUPERUSER = env.PGUSER
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set<string | undefined>(['127.0.0.1', 'localhost', '::1'])

const connectionOptions = (user = SUPERUSER) => ({
  host: env.PGHOST,
  port: Number(env.PGPORT),
  user,
  password: env.PGPASSWORD,
  database: env.PGDATABASE,
  ssl: false,
  connectionTimeoutMillis: 2000,
})

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client(connectionOptions())
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed in this Postgres'
  } catch (err) {
    const e = err as Error & { code?: string }
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message})`
  } finally {
    await c.end().catch(() => {})
  }
}

const SKIP = await skipReason()
const skip = SKIP || false
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const A = `ann-a-${stamp}@test.invalid`
const B = `ann-b-${stamp}@test.invalid`
const DIM = 1024

// a unit vector whose cosine similarity to the query (axis 0) is exactly `sim`;
// `k` (1..1023) picks the orthogonal direction so rows are distinct
function vecAt(sim: number, k: number) {
  const v = new Array(DIM).fill(0)
  v[0] = sim
  v[k % (DIM - 1) + 1] = Math.sqrt(1 - sim * sim)
  return `[${v.join(',')}]`
}
const QUERY = (() => {
  const v = new Array(DIM).fill(0)
  v[0] = 1
  return v
})()

let db: typeof import('./db.ts')
let raw: pg.Client
const ids: Record<string, any> = {} // any: a bag of fixture ids (strings and string lists)

const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await raw.query(sql, params)).rows

async function addSession(email: string, title: string, { projectId = null, ephemeral = false }: { projectId?: string | null; ephemeral?: boolean } = {}) {
  return (
    await q(
      `INSERT INTO chat_sessions (user_email, title, model, project_id, ephemeral) VALUES ($1, $2, 'm1', $3, $4) RETURNING id`,
      [email, title, projectId, ephemeral]
    )
  )[0].id
}

// n messages in `sid`, similarities sims[i] to the query
async function addVectors(sid: string, sims: number[], identical = false) {
  const msgs = await q(
    `INSERT INTO chat_messages (session_id, role, content) SELECT $1, 'user', 'm' || g FROM generate_series(1, $2::int) g RETURNING id`,
    [sid, sims.length]
  )
  await q(
    `INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
     SELECT m, $2, v::vector FROM unnest($1::bigint[], $3::text[]) AS t(m, v)`,
    [msgs.map((m: Row) => m.id), sid, sims.map((s, i) => vecAt(s, identical ? 1 : i + 1))]
  )
}

async function explainAs(email: string, sql: string, params: unknown[]) {
  const c = new pg.Client(connectionOptions())
  await c.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL search_path = ai_prism, public`)
    await c.query(`DROP INDEX IF EXISTS idx_msg_emb_session`)
    await c.query(`SET LOCAL ROLE ${APP_ROLE}`)
    await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', '[]', true)`, [email])
    await c.query(`SET LOCAL enable_seqscan = off`)
    const r = await c.query(`EXPLAIN ${sql}`, params)
    return r.rows.map((row: Row) => row['QUERY PLAN']).join('\n')
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end().catch(() => {})
  }
}

// The ANN path on a bare transaction as the app role, with the HNSW index reachable (see explainAs), plus the
// exact path on the same transaction. `spy` counts the candidate rounds that really ran.
async function annVsExact(email: string, opts: { limit?: number; minSimilarity?: number; candidates?: number; maxRounds?: number } = {}) {
  const c = new pg.Client(connectionOptions())
  await c.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL search_path = ai_prism, public`)
    await c.query(`DROP INDEX IF EXISTS idx_msg_emb_session`)
    await c.query(`SET LOCAL ROLE ${APP_ROLE}`)
    await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', '[]', true)`, [email])
    await c.query(`SET LOCAL enable_seqscan = off`)
    const rounds: number[] = []
    const spy = {
      query: async (sql: string, params?: unknown[]) => {
        const r = await c.query(sql, params)
        if (sql.includes('WITH nn AS')) rounds.push(r.rows.reduce((n: number, row: Row) => n + row.n, 0))
        return r
      },
    }
    const ann = await db.runSessionVectorSearch(spy, true, email, QUERY, opts)
    const exact = await db.runSessionVectorSearch(c, false, email, QUERY, opts)
    return { ann, exact, rounds }
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end().catch(() => {})
  }
}

async function setup() {
  raw = new pg.Client(connectionOptions())
  await raw.connect()
  const hasRole = await raw.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
  if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
    await raw.query(fs.readFileSync(path.join(HERE, '..', 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
  }
  const { migrateUp } = await import('./db/migrate.ts')
  const { applyAppGrants } = await import('./db/grants.ts')
  await migrateUp(raw, { log: { log() {}, warn() {} } })
  await applyAppGrants(raw, { role: APP_ROLE, log: { log() {}, warn() {} } })
  env.PGUSER = APP_ROLE
  db = await import('./db.ts')
  await db.ensureSchema(A, 'tok')

  // AC3 fixture: A's own sessions, a project A belongs to, a project A left, B's data
  const projIn = (await q(`INSERT INTO projects (name, created_by) VALUES ('in', $1) RETURNING id`, [A]))[0].id
  const projOut = (await q(`INSERT INTO projects (name, created_by) VALUES ('out', $1) RETURNING id`, [B]))[0].id
  await q(`INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', $2, 'view')`, [projIn, B]) // the creator becomes owner by trigger
  ids.own = await addSession(A, 'own')
  ids.ownProject = await addSession(A, 'own-project', { projectId: projIn })
  ids.bInMyProject = await addSession(B, 'b-in-shared-project', { projectId: projIn }) // B's session: not A's own
  ids.noMembership = await addSession(A, 'a-in-project-without-membership', { projectId: projOut })
  ids.ephemeral = await addSession(A, 'ephemeral', { ephemeral: true })
  ids.other = await addSession(B, 'b-own')
  for (const s of [ids.own, ids.ownProject, ids.bInMyProject, ids.noMembership, ids.ephemeral, ids.other]) await addVectors(s, [0.9])

  // AC4 fixture: user B2's huge session holds more messages than K (400) and all of them are nearer
  // to the query than the only message of the small session
  const D = `ann-d-${stamp}@test.invalid`
  ids.D = D
  ids.huge = await addSession(D, 'huge')
  ids.small = await addSession(D, 'small-but-relevant')
  await addVectors(ids.huge, Array.from({ length: 450 }, (_, i) => 0.99 - i * 1e-4))
  await addVectors(ids.small, [0.6])
  // B1 fixtures. E: one session of 401 IDENTICAL near vectors (an approximate HNSW round can return fewer than
  // its LIMIT) plus one relevant small session. F: 10 sessions that each fill a whole round (K=20 in the test),
  // more than the 8-round cap, plus a small relevant one.
  ids.E = `ann-e-${stamp}@test.invalid`
  ids.F = `ann-f-${stamp}@test.invalid`
  const bigE = await addSession(ids.E, 'e-large')
  const smallE = await addSession(ids.E, 'e-small')
  await addVectors(bigE, new Array(401).fill(0.99), true)
  await addVectors(smallE, [0.5])
  ids.eSessions = [bigE, smallE]
  ids.fSessions = []
  for (let i = 0; i < 10; i++) {
    const s = await addSession(ids.F, `f-oversized-${i}`)
    await addVectors(s, new Array(25).fill(0.99 - i * 0.01), true)
    ids.fSessions.push(s)
  }
  ids.fSessions.push(await addSession(ids.F, 'f-small'))
  await addVectors(ids.fSessions[10], [0.4])
  await q(`ANALYZE chat_message_embeddings`)
  await q(`ANALYZE chat_sessions`)
}

async function cleanup() {
  if (!raw) return
  await raw.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[A, B, ids.D, ids.E, ids.F]])
  await raw.query(`DELETE FROM projects WHERE created_by = ANY($1)`, [[A, B]])
  await raw.end().catch(() => {})
}

if (!SKIP) await setup()
after(cleanup)

// the exact query exactly as on main (5aac138): AC1 asserts the default path still runs this text
const MAIN_EXACT_SQL = `SELECT s.id, s.title, MAX(1 - (e.embedding <=> $1::vector)) AS score
         FROM chat_message_embeddings e
         JOIN chat_sessions s ON s.id = e.session_id AND NOT s.ephemeral AND ${ownSessionSql('s', '$2')}
        GROUP BY s.id, s.title
       HAVING MAX(1 - (e.embedding <=> $1::vector)) >= $3
        ORDER BY score DESC
        LIMIT $4`

test('AC1: the exact query text is unchanged on main, and with the flag unset it is the path taken', { skip }, async () => {
  assert.equal(db.Q5_EXACT_SQL, MAIN_EXACT_SQL)
  assert.equal(await db.searchVectorPath(A, 'tok'), ANN_ON ? 'ann' : 'exact')
  // the exact path returns what the exact query returns, row for row
  const viaApi = await db.searchSessionsByVector(ids.D, 'tok', QUERY, { minSimilarity: 0 })
  const direct = await db.withTx(ids.D, 'tok', async (c) =>
    (await c.query(db.Q5_EXACT_SQL, [`[${QUERY.join(',')}]`, ids.D, 0, 20])).rows.map((r: Row) => ({ id: String(r.id), title: r.title, score: r.score }))
  )
  assert.deepEqual(
    viaApi.map((r) => r.id),
    direct.map((r: Row) => r.id)
  )
})

test('AC2: HNSW candidates (idx_msg_emb_hnsw in the plan), same row shape and ordering as the exact path', { skip }, async () => {
  const rows = await db.searchSessionsByVector(A, 'tok', QUERY, { minSimilarity: 0 })
  assert.ok(rows.length >= 2)
  assert.deepEqual(rows.map((r) => Object.keys(r).sort()), rows.map(() => ['id', 'score', 'title']))
  assert.ok(rows.every((r) => typeof r.id === 'string' && typeof r.title === 'string' && typeof r.score === 'number'))
  assert.deepEqual(rows.map((r) => r.score), [...rows.map((r: Row) => r.score)].sort((a, b) => b - a))
  // The plan of the candidate query as the app role, with the HNSW index reachable. On this tiny fixture the
  // planner would walk the session index instead (cheaper at 400 rows), so the per-session index is dropped
  // inside a transaction that is rolled back; the bench (evidence/n3) records the plan at 100k vectors.
  const plan = await explainAs(ids.D, db.Q5_ANN_ROUND_SQL, [`[${QUERY.join(',')}]`, ids.D, [], 400])
  assert.match(plan, /idx_msg_emb_hnsw/)
})

// The flag is read once at import, so the flag-on state runs in a child process of the default run: one
// `node tests/run.mjs` covers both. The child registers no such test (no recursion, no skips).
if (!ANN_ON) {
  test('flag on: this whole file passes with SEARCH_VECTOR_ANN=on (child process)', { skip }, async () => {
    const childEnv: Record<string, string | undefined> = { ...process.env, SEARCH_VECTOR_ANN: 'on', PGUSER: SUPERUSER }
    delete childEnv.NODE_TEST_CONTEXT // else the child reports to the parent runner instead of printing its own result
    const r = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
      env: childEnv,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000))
    assert.match(r.stdout, /# pass [1-9]/)
    assert.match(r.stdout, /# skipped 0/)
  })
}

test('AC3: another user, ephemeral chats and project chats without membership never appear', { skip }, async () => {
  const rows = await db.searchSessionsByVector(A, 'tok', QUERY, { minSimilarity: 0 })
  assert.deepEqual(rows.map((r) => r.id).sort(), [String(ids.own), String(ids.ownProject)].sort())
  const rowsB = await db.searchSessionsByVector(B, 'tok', QUERY, { minSimilarity: 0 })
  assert.ok(!rowsB.some((r) => [ids.own, ids.ownProject, ids.noMembership, ids.ephemeral].map(String).includes(r.id)))
  assert.ok(rowsB.some((r) => r.id === String(ids.other)))
})

test('AC4: diversity: a relevant small session still appears behind a session with more than K nearer messages', { skip }, async () => {
  const rows = await db.searchSessionsByVector(ids.D, 'tok', QUERY, { limit: 20, minSimilarity: 0.3 })
  assert.deepEqual(rows.map((r) => r.id), [String(ids.huge), String(ids.small)])
  assert.ok(Math.abs(rows[1]!.score - 0.6) < 1e-4)
})

test('B1: a short or empty HNSW round is not proof of exhaustion: the call still returns every session the exact path does', { skip }, async () => {
  const { ann, exact, rounds } = await annVsExact(ids.E)
  assert.equal(exact.length, 2)
  assert.ok(rounds.length >= 1, 'the HNSW round really ran')
  assert.deepEqual(ann.map((r) => r.id).sort(), exact.map((r) => r.id).sort())
})

test('B1: the round cap reached with fewer than `limit` sessions falls back to the exact query', { skip }, async () => {
  // Deterministic: a client whose candidate rounds are always FULL and each held by one new oversized session
  // (10 of them, more than the 8-round cap); the exact query runs on the real rows of user F (10 + 1 sessions).
  const K = 20
  const c = new pg.Client(connectionOptions())
  await c.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL search_path = ai_prism, public`)
    await c.query(`SET LOCAL ROLE ${APP_ROLE}`)
    await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', '[]', true)`, [ids.F])
    let round = 0
    const stub = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('WITH nn AS')) {
          const i = round++
          const sim = 0.99 - i * 0.01
          return { rows: [{ id: ids.fSessions[i], title: `f-oversized-${i}`, score: sim, floor_sim: sim, n: K }] }
        }
        return c.query(sql, params)
      },
    }
    const ann = await db.runSessionVectorSearch(stub, true, ids.F, QUERY, { candidates: K })
    const exact = await db.runSessionVectorSearch(c, false, ids.F, QUERY, { candidates: K })
    assert.equal(exact.length, 11)
    assert.equal(round, 8, 'the cap of 8 rounds was reached')
    assert.deepEqual(ann.map((r) => r.id), exact.map((r) => r.id))
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end().catch(() => {})
  }
})

test('B1: a round that returns nothing is not proof either: the exact query answers', { skip }, async () => {
  const c = new pg.Client(connectionOptions())
  await c.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL search_path = ai_prism, public`)
    await c.query(`SET LOCAL ROLE ${APP_ROLE}`)
    await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', '[]', true)`, [ids.D])
    const stub = { query: async (sql: string, params?: unknown[]) => (sql.includes('WITH nn AS') ? { rows: [] } : c.query(sql, params)) }
    const ann = await db.runSessionVectorSearch(stub, true, ids.D, QUERY)
    const exact = await db.runSessionVectorSearch(c, false, ids.D, QUERY)
    assert.ok(exact.length >= 2)
    assert.deepEqual(ann, exact)
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    await c.end().catch(() => {})
  }
})

// B1-R2 (QA r2): a SHORT round (fewer than K messages) is never proof of anything, even when it holds `limit`
// distinct sessions or crosses the floor: only a full round may prove `limit` or the floor.
function stubClient(roundRows: Row[], exactRows: Row[]) {
  let exactCalls = 0
  return {
    get exactCalls() {
      return exactCalls
    },
    query: async (sql: string) => {
      if (sql.includes('SELECT extversion FROM pg_extension')) return { rows: [{ extversion: '0.8.7' }] }
      if (sql.includes("set_config('hnsw.ef_search'")) return { rows: [] }
      if (sql === db.Q5_ANN_ROUND_SQL) return { rows: roundRows }
      if (sql === db.Q5_EXACT_SQL) {
        exactCalls++
        return { rows: exactRows }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
}
const EXACT_ROWS = [
  { id: '20', title: 'exact-a', score: 0.96 },
  { id: '21', title: 'exact-b', score: 0.95 },
]

test('B1-R2: a short round holding `limit` distinct sessions still falls back to the exact query', { skip }, async () => {
  const c = stubClient(
    [
      { id: '10', title: 'ann-a', score: 0.99, floor_sim: 0.99, n: 2 },
      { id: '11', title: 'ann-b', score: 0.98, floor_sim: 0.98, n: 1 },
    ],
    EXACT_ROWS
  )
  const rows = await db.runSessionVectorSearch(c, true, 'qa@example.invalid', QUERY, { limit: 2, candidates: 4, minSimilarity: 0.3 })
  assert.equal(c.exactCalls, 1, 'short HNSW rounds must use the exact query')
  assert.deepEqual(rows, EXACT_ROWS)
})

test('B1-R2: a short round that crosses minSimilarity still falls back to the exact query', { skip }, async () => {
  const c = stubClient([{ id: '10', title: 'ann-a', score: 0.99, floor_sim: 0.2, n: 3 }], EXACT_ROWS)
  const rows = await db.runSessionVectorSearch(c, true, 'qa@example.invalid', QUERY, { limit: 2, candidates: 4, minSimilarity: 0.3 })
  assert.equal(c.exactCalls, 1, 'an approximate floor crossing in a short round is not proof of completeness')
  assert.deepEqual(rows, EXACT_ROWS)
})

test('B1-R2: a FULL round still proves `limit` and the floor (the HNSW answer is kept, no exact query)', { skip }, async () => {
  const full = stubClient(
    [
      { id: '10', title: 'ann-a', score: 0.99, floor_sim: 0.99, n: 2 },
      { id: '11', title: 'ann-b', score: 0.98, floor_sim: 0.97, n: 2 },
    ],
    EXACT_ROWS
  )
  const a = await db.runSessionVectorSearch(full, true, 'qa@example.invalid', QUERY, { limit: 2, candidates: 4, minSimilarity: 0.3 })
  assert.equal(full.exactCalls, 0)
  assert.deepEqual(a.map((r) => r.id), ['10', '11'])
  const floor = stubClient([{ id: '10', title: 'ann-a', score: 0.99, floor_sim: 0.2, n: 4 }], EXACT_ROWS)
  const b = await db.runSessionVectorSearch(floor, true, 'qa@example.invalid', QUERY, { limit: 2, candidates: 4, minSimilarity: 0.3 })
  assert.equal(floor.exactCalls, 0)
  assert.deepEqual(b.map((r) => r.id), ['10'])
})

test('minSimilarity still cuts: a session below the floor is dropped in both paths', { skip }, async () => {
  const rows = await db.searchSessionsByVector(ids.D, 'tok', QUERY, { limit: 20, minSimilarity: 0.7 })
  assert.deepEqual(rows.map((r) => r.id), [String(ids.huge)])
})

test('SET LOCAL does not leak: a later transaction on the pool sees the default ef_search', { skip }, async () => {
  await db.searchSessionsByVector(ids.D, 'tok', QUERY, { minSimilarity: 0 })
  const v = await db.withTx(ids.D, 'tok', async (c) => (await c.query(`SELECT current_setting('hnsw.ef_search') AS v`)).rows[0].v)
  assert.equal(v, '40')
})
