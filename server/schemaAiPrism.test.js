// W1-5: the dedicated ai_prism schema (migration 0002), the owner hand-off for
// databases with MIXED table ownership (the SP owns most tables, the deploying
// identity owns app_admins: measured on a real deployment), and the
// least-privilege grants applied by `scripts/migrate.mjs grants`.
//
// Same server and isolation rules as server/migrate.test.js: every database test
// runs in its own scratch database, and the roles it creates carry a per-run
// stamp (roles are cluster-wide), so parallel test files never see each other's
// roles. No local Postgres with pgvector → the database tests are skipped.
//
//   node --test server/schemaAiPrism.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { baselineCatalog, migrateDown, migrateUp, migrationStatus } from './db/migrate.js'
import { APP_TABLES, PREPARE_HANDOFF_SQL, applyAppGrants, prepareOwnerHandoff } from './db/grants.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const MIGRATIONS = path.join(HERE, 'migrations')

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
const ADMIN_DB = env.PGDATABASE || 'ai_prism'
const SUPERUSER = env.PGUSER
env.PG_POOL_IDLE_TIMEOUT_MS = '1000'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const createdDbs = []
const createdRoles = []
let seq = 0

function opts(database, user = SUPERUSER) {
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user,
    password: env.PGPASSWORD,
    database,
    ssl: false,
    connectionTimeoutMillis: 2000,
  }
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test server)`
  }
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    if (!ext.rows.length) return 'pgvector is not installed on this Postgres'
    return null
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false

async function admin(sql, database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql)
  } finally {
    await c.end().catch(() => {})
  }
}

async function role(kind, extra = '') {
  const name = `w15_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}

async function scratchDb(owner) {
  const name = `w15_db_${stamp}_${++seq}`
  await admin(`CREATE DATABASE ${name}${owner ? ` OWNER ${owner}` : ''}`)
  createdDbs.push(name)
  // pgvector is not a trusted extension: the superuser installs it, as the
  // platform does on Lakebase (0001's CREATE EXTENSION IF NOT EXISTS is then a no-op)
  await admin(`CREATE EXTENSION IF NOT EXISTS vector`, name)
  return name
}

async function connect(database, user) {
  const c = new pg.Client(opts(database, user))
  await c.connect()
  return c
}

async function as(database, user, fn) {
  const c = await connect(database, user)
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

function quietLog() {
  const lines = { log: [], warn: [] }
  return { lines, log: (...a) => lines.log.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')) }
}

// a migrations dir with only the baseline: builds the pre-W1-5 (1.x/W0-2) world
function baselineOnlyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w15-mig-'))
  for (const f of ['0001_baseline.up.sql', '0001_baseline.down.sql']) {
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  }
  return dir
}

after(async () => {
  if (SKIP) return
  for (const db of createdDbs) {
    await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`).catch(() => {})
    await admin(`DROP DATABASE IF EXISTS ${db}`).catch(() => {})
  }
  for (const r of createdRoles.reverse()) {
    // grants on databases that are gone are gone; what is left are cluster-level memberships
    await admin(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
  }
})

const BASELINE_TABLES = [...new Set(baselineCatalog().columns.map((c) => c.split('.')[0]))].sort()
const MOVED = [...BASELINE_TABLES, 'schema_migrations'].sort()
// the BIGSERIAL ids of 0001 (a deployed 1.x database measured 10: it predates chat_compactions)
const BASELINE_SEQUENCES = 11

async function where(c) {
  const r = await c.query(`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'ai_prism') AND c.relkind IN ('r', 'S', 'i')`)
  const pick = (schema, kind) =>
    r.rows
      .filter((x) => x.schema === schema && x.kind === kind)
      .map((x) => x.name)
      .sort()
  const owners = Object.fromEntries(r.rows.filter((x) => x.kind === 'r').map((x) => [`${x.schema}.${x.name}`, x.owner]))
  return {
    tables: { public: pick('public', 'r'), ai_prism: pick('ai_prism', 'r') },
    sequences: { public: pick('public', 'S'), ai_prism: pick('ai_prism', 'S') },
    indexes: { public: pick('public', 'i'), ai_prism: pick('ai_prism', 'i') },
    owners,
    schemaExists: (await c.query(`SELECT to_regnamespace('ai_prism') IS NOT NULL AS ok`)).rows[0].ok,
  }
}

async function versions(c) {
  return (await c.query(`SELECT version FROM schema_migrations ORDER BY 1`)).rows.map((r) => Number(r.version))
}

// Everything `grants` can change, as text: table/sequence/schema ACLs, default
// ACLs and the memberships of the app and owner roles.
async function privilegeState(c, roles) {
  const r = await c.query(
    `
    SELECT 'rel ' || n.nspname || '.' || c.relname || ' ' || coalesce(c.relacl::text, '') AS x
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'ai_prism') AND c.relkind IN ('r', 'S')
    UNION ALL
    SELECT 'nsp ' || nspname || ' ' || coalesce(nspacl::text, '') FROM pg_namespace WHERE nspname IN ('public', 'ai_prism')
    UNION ALL
    SELECT 'def ' || coalesce(defaclnamespace::regnamespace::text, '-') || ' ' || pg_get_userbyid(defaclrole) || ' ' || defaclobjtype::text || ' ' || defaclacl::text
      FROM pg_default_acl
    UNION ALL
    SELECT 'mem ' || pg_get_userbyid(roleid) || ' > ' || pg_get_userbyid(member) || ' ' || admin_option::text || inherit_option::text || set_option::text
      FROM pg_auth_members WHERE pg_get_userbyid(roleid) = ANY($1) OR pg_get_userbyid(member) = ANY($1)
    ORDER BY 1`,
    [roles]
  )
  return r.rows.map((x) => x.x)
}

// ---- static guards ------------------------------------------------------------

test('0002 moves every baseline table plus schema_migrations (a missed table would stay behind in public)', () => {
  assert.deepEqual([...APP_TABLES].sort(), MOVED)
  assert.equal(BASELINE_TABLES.length, 20)
  for (const dirn of ['up', 'down']) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, `0002_schema_ai_prism.${dirn}.sql`), 'utf8')
    const m = /ARRAY\[([^\]]+)\]/.exec(sql)
    assert.ok(m, `${dirn}: table list ARRAY[...] not found`)
    const listed = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort()
    assert.deepEqual(listed, MOVED, `0002 ${dirn} table list`)
  }
})

test('the Python hand-off in bundle/auto_config.py runs the exact SQL of server/db/grants.js', () => {
  const py = fs.readFileSync(path.join(REPO, 'bundle', 'auto_config.py'), 'utf8')
  const m = /PREPARE_HANDOFF_SQL = r?"""\n([\s\S]*?)"""/.exec(py)
  assert.ok(m, 'PREPARE_HANDOFF_SQL block not found in bundle/auto_config.py')
  assert.equal(m[1], PREPARE_HANDOFF_SQL, 'the two copies of the hand-off SQL differ: keep them identical')
})

// ---- single owner (local dev, CI, a fresh install by one identity) ---------------

test('up moves all 20 tables, their sequences, the HNSW index and schema_migrations into ai_prism', { skip: SKIP }, async () => {
  const db = await scratchDb()
  await as(db, SUPERUSER, async (c) => {
    const r = await migrateUp(c, { log: quietLog() })
    assert.deepEqual(r.applied, [1, 2])
    const w = await where(c)
    assert.deepEqual(w.tables.ai_prism, MOVED)
    assert.deepEqual(w.tables.public, [], 'nothing left in public')
    assert.equal(w.sequences.ai_prism.length, BASELINE_SEQUENCES)
    assert.deepEqual(w.sequences.public, [])
    assert.ok(w.indexes.ai_prism.includes('idx_msg_emb_hnsw'), 'the vector index moved with its table')
    assert.deepEqual(await versions(c), [1, 2])
    // the vector type stays in public and resolves through the search path
    const v = await c.query(`SELECT '[1,2,3]'::vector <=> '[1,2,3]'::vector AS d`)
    assert.equal(Number(v.rows[0].d), 0)
    const again = await migrateUp(c, { log: quietLog() })
    assert.deepEqual(again.applied, [], 'second up is a no-op')
  })
})

test('round trip: up → down --to 1 → up keeps the data, the sequences and the vector index', { skip: SKIP }, async () => {
  const db = await scratchDb()
  await as(db, SUPERUSER, async (c) => {
    await migrateUp(c, { log: quietLog() })
    const s1 = await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('a@test.invalid', 't', 'm') RETURNING id`)

    const down = await migrateDown(c, { to: 1, log: quietLog() })
    assert.deepEqual(down.reverted, [2])
    let w = await where(c)
    assert.equal(w.schemaExists, false, 'down drops the emptied schema')
    assert.deepEqual(w.tables.public, MOVED, 'down restores every table to public')
    assert.equal(w.sequences.public.length, BASELINE_SEQUENCES, 'and the sequences')
    assert.ok(w.indexes.public.includes('idx_msg_emb_hnsw'))
    assert.deepEqual(await versions(c), [1])
    const s2 = await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('a@test.invalid', 't', 'm') RETURNING id`)
    assert.ok(Number(s2.rows[0].id) > Number(s1.rows[0].id), 'the id sequence kept counting')

    const up = await migrateUp(c, { log: quietLog() })
    assert.deepEqual(up.applied, [2])
    w = await where(c)
    assert.deepEqual(w.tables.ai_prism, MOVED)
    assert.deepEqual(w.tables.public, [])
    const n = await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)
    assert.equal(n.rows[0].n, 2, 'the rows travelled both ways')

    await migrateDown(c, { to: 0, log: quietLog() })
    w = await where(c)
    assert.deepEqual(w.tables.public, [])
    assert.deepEqual(w.tables.ai_prism, [])
    assert.deepEqual((await migrateUp(c, { log: quietLog() })).applied, [1, 2], 'a full rebuild works too')
  })
})

test('a 1.x/W0-2 database (baseline in public) is moved by up, and its rows come along', { skip: SKIP }, async () => {
  const db = await scratchDb()
  await as(db, SUPERUSER, async (c) => {
    await migrateUp(c, { dir: baselineOnlyDir(), log: quietLog() })
    await c.query(`INSERT INTO app_admins (principal, added_by) VALUES ('owner@test.invalid', 'seed')`)
    const r = await migrateUp(c, { log: quietLog() })
    assert.deepEqual(r.applied, [2])
    const a = await c.query(`SELECT principal FROM ai_prism.app_admins`)
    assert.deepEqual(a.rows, [{ principal: 'owner@test.invalid' }])
  })
})

test('the app pool sets search_path = ai_prism, public on every connection (not per query)', { skip: SKIP }, async () => {
  // a role whose name is NOT ai_prism: the default "$user", public would not find the schema
  const app = await role('app')
  const db = await scratchDb(app)
  await as(db, app, (c) => migrateUp(c, { log: quietLog() }))
  const saved = { PGUSER: env.PGUSER, PGDATABASE: env.PGDATABASE }
  env.PGUSER = app
  env.PGDATABASE = db
  try {
    const { withClient } = await import('./db.js')
    const sp = await withClient('pool-check@test.invalid', 'tok', async (c) => (await c.query('SHOW search_path')).rows[0].search_path)
    assert.equal(sp, 'ai_prism, public')
    const n = await withClient('pool-check@test.invalid', 'tok', async (c) => (await c.query('SELECT count(*)::int AS n FROM chat_sessions')).rows[0].n)
    assert.equal(n, 0, 'unqualified app queries resolve to ai_prism')
  } finally {
    env.PGUSER = saved.PGUSER
    if (saved.PGDATABASE === undefined) delete env.PGDATABASE
    else env.PGDATABASE = saved.PGDATABASE
  }
})

// ---- mixed ownership: the real deployment shape ------------------------------------

// Builds what a deployed 1.x/W0-2 app looks like: the deploying identity owns the
// database and app_admins (auto_config creates it before the app boots), the SP
// owns every other table (it ran the schema on its first request).
async function mixedDeployment() {
  const dep = await role('dep', 'CREATEROLE')
  const sp = await role('sp')
  const owner = `w15_owner_${stamp}_${++seq}`
  createdRoles.push(owner)
  const db = await scratchDb(dep)
  await as(db, dep, async (c) => {
    // what bundle/auto_config.py granted before W1-5
    await c.query(`GRANT CREATE ON DATABASE ${db} TO ${sp}`)
    await c.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${sp}`)
    await c.query(
      `CREATE TABLE app_admins (principal TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'user', added_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`
    )
    await c.query(`INSERT INTO app_admins (principal, added_by) VALUES ('dep@test.invalid', 'auto-config')`)
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON app_admins TO ${sp}`)
  })
  await as(db, sp, (c) => migrateUp(c, { dir: baselineOnlyDir(), log: quietLog(), ownerRole: owner }))
  return { dep, sp, owner, db }
}

test('mixed ownership without the hand-off: 0002 is deferred, the app keeps working on public', { skip: SKIP }, async () => {
  const { sp, owner, db } = await mixedDeployment()
  await as(db, sp, async (c) => {
    const before = await where(c)
    assert.equal(before.owners['public.app_admins'] !== sp, true, 'precondition: app_admins is not the SP’s')
    assert.equal(before.owners['public.chat_sessions'], sp, 'precondition: the SP owns the rest')
    const log = quietLog()
    const r = await migrateUp(c, { log, ownerRole: owner })
    assert.deepEqual(r.applied, [])
    assert.deepEqual(r.deferred, [2])
    assert.ok(log.lines.warn.some((w) => /ownership/.test(w) && /prepare/.test(w)), log.lines.warn.join('\n'))
    const w = await where(c)
    assert.equal(w.schemaExists, false, 'the failed 0002 left nothing behind')
    assert.deepEqual(w.tables.public, MOVED)
    assert.deepEqual(await versions(c), [1])
    await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('a@test.invalid', 't', 'm')`)
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM app_admins`)).rows[0].n, 1)
  })
})

test('mixed ownership with the hand-off: prepare → SP up → grants (twice) → least privilege; round trip clean', { skip: SKIP }, async () => {
  const { dep, sp, owner, db } = await mixedDeployment()

  // 1. deploying identity, before the new code boots
  await as(db, dep, async (c) => {
    await prepareOwnerHandoff(c, { role: sp, owner })
    await prepareOwnerHandoff(c, { role: sp, owner }) // idempotent: a redeploy runs it again
  })

  // 2. the SP at boot
  await as(db, sp, async (c) => {
    const log = quietLog()
    const r = await migrateUp(c, { log, ownerRole: owner })
    assert.deepEqual(r.applied, [2], log.lines.warn.join('\n'))
    const w = await where(c)
    assert.deepEqual(w.tables.ai_prism, MOVED)
    assert.deepEqual(w.tables.public, [])
    for (const t of MOVED) assert.equal(w.owners[`ai_prism.${t}`], owner, `${t} owned by the owner role`)
  })

  // 3. deploying identity, after the smoke: least-privilege grants, twice
  let first
  await as(db, dep, async (c) => {
    const r1 = await applyAppGrants(c, { role: sp, owner })
    first = await privilegeState(c, [sp, owner])
    const r2 = await applyAppGrants(c, { role: sp, owner })
    assert.deepEqual(await privilegeState(c, [sp, owner]), first, 'grants run twice → same state')
    assert.equal(r1.revokedHandoff, true)
    assert.equal(r2.revokedHandoff, false)
  })

  // the SP now: DML on app tables, nothing more
  await as(db, sp, async (c) => {
    await c.query(`SET search_path TO ai_prism, public`)
    const m = await c.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS member`, [sp, owner])
    assert.equal(m.rows[0].member, false, 'the hand-off membership is revoked')
    const s = await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('a@test.invalid', 't', 'm') RETURNING id`)
    assert.ok(Number(s.rows[0].id) > 0, 'insert + sequence work')
    await c.query(`UPDATE chat_sessions SET title = 't' WHERE id = $1`, [s.rows[0].id])
    await c.query(`DELETE FROM chat_sessions WHERE id = $1`, [s.rows[0].id])
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM app_admins`)).rows[0].n, 1, 'admin seed moved with its table')
    await assert.rejects(c.query(`DROP TABLE chat_messages`), /must be owner/)
    await assert.rejects(c.query(`CREATE TABLE ai_prism.x (id int)`), /permission denied/)
    await assert.rejects(c.query(`CREATE TABLE public.x (id int)`), /permission denied/)
    await assert.rejects(c.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'x', 'x')`), /permission denied/)
    const pub = await c.query(`SELECT coalesce(nspacl::text, '') AS acl FROM pg_namespace WHERE nspname = 'public'`)
    assert.ok(!pub.rows[0].acl.includes(sp), 'no explicit grant on public left for the SP')
    // steady-state boot as the SP: reads schema_migrations, nothing to do
    const st = await migrationStatus(c)
    assert.deepEqual(st.pending, [])
    assert.deepEqual((await migrateUp(c, { log: quietLog(), ownerRole: owner })).applied, [])
  })

  // round trip by the owner identity: down to public, up again, grants again
  await as(db, dep, async (c) => {
    const d = await migrateDown(c, { to: 1, log: quietLog(), ownerRole: owner })
    assert.deepEqual(d.reverted, [2])
    let w = await where(c)
    assert.deepEqual(w.tables.public, MOVED)
    assert.equal(w.schemaExists, false)
    const u = await migrateUp(c, { log: quietLog(), ownerRole: owner })
    assert.deepEqual(u.applied, [2])
    w = await where(c)
    assert.deepEqual(w.tables.ai_prism, MOVED)
    await applyAppGrants(c, { role: sp, owner })
  })
  await as(db, sp, async (c) => {
    await c.query(`SET search_path TO ai_prism, public`)
    await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('b@test.invalid', 't', 'm')`)
  })
})

// The shape measured on a real deployment: probe-era (no schema_migrations), the
// baseline INCOMPLETE (chat_compactions missing: it predates that table), SP-owned
// tables, deployer-owned app_admins. The runner repairs it with the idempotent
// 0001, whose ALTER TABLE … IF NOT EXISTS still needs the table's owner: under the
// hand-off the session identity's tables must reach the owner role BEFORE 0001.
test('real deployment shape (probe-era, incomplete baseline, mixed owners): hand-off → SP up applies 1 and 2', { skip: SKIP }, async () => {
  const { dep, sp, owner, db } = await mixedDeployment()
  await as(db, sp, async (c) => {
    await c.query(`DROP TABLE chat_compactions`)
    await c.query(`DROP TABLE schema_migrations`)
  })
  await as(db, dep, (c) => prepareOwnerHandoff(c, { role: sp, owner }))
  await as(db, sp, async (c) => {
    const log = quietLog()
    const r = await migrateUp(c, { log, ownerRole: owner })
    assert.deepEqual(r.applied, [1, 2], log.lines.warn.join('\n'))
    const w = await where(c)
    assert.deepEqual(w.tables.ai_prism, MOVED)
    assert.deepEqual(w.tables.public, [])
    for (const t of MOVED) assert.equal(w.owners[`ai_prism.${t}`], owner, `${t} owned by the owner role`)
  })
  await as(db, dep, (c) => applyAppGrants(c, { role: sp, owner }))
  await as(db, sp, async (c) => {
    await c.query(`SET search_path TO ai_prism, public`)
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM app_admins`)).rows[0].n, 1)
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM chat_compactions`)).rows[0].n, 0)
  })
})

test('grants refuses to run before 0002 (nothing is revoked on a database still in public)', { skip: SKIP }, async () => {
  const { dep, sp, owner, db } = await mixedDeployment()
  await as(db, dep, async (c) => {
    const before = await privilegeState(c, [sp])
    await assert.rejects(applyAppGrants(c, { role: sp, owner }), /ai_prism.*migrate\.mjs up/)
    assert.deepEqual(await privilegeState(c, [sp]), before)
  })
})

// ---- scripts/migrate.mjs grants / prepare --------------------------------------------

function cli(args, database, user, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'migrate.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: env.PATH,
      PGHOST: env.PGHOST,
      PGPORT: env.PGPORT,
      PGUSER: user,
      PGPASSWORD: env.PGPASSWORD,
      PGDATABASE: database,
      PGSSLMODE: 'disable',
      ...extraEnv,
    },
    timeout: 60_000,
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

test('migrate.mjs: prepare, up and grants by the owner identity; grants is idempotent', { skip: SKIP }, async () => {
  const { dep, sp, owner, db } = await mixedDeployment()
  const own = { AI_PRISM_OWNER_ROLE: owner }
  assert.equal(cli(['grants'], db, dep, own).code, 2, 'grants without --role or DATABRICKS_CLIENT_ID is a usage error')
  let r = cli(['prepare', '--role', sp], db, dep, own)
  assert.equal(r.code, 0, r.out)
  // the SP's boot (the deploy wrapper never runs as the SP)
  await as(db, sp, (c) => migrateUp(c, { log: quietLog(), ownerRole: owner }))
  r = cli(['up', '--role', sp], db, dep, own)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /nothing to apply/)
  assert.match(r.out, /grants/)
  const state1 = await as(db, dep, (c) => privilegeState(c, [sp, owner]))
  r = cli(['grants', '--role', sp], db, dep, own)
  assert.equal(r.code, 0, r.out)
  r = cli(['grants'], db, dep, { ...own, DATABRICKS_CLIENT_ID: sp })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(await as(db, dep, (c) => privilegeState(c, [sp, owner])), state1, 'same state after repeated grants')
})
