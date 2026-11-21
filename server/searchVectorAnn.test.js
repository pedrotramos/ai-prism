// N3: Q5 (searchSessionsByVector) with an HNSW candidate path behind SEARCH_VECTOR_ANN.
//
// The flag is read once at import (like HISTORY_RETRIEVAL), so this file asserts
// the state it was started in. Run it twice:
//   node --test server/searchVectorAnn.test.js                       (exact, default)
//   SEARCH_VECTOR_ANN=on node --test server/searchVectorAnn.test.js  (HNSW candidates)
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
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

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
  } catch (e) {
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
function vecAt(sim, k) {
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

let db
let raw
const ids = {}

const q = async (sql, params = []) => (await raw.query(sql, params)).rows

async function addSession(email, title, { projectId = null, ephemeral = false } = {}) {
  return (
    await q(
      `INSERT INTO chat_sessions (user_email, title, model, project_id, ephemeral) VALUES ($1, $2, 'm1', $3, $4) RETURNING id`,
      [email, title, projectId, ephemeral]
    )
  )[0].id
}

// n messages in `sid`, similarities sims[i] to the query
async function addVectors(sid, sims) {
  const msgs = await q(
    `INSERT INTO chat_messages (session_id, role, content) SELECT $1, 'user', 'm' || g FROM generate_series(1, $2::int) g RETURNING id`,
    [sid, sims.length]
  )
  await q(
    `INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
     SELECT m, $2, v::vector FROM unnest($1::bigint[], $3::text[]) AS t(m, v)`,
    [msgs.map((m) => m.id), sid, sims.map((s, i) => vecAt(s, i + 1))]
  )
}

async function explainAs(email, sql, params) {
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
    return r.rows.map((row) => row['QUERY PLAN']).join('\n')
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
  const { migrateUp } = await import('./db/migrate.js')
  const { applyAppGrants } = await import('./db/grants.js')
  await migrateUp(raw, { log: { log() {}, warn() {} } })
  await applyAppGrants(raw, { role: APP_ROLE, log: { log() {}, warn() {} } })
  env.PGUSER = APP_ROLE
  db = await import('./db.js')
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
  await q(`ANALYZE chat_message_embeddings`)
  await q(`ANALYZE chat_sessions`)
}

async function cleanup() {
  if (!raw) return
  await raw.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[A, B, ids.D]])
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

test('AC1: flag unset: the exact query text is the path taken', { skip: skip || ANN_ON }, async () => {
  assert.equal(await db.searchVectorPath(A, 'tok'), 'exact')
  assert.equal(db.Q5_EXACT_SQL, MAIN_EXACT_SQL)
})

test('AC2: flag on: HNSW candidates (idx_msg_emb_hnsw in the plan), same row shape and ordering', { skip: skip || !ANN_ON }, async () => {
  assert.equal(await db.searchVectorPath(A, 'tok'), 'ann')
  const rows = await db.searchSessionsByVector(A, 'tok', QUERY, { minSimilarity: 0 })
  assert.deepEqual(rows.map((r) => Object.keys(r).sort()), rows.map(() => ['id', 'score', 'title']))
  assert.ok(rows.every((r) => typeof r.id === 'string' && typeof r.title === 'string' && typeof r.score === 'number'))
  assert.deepEqual(rows.map((r) => r.score), [...rows.map((r) => r.score)].sort((a, b) => b - a))
  // The plan of the candidate query as the app role, with the HNSW index reachable. On this tiny fixture the
  // planner would walk the session index instead (cheaper at 400 rows), so the per-session index is dropped
  // inside a transaction that is rolled back; the bench (evidence/n3) records the plan at 100k vectors.
  const plan = await explainAs(ids.D, db.Q5_ANN_ROUND_SQL, [`[${QUERY.join(',')}]`, ids.D, [], 400])
  assert.match(plan, /idx_msg_emb_hnsw/)
})

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
  assert.ok(Math.abs(rows[1].score - 0.6) < 1e-4)
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
