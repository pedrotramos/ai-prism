// W2-1: row-level security in the ai_prism schema (migration 0003).
//
// The app connects as ONE Postgres role (the app's service principal) for every
// user. Isolation is enforced by the database: ENABLE + FORCE ROW LEVEL
// SECURITY on every app table, policies on current_setting('app.user_email')
// and current_setting('app.is_admin'), and server/db/pool.js withTx setting both
// per transaction (set_config(..., true), the parameterised SET LOCAL).
//
// Same server and isolation rules as server/schemaAiPrism.test.js: every database
// test runs in its own scratch database, and the roles it creates carry a per-run
// stamp. No local Postgres with pgvector → the database tests are skipped.
//
//   node --test server/rls.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { loadMigrations, migrateDown, migrateUp } from './db/migrate.js'
import { APP_TABLES, applyAppGrants, prepareOwnerHandoff } from './db/grants.js'

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
  const name = `w21_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}

async function scratchDb(owner) {
  const name = `w21_db_${stamp}_${++seq}`
  await admin(`CREATE DATABASE ${name}${owner ? ` OWNER ${owner}` : ''}`)
  createdDbs.push(name)
  await admin(`CREATE EXTENSION IF NOT EXISTS vector`, name)
  return name
}

async function as(database, user, fn) {
  const c = new pg.Client(opts(database, user))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

function quietLog() {
  const lines = { log: [], warn: [] }
  return { lines, log: (...a) => lines.log.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')) }
}

after(async () => {
  if (SKIP) return
  for (const db of createdDbs) {
    await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`).catch(() => {})
    await admin(`DROP DATABASE IF EXISTS ${db}`).catch(() => {})
  }
  for (const r of createdRoles.reverse()) await admin(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
})

// A fresh deployment, the way the deploy runs it: the deploying identity owns the
// database and prepares the owner hand-off, the SP applies every migration at
// boot as the owner role, the deploying identity applies the grants (which closes
// the hand-off). Returns the roles and the database.
const DIAG_ATTRS = 'NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE'

// withDiag: the diagnostic role (0013) exists before the migrations run, as it does once an
// operator ran `diag-grant` or a CREATEROLE identity ran `up`: the role is a cluster object,
// the SP that applies the migrations at boot cannot create it. The name is per run
// (ai_prism.diag_role, set on the scratch database) so parallel files never share one.
async function deployment({ withDiag = true } = {}) {
  const dep = await role('dep', 'CREATEROLE')
  const sp = await role('sp')
  const owner = `w21_owner_${stamp}_${++seq}`
  createdRoles.push(owner)
  const db = await scratchDb(dep)
  const diag = `ai_prism_diag_test_${stamp}${++seq}`
  createdRoles.push(diag)
  await admin(`ALTER DATABASE ${db} SET ai_prism.diag_role = '${diag}'`)
  if (withDiag) await admin(`CREATE ROLE ${diag} ${DIAG_ATTRS}`)
  await as(db, dep, (c) => prepareOwnerHandoff(c, { role: sp, owner }))
  const up = await as(db, sp, (c) => migrateUp(c, { log: quietLog(), ownerRole: owner }))
  await as(db, dep, (c) => applyAppGrants(c, { role: sp, owner }))
  return { dep, sp, owner, db, up, diag }
}

// One transaction as `user` with the app identity set the way withTx sets it.
async function asApp(db, user, email, fn, { admin: isAdmin = false } = {}) {
  return as(db, user, async (c) => {
    await c.query('BEGIN')
    try {
      await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true)`, [
        email ?? '',
        isAdmin ? 'on' : 'off',
      ])
      const r = await fn(c)
      await c.query('COMMIT')
      return r
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}

const A = 'rls-a@test.invalid'
const B = 'rls-b@test.invalid'
const isRlsViolation = (e) => e?.code === '42501' && /row-level security/.test(e.message)

// Rows of A in every per-user table, written by the superuser (RLS does not apply to it).
async function seedA(db) {
  return as(db, SUPERUSER, async (c) => {
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [A])).rows[0].id
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'segredo') RETURNING id`, [s])).rows[0].id
    await c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 0, 't', 'ok')`, [m])
    await c.query(`INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id) VALUES ($1, 'sp', 'c')`, [s])
    await c.query(`INSERT INTO chat_compactions (session_id, upto_message_id, content) VALUES ($1, $2, 'x')`, [s, m])
    await c.query(
      `INSERT INTO chat_message_embeddings (message_id, session_id, embedding) VALUES ($1, $2, $3::vector)`,
      [m, s, `[${Array.from({ length: 1024 }, () => 0.1).join(',')}]`]
    )
    await c.query(`INSERT INTO chat_decks (session_id, user_email, title, slides) VALUES ($1, $2, 'd', '[]')`, [s, A])
    await c.query(`INSERT INTO chat_spreadsheets (session_id, user_email, title, spec) VALUES ($1, $2, 'p', '{}')`, [s, A])
    await c.query(`INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, 'd', 'x')`, [s, A])
    await c.query(
      `INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type) VALUES ($1, $2, 'p', 'm', '/v', 'image/png')`,
      [s, A]
    )
    await c.query(`INSERT INTO usage_ledger (user_email, session_id, kind, model, cost_usd) VALUES ($1, $2, 'chat', 'm', 1)`, [A, s])
    await c.query(`INSERT INTO user_mcp_connections (user_email, connection_name) VALUES ($1, 'c')`, [A])
    const t = (await c.query(`INSERT INTO deck_templates (user_email, name) VALUES ($1, 'mine') RETURNING id`, [A])).rows[0].id
    await c.query(`INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)`, [A, t])
    await c.query(`INSERT INTO user_image_model_selection (user_email, model_id) VALUES ($1, 'img')`, [A])
    const g = (await c.query(`INSERT INTO deck_templates (user_email, name, scope) VALUES ($1, 'org', 'global') RETURNING id`, [A])).rows[0].id
    await c.query(`INSERT INTO skills (scope, owner_email, name, title, description, body) VALUES ('user', $1, 'mine', 't', 'd', 'b')`, [A])
    await c.query(`INSERT INTO skills (scope, owner_email, name, title, description, body) VALUES ('global', NULL, 'org', 't', 'd', 'b')`)
    await c.query(`INSERT INTO app_admins (principal, added_by) VALUES ('boss@test.invalid', 'seed') ON CONFLICT DO NOTHING`)
    await c.query(`INSERT INTO app_tool_policy (tool_key, enabled) VALUES ('web', true)`)
    await c.query(`INSERT INTO app_mcp_catalog (service_name) VALUES ('svc')`)
    await c.query(`INSERT INTO model_catalog_overrides (endpoint_id, enabled) VALUES ('m', true)`)
    return { s, m, t, g }
  })
}

// ---- static guards ------------------------------------------------------------

test('the RLS table lists cover every app table except schema_migrations, and 0003 names each one', async () => {
  const rls = await import('./db/rls.js')
  assert.equal(rls.RLS_PER_USER_TABLES.length, 14)
  assert.deepEqual(
    [...rls.RLS_DIRECT_TABLES].sort(),
    [
      'chat_decks',
      'chat_documents',
      'chat_images',
      'chat_sessions',
      'chat_spreadsheets',
      'usage_ledger',
      'user_image_model_selection',
      'user_mcp_connections',
      'user_template_selection',
    ]
  )
  assert.deepEqual([...rls.RLS_SESSION_TABLES].sort(), ['chat_compactions', 'chat_genie_conversations', 'chat_message_embeddings', 'chat_messages'])
  assert.deepEqual([...rls.RLS_MESSAGE_TABLES], ['chat_tool_calls'])
  assert.deepEqual([...rls.RLS_MIXED_TABLES].sort(), ['deck_templates', 'skills'])
  assert.deepEqual([...rls.RLS_GLOBAL_ADMIN_TABLES].sort(), ['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'model_catalog_overrides'])
  assert.deepEqual([...rls.RLS_0007_TABLES].sort(), ['admin_audit', 'app_settings'])
  assert.deepEqual([...rls.RLS_0005_TABLES].sort(), ['project_files', 'project_members', 'projects'])
  assert.deepEqual([...rls.RLS_NOT_FORCED_TABLES], ['project_members'])
  assert.deepEqual([...rls.RLS_0006_TABLES], ['user_memories', 'user_memory_state'])
  const later = [...rls.RLS_0007_TABLES, ...rls.RLS_0005_TABLES, ...rls.RLS_0006_TABLES]
  assert.deepEqual(
    rls.RLS_TABLES.filter((t) => !later.includes(t)).sort(),
    APP_TABLES.filter((t) => t !== 'schema_migrations').sort(),
    'a table missing here would stay without policies'
  )
  const up = fs.readFileSync(path.join(MIGRATIONS, '0003_rls.up.sql'), 'utf8')
  const down = fs.readFileSync(path.join(MIGRATIONS, '0003_rls.down.sql'), 'utf8')
  const up7 = fs.readFileSync(path.join(MIGRATIONS, '0007_settings_audit.up.sql'), 'utf8')
  for (const t of rls.RLS_0007_TABLES) {
    assert.ok(up7.includes(`ai_prism.${t}`), `0007 up creates ${t}`)
    assert.ok(new RegExp(`${t} FORCE ROW LEVEL SECURITY`).test(up7), `0007 up forces RLS on ${t}`)
  }
  const up5 = fs.readFileSync(path.join(MIGRATIONS, '0005_projects.up.sql'), 'utf8')
  for (const t of rls.RLS_0005_TABLES) {
    assert.ok(up5.includes(`ai_prism.${t}`), `0005 up creates ${t}`)
    const forced = new RegExp(`${t} FORCE ROW LEVEL SECURITY`).test(up5)
    assert.equal(forced, !rls.RLS_NOT_FORCED_TABLES.includes(t), `0005 up: FORCE on ${t} unless listed as not forced`)
  }
  const up6 = fs.readFileSync(path.join(MIGRATIONS, '0006_user_memories.up.sql'), 'utf8')
  for (const t of rls.RLS_0006_TABLES) {
    assert.ok(up6.includes(`ai_prism.${t}`), `0006 up creates ${t}`)
    assert.ok(new RegExp(`${t} FORCE ROW LEVEL SECURITY`).test(up6), `0006 up forces RLS on ${t}`)
  }
  for (const t of rls.RLS_TABLES.filter((x) => !later.includes(x))) {
    assert.ok(up.includes(`'${t}'`), `0003 up names ${t}`)
    assert.ok(down.includes(`'${t}'`), `0003 down names ${t}`)
  }
})

// Every query path goes through withTx (identity + admin flag per transaction).
// withClient( may only be called inside server/db/pool.js.
test('lint: no withClient( call outside server/db/pool.js (every query runs inside withTx)', () => {
  const offenders = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      if (e.isDirectory()) walk(child)
      else if (/\.(m?js|cjs)$/.test(e.name) && !/\.test\.m?js$/.test(e.name) && child !== 'server/db/pool.js') {
        const text = fs.readFileSync(path.join(REPO, child), 'utf8')
        text.split('\n').forEach((line, i) => {
          if (/\bwithClient\(/.test(line)) offenders.push(`${child}:${i + 1}`)
        })
      }
    }
  }
  walk('server')
  walk('scripts')
  assert.deepEqual(offenders, [])
})

test('AC-R1: an RLS policy violation is classified "policy": no demotion, no grants run, the error surfaces', async () => {
  const { spErrorAction, createWithClient } = await import('./db/pool.js')
  const violation = Object.assign(new Error('new row violates row-level security policy for table "chat_sessions"'), { code: '42501' })
  assert.equal(spErrorAction(violation), 'policy')
  // a privilege error is still a grants problem
  assert.equal(spErrorAction(Object.assign(new Error('permission denied for table chat_sessions'), { code: '42501' })), 'grants')

  const grants = []
  const userCalls = []
  const warns = []
  const withClient = createWithClient({
    env: { DATABRICKS_CLIENT_ID: 'sp', DATABRICKS_CLIENT_SECRET: 'x' },
    log: { warn: (...a) => warns.push(a.join(' ')), log: () => {} },
    getSpPool: async () => ({ connect: async () => ({ release: () => {} }) }),
    userPath: async (email, token, fn) => {
      userCalls.push(email)
      return fn({})
    },
    requestGrants: (r) => grants.push(r),
  })
  await assert.rejects(
    withClient('a@test.invalid', 'tok', async () => {
      throw violation
    }),
    (e) => e === violation
  )
  assert.deepEqual(userCalls, [], 'no demotion to the caller identity')
  assert.deepEqual(grants, [], 'no grants run for a policy violation')
  // the next request still uses the SP
  assert.equal(await withClient('a@test.invalid', 'tok', async () => 'sp'), 'sp')
  assert.deepEqual(userCalls, [])
})

test('the admin flag only turns on for a real boolean true (never a header string)', async () => {
  const { txIdentity } = await import('./db/pool.js')
  assert.deepEqual(txIdentity('a@test.invalid'), ['a@test.invalid', 'off'])
  assert.deepEqual(txIdentity('a@test.invalid', { admin: true }), ['a@test.invalid', 'on'])
  for (const poisoned of ['true', 'on', 1, 'yes', {}, []]) {
    assert.deepEqual(txIdentity('a@test.invalid', { admin: poisoned }), ['a@test.invalid', 'off'], JSON.stringify(poisoned))
  }
  assert.deepEqual(txIdentity(undefined), ['', 'off'], 'no identity → empty, which matches no row')
})

test('the per-process cross-user usage backfill is gone from the request path', async () => {
  const usage = await import('./usage.ts')
  const db = await import('./db.js')
  assert.equal(usage.startUsageBackfill, undefined)
  assert.equal(db.backfillUsageLedger, undefined)
  assert.equal(db.getUsageStats, undefined, 'the unused cross-user stats query is gone')
  const src = fs.readFileSync(path.join(HERE, 'middleware', 'ensureReady.ts'), 'utf8')
  assert.ok(!/backfill/i.test(src), 'ensureReady no longer starts a backfill')
})

// ---- database ----------------------------------------------------------------

test('a fresh deployment: 0003 is applied, every app table has ENABLE + FORCE RLS, the SP has no bypass and owns nothing', { skip: SKIP }, async () => {
  const { sp, owner, db, up } = await deployment()
  assert.deepEqual(up.applied, loadMigrations(MIGRATIONS).map((m) => m.version))
  const { RLS_TABLES, RLS_NOT_FORCED_TABLES } = await import('./db/rls.js')
  await as(db, sp, async (c) => {
    const r = await c.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace AND c.relkind = 'r'`
    )
    const by = Object.fromEntries(r.rows.map((x) => [x.relname, x]))
    let policyTotal = 0
    for (const t of RLS_TABLES) {
      assert.equal(by[t]?.relrowsecurity, true, `${t}: ENABLE ROW LEVEL SECURITY`)
      assert.equal(by[t]?.relforcerowsecurity, !RLS_NOT_FORCED_TABLES.includes(t), `${t}: FORCE ROW LEVEL SECURITY (unless not forced)`)
      assert.ok(by[t].policies >= 1, `${t}: has policies`)
      policyTotal += by[t].policies
      assert.equal(by[t].owner, owner, `${t}: owned by the owner role`)
    }
    // 0003: 14 per-user (1 each) + 2 mixed (4 each) + 4 global admin (4 each) = 38;
    // 0007: app_settings 6, admin_audit 3, the sweep's aipr_* on chat_sessions 2 and
    // one read each on chat_images, chat_messages, chat_decks, chat_spreadsheets,
    // chat_documents = 16; 0005: projects 4, project_members 4, project_files 3,
    // chat_sessions 3 (gate + member read/update), the 4 session tables 3 each,
    // chat_tool_calls 2, member inserts on usage_ledger + the 4 artifact tables 5
    // = 33; 0006: user_memories 1, user_memory_state 1; 0010: usage_ledger aipa_admin_read 1;
    // 0011: one insert on admin_audit (the sweep policies of 0007 are replaced in place, not added);
    // 0012: aipj_member_read on chat_decks, chat_spreadsheets, chat_documents and chat_images = 4;
    // 0013: chat_tool_calls aipd_diag_read + aipd_diag_guard 2 (the diagnostic role's read and its restrictive guard).
    // A dropped or duplicated policy changes this
    assert.equal(policyTotal, 14 + 2 * 4 + 4 * 4 + 16 + 33 + 2 + 1 + 1 + 4 + 2, 'exactly 97 policies')
    assert.equal(
      (await c.query(`SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class k ON k.oid = p.polrelid WHERE k.relnamespace = 'ai_prism'::regnamespace`)).rows[0].n,
      97,
      'and none on any other ai_prism table'
    )
    // the membership function reads project_members (not FORCE) as its owner: it
    // must be the table owner, never the app role
    const fns = await c.query(
      `SELECT proname, prosecdef, pg_get_userbyid(proowner) AS owner FROM pg_proc
        WHERE pronamespace = 'ai_prism'::regnamespace AND proname IN ('aip_project_rank', 'aipj_project_owner_row') ORDER BY proname`
    )
    assert.deepEqual(fns.rows, [
      { proname: 'aip_project_rank', prosecdef: true, owner },
      { proname: 'aipj_project_owner_row', prosecdef: true, owner },
    ])
    assert.equal(by.project_members.owner, owner)
    assert.equal(by.schema_migrations.relrowsecurity, false, 'schema_migrations has no RLS (no user data)')
    const me = (await c.query(`SELECT current_user AS me, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]
    assert.equal(me.me, sp)
    assert.equal(me.rolbypassrls, false, 'the app role has no BYPASSRLS')
    assert.equal(me.rolsuper, false)
    assert.notEqual(by.chat_sessions.owner, me.me, 'owner ≠ current_user')
    assert.equal((await c.query(`SELECT pg_has_role(current_user, $1, 'USAGE') AS m`, [owner])).rows[0].m, false)
    await assert.rejects(c.query(`ALTER TABLE chat_sessions NO FORCE ROW LEVEL SECURITY`), /must be owner/)
    await assert.rejects(c.query(`ALTER TABLE chat_sessions DISABLE ROW LEVEL SECURITY`), /must be owner/)
  })
})

test('as the app role: no identity → 0 rows; another user → 0 rows in every per-user table; the owner sees hers', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  await seedA(db)
  const { RLS_PER_USER_TABLES } = await import('./db/rls.js')
  const count = async (email, t) => asApp(db, sp, email, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)
  for (const t of RLS_PER_USER_TABLES) {
    assert.equal(await count(null, t), 0, `${t}: no identity sees nothing`)
    assert.equal(await count(B, t), 0, `${t}: B sees none of A's rows`)
    assert.ok((await count(A, t)) >= 1, `${t}: A sees her own rows`)
  }
  // outside a transaction (no SET LOCAL), the app role sees nothing either
  await as(db, sp, async (c) => {
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n, 0)
  })
})

test('WITH CHECK: the app role cannot write a row for another user, nor into her session', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  const { s, m } = await seedA(db)
  const rejectsRls = (fn) => assert.rejects(asApp(db, sp, B, fn), isRlsViolation)
  await rejectsRls((c) => c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm')`, [A]))
  await rejectsRls((c) => c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'x')`, [s]))
  await rejectsRls((c) => c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 9, 't', 'ok')`, [m]))
  await rejectsRls((c) => c.query(`INSERT INTO usage_ledger (user_email, kind) VALUES ($1, 'chat')`, [A]))
  await rejectsRls((c) => c.query(`INSERT INTO chat_decks (session_id, user_email, title, slides) VALUES ($1, $2, 'd', '[]')`, [s, B]))
  // B cannot move her own session to A either
  await asApp(db, sp, B, async (c) => {
    const mine = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [B])).rows[0].id
    // refused by the session guard of 0005 (user_email never changes), before RLS
    await assert.rejects(c.query(`UPDATE chat_sessions SET user_email = $1 WHERE id = $2`, [A, mine]), /user_email cannot change/)
  })
  // UPDATE / DELETE of A's rows match nothing
  await asApp(db, sp, B, async (c) => {
    assert.equal((await c.query(`UPDATE chat_sessions SET title = 'x' WHERE id = $1`, [s])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM chat_messages WHERE id = $1`, [m])).rowCount, 0)
  })
})

test('global admin tables: everyone reads; writes only with app.is_admin = on', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  await seedA(db)
  for (const t of ['app_admins', 'app_tool_policy', 'app_mcp_catalog', 'model_catalog_overrides']) {
    const n = await asApp(db, sp, B, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)
    assert.ok(n >= 1, `${t}: readable by a non-admin`)
  }
  await assert.rejects(
    asApp(db, sp, B, (c) => c.query(`INSERT INTO app_admins (principal, added_by) VALUES ($1, $1)`, [B])),
    isRlsViolation,
    'a non-admin cannot make herself admin'
  )
  await asApp(db, sp, B, async (c) => {
    assert.equal((await c.query(`UPDATE app_tool_policy SET enabled = false`)).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM app_mcp_catalog`)).rowCount, 0)
    assert.equal((await c.query(`UPDATE model_catalog_overrides SET enabled = false`)).rowCount, 0)
  })
  await asApp(
    db,
    sp,
    'boss@test.invalid',
    async (c) => {
      await c.query(`INSERT INTO app_admins (principal, added_by) VALUES ('new@test.invalid', 'boss')`)
      assert.equal((await c.query(`UPDATE app_tool_policy SET enabled = false`)).rowCount, 1)
      await c.query(
        `INSERT INTO app_mcp_catalog (service_name) VALUES ('svc') ON CONFLICT (service_name) DO UPDATE SET hidden = true`
      )
    },
    { admin: true }
  )
})

test('mixed tables: read own or global; write own (scope user) or global with the admin flag', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  const { t, g } = await seedA(db)
  await asApp(db, sp, B, async (c) => {
    const tpl = (await c.query(`SELECT id, name FROM deck_templates ORDER BY id`)).rows
    assert.deepEqual(tpl.map((x) => x.name), ['org'], 'B sees the global template, not A’s own')
    assert.deepEqual((await c.query(`SELECT name FROM skills`)).rows.map((x) => x.name), ['org'])
    assert.equal((await c.query(`UPDATE deck_templates SET name = 'x' WHERE id = $1`, [g])).rowCount, 0)
    assert.equal((await c.query(`UPDATE skills SET body = 'x' WHERE scope = 'global'`)).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM deck_templates WHERE id = $1`, [t])).rowCount, 0)
    // B can select the global template for herself (own selection row)
    await c.query(`INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)`, [B, g])
  })
  await assert.rejects(
    asApp(db, sp, B, (c) => c.query(`INSERT INTO deck_templates (user_email, name, scope) VALUES ($1, 'x', 'global')`, [B])),
    isRlsViolation,
    'a non-admin cannot publish a global template'
  )
  await assert.rejects(
    asApp(db, sp, B, (c) => c.query(`INSERT INTO skills (scope, owner_email, name, title, description, body) VALUES ('global', NULL, 'b', 't', 'd', 'b')`)),
    isRlsViolation
  )
  await asApp(
    db,
    sp,
    B,
    async (c) => {
      assert.equal((await c.query(`UPDATE deck_templates SET name = 'edited' WHERE id = $1`, [g])).rowCount, 1)
      // demoting a global template hands it to the acting admin
      assert.equal(
        (await c.query(`UPDATE deck_templates SET scope = 'user', user_email = $1 WHERE id = $2`, [B, g])).rowCount,
        1
      )
      // the admin flag gives no access to another user's OWN rows
      assert.equal((await c.query(`UPDATE deck_templates SET name = 'x' WHERE id = $1`, [t])).rowCount, 0)
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n, 0, 'admin sees no other user’s chats')
    },
    { admin: true }
  )
})

test('EXPLAIN: the policies keep the existing user_email / session_id indexes usable', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  const { s } = await seedA(db)
  const plan = (sql, params = []) =>
    asApp(db, sp, A, async (c) => {
      await c.query(`SET LOCAL enable_seqscan = off`)
      return (await c.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n')
    })
  const cases = [
    [`SELECT * FROM chat_sessions WHERE user_email = '${A}' ORDER BY updated_at DESC LIMIT 10`, 'idx_chat_sessions_user'],
    [`SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 10`, 'idx_chat_sessions_user'],
    [`SELECT * FROM chat_messages WHERE session_id = ${Number(s)} ORDER BY id`, 'idx_chat_messages_session'],
    // every ledger query of the app names its user (db.js); 0010's admin read policy is
    // OR'd with the owner policy, so the owner qual is a filter, not an index condition
    [`SELECT * FROM usage_ledger WHERE user_email = '${A}' AND created_at >= now() - interval '30 days'`, 'idx_usage_ledger_user_time'],
    [`SELECT * FROM chat_decks WHERE session_id = ${Number(s)}`, 'idx_chat_decks_session'],
  ]
  for (const [sql, index] of cases) {
    const p = await plan(sql)
    assert.ok(p.includes(index), `${sql}\nexpected ${index}:\n${p}`)
    assert.ok(!/Seq Scan on chat_sessions|Seq Scan on chat_messages|Seq Scan on usage_ledger/.test(p), `no seq scan:\n${p}`)
  }
})

test('AC-R2: 0003 round trip with 0002 present (down --to 2 → no RLS, data kept; up again), and its body is idempotent', { skip: SKIP }, async () => {
  const { dep, sp, owner, db } = await deployment()
  await seedA(db)
  const rlsState = (c) =>
    c.query(
      `SELECT count(*) FILTER (WHERE c.relrowsecurity)::int AS enabled, count(*) FILTER (WHERE c.relforcerowsecurity)::int AS forced,
              (SELECT count(*)::int FROM pg_policy p JOIN pg_class k ON k.oid = p.polrelid WHERE k.relnamespace = 'ai_prism'::regnamespace) AS policies
         FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace AND c.relkind = 'r'`
    )
  let before
  await as(db, dep, async (c) => {
    before = (await rlsState(c)).rows[0]
    const { RLS_TABLES, RLS_NOT_FORCED_TABLES } = await import('./db/rls.js')
    const after2 = loadMigrations(MIGRATIONS).map((m) => m.version).filter((v) => v > 2)
    assert.equal(before.enabled, RLS_TABLES.length)
    assert.equal(before.forced, RLS_TABLES.length - RLS_NOT_FORCED_TABLES.length)
    const d = await migrateDown(c, { to: 2, log: quietLog(), ownerRole: owner })
    assert.deepEqual(d.reverted, [...after2].reverse())
    assert.deepEqual((await rlsState(c)).rows[0], { enabled: 0, forced: 0, policies: 0 })
    assert.equal(
      (await c.query(`SELECT to_regnamespace('ai_prism') IS NOT NULL AS ok`)).rows[0].ok,
      true,
      'down --to 2 leaves the ai_prism schema (0002) in place'
    )
    const u = await migrateUp(c, { log: quietLog(), ownerRole: owner })
    assert.deepEqual(u.applied, after2)
    assert.deepEqual((await rlsState(c)).rows[0], before)
  })
  // the body itself is idempotent: running it again (as the owner role) changes nothing
  const up = fs.readFileSync(path.join(MIGRATIONS, '0003_rls.up.sql'), 'utf8')
  await as(db, SUPERUSER, async (c) => {
    await c.query('BEGIN')
    await c.query(`SET LOCAL ROLE ${owner}`)
    await c.query(up)
    await c.query(up)
    await c.query('COMMIT')
    assert.deepEqual((await rlsState(c)).rows[0], before)
    const down = fs.readFileSync(path.join(MIGRATIONS, '0003_rls.down.sql'), 'utf8')
    await c.query('BEGIN')
    await c.query(`SET LOCAL ROLE ${owner}`)
    await c.query(down)
    await c.query(down)
    await c.query('ROLLBACK')
  })
  // the app role still works after the round trip (grants kept)
  const n = await asApp(db, sp, A, async (c) => (await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n)
  assert.equal(n, 1)
})

test('withTx sets app.user_email / app.is_admin per transaction; nothing survives on the pooled connection', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  await seedA(db)
  const { runInIdentityTx } = await import('./db/pool.js')
  await as(db, sp, async (c) => {
    const inside = await runInIdentityTx(c, A, {}, async (cc) => {
      const r = await cc.query(
        `SELECT current_setting('app.user_email', true) AS e, current_setting('app.is_admin', true) AS a,
                (SELECT count(*)::int FROM chat_sessions) AS n`
      )
      return r.rows[0]
    })
    assert.deepEqual(inside, { e: A, a: 'off', n: 1 })
    const admin = await runInIdentityTx(c, B, { admin: true }, async (cc) =>
      (await cc.query(`SELECT current_setting('app.is_admin', true) AS a`)).rows[0].a
    )
    assert.equal(admin, 'on')
    // after COMMIT the same connection carries no identity
    const left = (await c.query(`SELECT coalesce(current_setting('app.user_email', true), '') AS e, coalesce(current_setting('app.is_admin', true), '') AS a`)).rows[0]
    assert.deepEqual(left, { e: '', a: '' })
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n, 0)
    // a throwing fn rolls back, and the identity goes with it
    await assert.rejects(
      runInIdentityTx(c, A, {}, async (cc) => {
        await cc.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'rolled back', 'm')`, [A])
        throw new Error('boom')
      }),
      /boom/
    )
    assert.equal((await c.query(`SELECT coalesce(current_setting('app.user_email', true), '') AS e`)).rows[0].e, '')
  })
  const n = await as(db, SUPERUSER, async (c) => (await c.query(`SELECT count(*)::int AS n FROM chat_sessions WHERE title = 'rolled back'`)).rows[0].n)
  assert.equal(n, 0)
})

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

test('migrate.mjs backfill-usage: the one-time ledger reconstruction runs as the owner under FORCE RLS, once', { skip: SKIP }, async () => {
  const { dep, owner, db } = await deployment()
  await as(db, SUPERUSER, async (c) => {
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [A])).rows[0].id
    const s2 = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [B])).rows[0].id
    for (const sid of [s, s2]) {
      await c.query(
        `INSERT INTO chat_messages (session_id, role, content, model, prompt_tokens, completion_tokens, created_at)
         VALUES ($1, 'assistant', 'x', 'unknown-model', 100, 50, now() - interval '1 day')`,
        [sid]
      )
    }
  })
  const own = { AI_PRISM_OWNER_ROLE: owner }
  let r = cli(['backfill-usage'], db, dep, own)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /2 /)
  r = cli(['backfill-usage'], db, dep, own)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already|0 /)
  await as(db, SUPERUSER, async (c) => {
    const rows = (await c.query(`SELECT user_email FROM usage_ledger WHERE source = 'backfill' ORDER BY user_email`)).rows
    assert.deepEqual(rows.map((x) => x.user_email), [A, B])
    const f = await c.query(
      `SELECT relname, relforcerowsecurity FROM pg_class WHERE relnamespace = 'ai_prism'::regnamespace
        AND relname IN ('usage_ledger', 'chat_messages', 'chat_sessions')`
    )
    for (const x of f.rows) assert.equal(x.relforcerowsecurity, true, `${x.relname}: FORCE is back on`)
  })
})

// QA round 1 (PR #81, blocker 1): an empty owner column must not match an empty
// identity. user_email is NOT NULL but may be '' (0001_baseline), and withTx maps
// a missing email to ''. Covers a direct table (QA's repro), the session- and
// message-indirect tables and a mixed table.
test('no identity cannot write or read rows whose owner email is empty', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  // QA's repro: write and read back under no identity, in one transaction (a
  // refused write is rolled back to a savepoint so the read-back still runs)
  const n = await asApp(db, sp, null, async (c) => {
    await c.query('SAVEPOINT qa')
    try {
      await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('', 'qa-empty-owner', 'm')`)
      await c.query('RELEASE SAVEPOINT qa')
    } catch {
      await c.query('ROLLBACK TO SAVEPOINT qa')
    }
    return (await c.query(`SELECT count(*)::int AS n FROM chat_sessions WHERE title = 'qa-empty-owner'`)).rows[0].n
  })
  assert.equal(n, 0, 'an empty identity must match no rows')
  for (const email of [null, '']) {
    await assert.rejects(
      asApp(db, sp, email, (c) => c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('', 't', 'm')`)),
      isRlsViolation,
      `the write itself is refused (identity ${JSON.stringify(email)})`
    )
  }
  // rows with an empty owner that already exist (written by the superuser)
  const seeded = await as(db, SUPERUSER, async (c) => {
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('', 'empty-owner', 'm') RETURNING id`)).rows[0].id
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'x') RETURNING id`, [s])).rows[0].id
    await c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 0, 't', 'ok')`, [m])
    await c.query(`INSERT INTO skills (scope, owner_email, name, title, description, body) VALUES ('user', '', 'empty', 't', 'd', 'b')`)
    await c.query(`INSERT INTO deck_templates (user_email, name) VALUES ('', 'empty')`)
    return { s, m }
  })
  for (const email of [null, '']) {
    const seen = await asApp(db, sp, email, async (c) => {
      const out = {}
      for (const t of ['chat_sessions', 'chat_messages', 'chat_tool_calls', 'skills', 'deck_templates']) {
        out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n
      }
      out.updated = (await c.query(`UPDATE chat_sessions SET title = 'x' WHERE id = $1`, [seeded.s])).rowCount
      return out
    })
    assert.deepEqual(
      seen,
      { chat_sessions: 0, chat_messages: 0, chat_tool_calls: 0, skills: 0, deck_templates: 0, updated: 0 },
      `identity ${JSON.stringify(email)} sees and changes nothing`
    )
    await assert.rejects(
      asApp(db, sp, email, (c) => c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'y')`, [seeded.s])),
      isRlsViolation,
      'nor writes into an empty-owner session'
    )
  }
})

// AC-R1 end to end (QA round 1 suggestion): a REAL policy violation raised by
// Postgres, through the SP wrapper (createWithClient) and the identity
// transaction, surfaces as-is: no demotion to the caller identity, no grants run.
test('AC-R1 end to end: a real RLS violation through the SP wrapper is rethrown, no demotion, no grants run', { skip: SKIP }, async () => {
  const { sp, db } = await deployment()
  const { createWithClient, runInIdentityTx, spErrorAction } = await import('./db/pool.js')
  const pool = new pg.Pool({ ...opts(db, sp), max: 1 })
  pool.on('connect', (c) => c.query(`SET search_path TO ai_prism, public`))
  const userCalls = []
  const grants = []
  const withClient = createWithClient({
    env: { DATABRICKS_CLIENT_ID: 'sp', DATABRICKS_CLIENT_SECRET: 'x' },
    log: { warn() {}, log() {} },
    getSpPool: async () => pool,
    userPath: async (email, token, fn) => {
      userCalls.push(email)
      return fn({ query: async () => ({ rows: [], rowCount: 0 }) })
    },
    requestGrants: (r) => grants.push(r),
  })
  const tx = (email, fn) => withClient(email, 'tok', (c) => runInIdentityTx(c, email, {}, fn))
  try {
    let raised
    await assert.rejects(
      tx(B, (c) => c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm')`, [A])),
      (e) => {
        raised = e
        return isRlsViolation(e)
      }
    )
    assert.equal(raised.code, '42501')
    assert.equal(spErrorAction(raised), 'policy')
    assert.deepEqual(userCalls, [], 'no demotion to the caller identity')
    assert.deepEqual(grants, [], 'no grants run')
    // the transaction rolled back and the SP keeps serving the next request
    const n = await tx(B, async (c) => (await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n)
    assert.equal(n, 0)
    assert.deepEqual(userCalls, [])
    const leaked = await as(db, SUPERUSER, async (c) => (await c.query(`SELECT count(*)::int AS n FROM chat_sessions WHERE user_email = $1`, [A])).rows[0].n)
    assert.equal(leaked, 0, 'nothing was written for A')
  } finally {
    await pool.end().catch(() => {})
  }
})

// ---- F1: the read-only diagnostic role (migration 0013) ----------------------------------
//
// Shape (arch-f1.md): the role has NO usage on ai_prism; it reads a security_invoker view in its own
// schema (ai_prism_diag.chat_tool_calls); aipd_diag_read is literally USING (true) and a RESTRICTIVE
// aipd_diag_guard on session_user keeps the app SP, the owner role's members and superusers at 0 rows
// whatever the role graph is; a pg_shdepend allow-list proves the role holds nothing else.

const DIAG_COLUMNS = ['created_at', 'duration_ms', 'status', 'tool_name']
const DIAG_ENV = (diag, extra = {}) => ({ AI_PRISM_DIAG_ROLE: diag, LOCAL_DEV_MODE: '1', ...extra })
const VIEW = 'ai_prism_diag.chat_tool_calls'

// Rows in chat_tool_calls of A (personal chat), B (personal chat) and a project chat.
async function seedToolCalls(db) {
  return as(db, SUPERUSER, async (c) => {
    const ids = []
    for (const [email, project] of [[A, null], [B, null], [A, 'project']]) {
      let pid = null
      if (project) pid = (await c.query(`INSERT INTO projects (name, created_by) VALUES ('P', $1) RETURNING id`, [email])).rows[0].id
      const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 't', 'm', $2) RETURNING id`, [email, pid])).rows[0].id
      const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'segredo') RETURNING id`, [s])).rows[0].id
      await c.query(
        `INSERT INTO chat_tool_calls (message_id, seq, tool_name, arguments, result, status, duration_ms)
         VALUES ($1, 0, $2, '{"q":"segredo"}', 'segredo', 'ok', 120)`,
        [m, `tool_${ids.length}`]
      )
      ids.push(m)
    }
    return ids
  })
}

const mkRole = async (kind, extra = 'NOLOGIN') => {
  const n = `w21_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${n} ${extra}`)
  createdRoles.push(n)
  return n
}

// A deployment plus an operator (a plain login role) that was granted the diagnostic role through diag-grant.
async function diagDeployment(opts) {
  const d = await deployment(opts)
  const operator = await role('operator')
  const r = cli(['diag-grant', '--role', operator], d.db, SUPERUSER, DIAG_ENV(d.diag, { AI_PRISM_OWNER_ROLE: d.owner, DATABRICKS_CLIENT_ID: d.sp }))
  assert.equal(r.code, 0, r.out)
  return { ...d, operator }
}

// One transaction as `user`, after SET ROLE <diag> (a session of that login role, then the diagnostic role).
async function asDiagAs(db, user, diag, fn) {
  return as(db, user, async (c) => {
    await c.query('BEGIN')
    try {
      await c.query(`SET ROLE ${diag}`)
      return await fn(c)
    } finally {
      await c.query('ROLLBACK').catch(() => {})
    }
  })
}

const rejects42501 = async (c, sql, code = '42501') => {
  await c.query('SAVEPOINT s')
  await assert.rejects(c.query(sql), (e) => e.code === code, sql)
  await c.query('ROLLBACK TO s')
}

// What a rollback must restore: function / relation / column / schema ACLs of ai_prism, its policies
// (the aipd_ ones included only when asked) and every shared dependency of the diagnostic role.
async function snapshot(db, diag, { withDiagPolicies = true } = {}) {
  return as(db, SUPERUSER, async (c) => {
    const q = async (sql, params = []) => JSON.stringify((await c.query(sql, params)).rows)
    return {
      fn: await q(`SELECT p.oid::regprocedure::text AS f, p.proacl::text AS a FROM pg_proc p WHERE p.pronamespace = 'ai_prism'::regnamespace ORDER BY 1`),
      rel: await q(`SELECT c.relname, c.relacl::text AS a FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace ORDER BY 1`),
      col: await q(`SELECT c.relname, a.attname, a.attacl::text AS a FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'ai_prism'::regnamespace AND a.attacl IS NOT NULL ORDER BY 1, 2`),
      nsp: await q(`SELECT nspname, nspacl::text AS a FROM pg_namespace WHERE nspname IN ('ai_prism', 'ai_prism_diag') ORDER BY 1`),
      pol: await q(
        `SELECT c.relname, p.polname, p.polcmd, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS q
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
          WHERE c.relnamespace = 'ai_prism'::regnamespace AND ($1 OR p.polname NOT LIKE 'aipd\\_%') ORDER BY 1, 2`,
        [withDiagPolicies]
      ),
      dep: await q(
        `SELECT d.classid::regclass::text AS cls, d.objsubid, d.deptype, pg_describe_object(d.classid, d.objid, d.objsubid) AS what
           FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = $1)
            AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())) ORDER BY 1, 2, 3, 4`,
        [diag]
      ),
    }
  })
}

const upSql = () => fs.readFileSync(path.join(MIGRATIONS, '0013_diag_role.up.sql'), 'utf8')

test('F1: 0013 files exist; grants.js (the app role grants) never mentions the diagnostic role', () => {
  for (const f of ['0013_diag_role.up.sql', '0013_diag_role.down.sql']) assert.ok(fs.existsSync(path.join(MIGRATIONS, f)), f)
  const up = upSql()
  assert.match(up, /ai_prism_diag/)
  assert.match(up, /NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT/)
  assert.ok(!/diag/i.test(fs.readFileSync(path.join(HERE, 'db', 'grants.js'), 'utf8')))
})

// Requirement 9 (pins) + role attributes
test('F1 (9): the role is plain; the two policies, the view and the membership edge have exactly the pinned shape', { skip: SKIP }, async () => {
  const { sp, owner, db, diag, operator } = await diagDeployment()
  await as(db, SUPERUSER, async (c) => {
    const r = (await c.query(`SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1`, [diag])).rows[0]
    assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false })
    const pol = (await c.query(
      `SELECT p.polname, p.polcmd, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS q,
              (SELECT array_agg(r.rolname::text) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) AS roles
         FROM pg_policy p WHERE p.polrelid = 'ai_prism.chat_tool_calls'::regclass AND p.polname LIKE 'aipd\_%' ORDER BY 1`
    )).rows
    assert.equal(pol.length, 2)
    assert.deepEqual(pol[0], { polname: 'aipd_diag_guard', polcmd: 'r', polpermissive: false, q: pol[0].q, roles: [diag] })
    assert.match(pol[0].q, /session_user/)
    assert.deepEqual(pol[1], { polname: 'aipd_diag_read', polcmd: 'r', polpermissive: true, q: 'true', roles: [diag] })
    const v = (await c.query(`SELECT c.relkind, c.reloptions, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = $1::regclass`, [VIEW])).rows[0]
    assert.equal(v.relkind, 'v')
    assert.ok(v.reloptions.includes('security_invoker=true'), String(v.reloptions))
    assert.equal(v.owner, owner)
    const cols = (await c.query(`SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY 1`, [VIEW])).rows
    assert.deepEqual(cols.map((x) => x.attname), DIAG_COLUMNS)
    const bcols = await c.query(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = $1 AND table_schema = 'ai_prism' AND table_name = 'chat_tool_calls' AND privilege_type = 'SELECT' ORDER BY 1`,
      [diag]
    )
    assert.deepEqual(bcols.rows.map((x) => x.column_name), DIAG_COLUMNS)
    const edge = (await c.query(
      `SELECT m.inherit_option, m.set_option FROM pg_auth_members m WHERE m.roleid = $1::regrole AND m.member = $2::regrole`,
      [diag, operator]
    )).rows
    assert.deepEqual(edge, [{ inherit_option: false, set_option: true }])
    // the role can name nothing in ai_prism (arch §3.1)
    assert.equal((await c.query(`SELECT has_schema_privilege($1, 'ai_prism', 'USAGE') AS x`, [diag])).rows[0].x, false)
    const acl = await c.query(`SELECT n.nspname FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = $1::regrole ORDER BY 1`, [diag])
    assert.deepEqual(acl.rows.map((x) => x.nspname), ['ai_prism_diag'], 'the only schema with an ACL entry for the role')
    assert.equal((await c.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [owner, diag])).rows[0].m, false)
    assert.equal((await c.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [sp, diag])).rows[0].m, false)
  })
})

// Requirement 4: the operator's happy path
test('F1 (4): as the operator after SET ROLE, the view returns the 4 columns of every user (project chats too); everything else is refused', { skip: SKIP }, async () => {
  const { db, diag, operator } = await diagDeployment()
  await seedToolCalls(db)
  await asDiagAs(db, operator, diag, async (c) => {
    const r = await c.query(`SELECT tool_name, status, duration_ms, created_at FROM ${VIEW} ORDER BY tool_name`)
    assert.deepEqual(r.rows.map((x) => x.tool_name), ['tool_0', 'tool_1', 'tool_2'])
    assert.equal(r.rows[0].duration_ms, 120)
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${VIEW}`)).rows[0].n, 3)
    await rejects42501(c, `SELECT arguments FROM ${VIEW}`, '42703')
    await rejects42501(c, `SELECT result FROM ${VIEW}`, '42703')
    await rejects42501(c, `SELECT * FROM ai_prism.chat_tool_calls`)
    await rejects42501(c, `SELECT tool_name FROM ai_prism.chat_tool_calls`)
    await rejects42501(c, `INSERT INTO ${VIEW} (tool_name, status) VALUES ('x', 'ok')`)
    await rejects42501(c, `UPDATE ${VIEW} SET status = 'x'`)
    await rejects42501(c, `DELETE FROM ${VIEW}`)
    const { RLS_TABLES } = await import('./db/rls.js')
    for (const t of RLS_TABLES) await rejects42501(c, `SELECT count(*) FROM ai_prism.${t}`)
  })
})

// Requirement 3: privileged sessions see nothing
test('F1 (3): the app SP, a member of the owner role and a superuser see 0 rows through the diagnostic role', { skip: SKIP }, async () => {
  const { db, diag, sp, dep, operator } = await diagDeployment()
  await seedToolCalls(db)
  // an admin hands the role to each of them by hand (diag-grant would refuse): the guard is what holds
  await admin(`GRANT ${diag} TO ${sp} WITH INHERIT FALSE, SET TRUE`)
  await admin(`GRANT ${diag} TO ${dep} WITH INHERIT FALSE, SET TRUE`)
  const count = (u) => asDiagAs(db, u, diag, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${VIEW}`)).rows[0].n)
  assert.equal(await count(operator), 3, 'control: the operator sees every row')
  assert.equal(await count(sp), 0, 'the app SP')
  assert.equal(await count(dep), 0, 'the deploying identity (a member of the owner role)')
  assert.equal(await count(SUPERUSER), 0, 'a superuser')
})

// Requirement 1: late role graph
test('F1 (1): a role graph that makes the SP a member later gives it 0 rows and leaves its own queries untouched', { skip: SKIP }, async () => {
  const { db, diag, sp, operator } = await diagDeployment()
  await seedToolCalls(db)
  const own = () => asApp(db, sp, A, async (c) => (await c.query(`SELECT tool_name FROM chat_tool_calls ORDER BY tool_name`)).rows.map((x) => x.tool_name))
  const before = await own()
  assert.ok(before.length >= 1)
  // operator -> late -> spGroup -> SP (the QA repro): SP becomes a member of the operator, which holds the role
  const late = await mkRole('late')
  const spGroup = await mkRole('spgroup')
  await admin(`GRANT ${operator} TO ${late}`)
  await admin(`GRANT ${late} TO ${spGroup}`)
  await admin(`GRANT ${spGroup} TO ${sp}`)
  assert.equal((await admin(`SELECT pg_has_role('${sp}', '${diag}', 'USAGE') AS x`)).rows[0].x, false)
  // (pg_has_role(sp, diag, 'MEMBER') may well be true: that is not the invariant)
  const n = await asDiagAs(db, sp, diag, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${VIEW}`)).rows[0].n)
  assert.equal(n, 0)
  assert.deepEqual(await own(), before, "the SP's own query is exactly what it was")
})

// Requirement 2: an admin adds an INHERIT TRUE edge
test('F1 (2): an INHERIT TRUE edge into the SP\'s graph fails closed (0 tool calls for the app), and recovers after REVOKE', { skip: SKIP }, async () => {
  const { db, diag, sp } = await diagDeployment()
  await seedToolCalls(db)
  const spGroup = await mkRole('spgroup')
  await admin(`GRANT ${spGroup} TO ${sp}`)
  const own = () => asApp(db, sp, A, async (c) => (await c.query(`SELECT tool_name FROM chat_tool_calls ORDER BY tool_name`)).rows.map((x) => x.tool_name))
  const before = await own()
  assert.ok(before.length >= 1)
  await admin(`GRANT ${diag} TO ${spGroup} WITH INHERIT TRUE`)
  assert.deepEqual(await own(), [], 'fail closed: the diagnostic policies apply to the SP through inheritance, the guard empties the table')
  await admin(`REVOKE ${diag} FROM ${spGroup}`)
  assert.deepEqual(await own(), before)
})

// Requirement 5: functions, present and future
test('F1 (5): the role names nothing in ai_prism: present and future SECURITY DEFINER functions are unreachable', { skip: SKIP }, async () => {
  const { db, diag, owner, operator } = await diagDeployment()
  await as(db, SUPERUSER, async (c) => {
    await c.query(`SET ROLE ${owner}`)
    await c.query(`CREATE FUNCTION ai_prism.f1_late() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`)
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ai_prism GRANT EXECUTE ON FUNCTIONS TO PUBLIC`)
    await c.query(`CREATE FUNCTION ai_prism.f1_late2() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`)
    await c.query(`GRANT EXECUTE ON FUNCTION ai_prism.f1_late() TO PUBLIC`)
  })
  await asDiagAs(db, operator, diag, async (c) => {
    await c.query(`SELECT set_config('app.user_email', $1, true)`, [A])
    for (const sql of [`SELECT ai_prism.aip_my_project_ids()`, `SELECT ai_prism.aip_project_rank(1)`, `SELECT ai_prism.f1_late()`, `SELECT ai_prism.f1_late2()`]) {
      await rejects42501(c, sql)
    }
  })
})

// Requirement 6: the exhaustive allow-list
test('F1 (6): a pre-existing role holding anything outside the allow-list fails closed (AIP05 names it); allow-listed objects are normalized', { skip: SKIP }, async () => {
  const shapes = [
    ['a large object', async (x) => {
      const oid = (await admin(`SELECT lo_create(0) AS oid`, x.db)).rows[0].oid
      await admin(`GRANT SELECT ON LARGE OBJECT ${oid} TO ${x.diag}`, x.db)
      return String(oid)
    }],
    ['a table in public', async (x) => {
      await admin(`CREATE TABLE public.f1_probe (a int)`, x.db)
      await admin(`GRANT SELECT ON public.f1_probe TO ${x.diag}`, x.db)
      return 'f1_probe'
    }],
    ['a type', async (x) => {
      await admin(`CREATE TYPE public.f1_type AS ENUM ('a')`, x.db)
      await admin(`GRANT USAGE ON TYPE public.f1_type TO ${x.diag}`, x.db)
      return 'f1_type'
    }],
    ['a membership', async (x) => {
      await admin(`GRANT ${await mkRole('grp')} TO ${x.diag}`)
      return ''
    }],
    ['owning an object', async (x) => {
      await admin(`CREATE TABLE public.f1_owned (a int)`, x.db)
      await admin(`ALTER TABLE public.f1_owned OWNER TO ${x.diag}`, x.db)
      return 'f1_owned'
    }],
  ]
  for (const [why, setup] of shapes) {
    const x = await deployment({ withDiag: false })
    await as(x.db, SUPERUSER, (c) => migrateDown(c, { to: 12, log: quietLog(), ownerRole: x.owner }))
    await admin(`CREATE ROLE ${x.diag} NOLOGIN`)
    const what = await setup(x)
    await as(x.db, SUPERUSER, async (c) => {
      await assert.rejects(migrateUp(c, { log: quietLog(), ownerRole: x.owner }), (e) => e.message.includes(what) && /AIP05|plain NOLOGIN|member of other|diagnostic|holds/.test(e.message + e.code), why)
    })
    const op = await role('operator')
    const r = cli(['diag-grant', '--role', op], x.db, SUPERUSER, DIAG_ENV(x.diag, { AI_PRISM_OWNER_ROLE: x.owner, DATABRICKS_CLIENT_ID: x.sp }))
    assert.equal(r.code, 1, `${why}: ${r.out}`)
    assert.equal((await admin(`SELECT pg_has_role('${op}', '${x.diag}', 'MEMBER') AS m`)).rows[0].m, false, `${why}: the operator gained nothing`)
  }
  // allow-listed objects with extra bits come out normalized; what it held inside ai_prism is revoked
  const { db, diag, sp, owner } = await diagDeployment()
  await admin(`GRANT CREATE ON SCHEMA ai_prism_diag TO ${diag}`, db)
  await admin(`GRANT SELECT ON ai_prism.app_settings TO ${diag}`, db)
  await admin(`GRANT USAGE ON SCHEMA ai_prism TO ${diag}`, db)
  await admin(`GRANT INSERT ON ${VIEW} TO ${diag}`, db)
  await as(db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('ai_prism.diag_role', $1, false), set_config('ai_prism.owner_role', $2, false), set_config('ai_prism.use_owner_role', 'off', false)`, [diag, owner])
    await c.query(upSql())
    const x = (sql) => c.query(sql, [diag]).then((r) => r.rows[0].x)
    assert.equal(await x(`SELECT has_schema_privilege($1, 'ai_prism_diag', 'CREATE') AS x`), false)
    assert.equal(await x(`SELECT has_schema_privilege($1, 'ai_prism', 'USAGE') AS x`), false)
    assert.equal(await x(`SELECT has_table_privilege($1, 'ai_prism.app_settings', 'SELECT') AS x`), false)
    assert.equal(await x(`SELECT has_table_privilege($1, 'ai_prism_diag.chat_tool_calls', 'INSERT') AS x`), false)
  })
  void sp
})

// Requirements 7 and 8: rollback restores the prior state; up is idempotent
test('F1 (7): up then down restores every ACL and policy of v12, from the default state and with PUBLIC revoked on a helper; down grants nothing', { skip: SKIP }, async () => {
  for (const revokePublic of [false, true]) {
    const { db, diag, owner, operator } = await diagDeployment()
    await as(db, SUPERUSER, (c) => migrateDown(c, { to: 12, log: quietLog(), ownerRole: owner }))
    if (revokePublic) await admin(`REVOKE EXECUTE ON FUNCTION ai_prism.aip_my_project_ids() FROM PUBLIC`, db)
    const v12 = await snapshot(db, diag)
    assert.equal(JSON.parse(v12.dep).length, 0, 'down leaves the role holding nothing in this database')
    await as(db, SUPERUSER, async (c) => {
      assert.deepEqual((await migrateUp(c, { log: quietLog(), ownerRole: owner })).applied, [13])
      assert.deepEqual((await migrateDown(c, { to: 12, log: quietLog(), ownerRole: owner })).reverted, [13])
    })
    assert.deepEqual(await snapshot(db, diag), v12, `revokePublic=${revokePublic}`)
    // after the rollback the operator reads nothing: ai_prism is closed, the view is gone
    await asDiagAs(db, operator, diag, async (c) => {
      await rejects42501(c, `SELECT count(*) FROM ai_prism.chat_tool_calls`)
      await rejects42501(c, `SELECT count(*) FROM ${VIEW}`, '3F000')
    })
  }
})

test('F1 (8): the up body is idempotent (up twice = up once)', { skip: SKIP }, async () => {
  const { db, diag, owner } = await diagDeployment()
  const once = await snapshot(db, diag)
  await as(db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('ai_prism.diag_role', $1, false), set_config('ai_prism.owner_role', $2, false), set_config('ai_prism.use_owner_role', 'off', false)`, [diag, owner])
    await c.query(upSql())
    await c.query(upSql())
  })
  assert.deepEqual(await snapshot(db, diag), once)
})

test('F1 (9): re-running 0003 / 0005 / 0007 / 0011 / 0012 leaves both aipd_ policies alone', { skip: SKIP }, async () => {
  const { owner, db, diag } = await diagDeployment()
  const before = await snapshot(db, diag)
  await as(db, SUPERUSER, async (c) => {
    for (const f of ['0003_rls.up.sql', '0005_projects.up.sql', '0007_settings_audit.up.sql', '0011_ephemeral.up.sql', '0012_project_artifact_read.up.sql']) {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE ${owner}`)
      await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      await c.query('COMMIT')
    }
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polname LIKE 'aipd\\_%'`)).rows[0].n, 2)
  })
  assert.equal((await snapshot(db, diag)).pol, before.pol)
})

test('F1: with no role and no CREATEROLE the migration applies without it (NOTICE, no view); diag-grant then creates and finishes it', { skip: SKIP }, async () => {
  const { db, diag, sp, owner } = await deployment({ withDiag: false })
  const exists = () => admin(`SELECT 1 FROM pg_roles WHERE rolname = '${diag}'`)
  assert.equal((await exists()).rowCount, 0, 'the SP could not create it at boot')
  assert.equal((await admin(`SELECT to_regclass('${VIEW}') AS v`, db)).rows[0].v, null)
  const op = await role('op')
  const e = DIAG_ENV(diag, { AI_PRISM_OWNER_ROLE: owner })
  const r = cli(['diag-grant', '--role', op], db, SUPERUSER, e)
  assert.equal(r.code, 0, r.out)
  assert.equal((await exists()).rowCount, 1)
  await asDiagAs(db, op, diag, async (c) => {
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${VIEW}`)).rows[0].n, 0)
    await rejects42501(c, `SELECT arguments FROM ${VIEW}`, '42703')
  })
  assert.equal(cli(['diag-grant', '--role', op], db, SUPERUSER, e).code, 0, 'idempotent')
  const bySp = cli(['diag-grant', '--role', sp], db, SUPERUSER, { ...e, DATABRICKS_CLIENT_ID: sp })
  assert.equal(bySp.code, 1, bySp.out)
  assert.equal(cli(['diag-grant', '--role', op], db, SUPERUSER, { ...e, DATABRICKS_CLIENT_ID: op }).code, 1)
  assert.equal(cli(['diag-grant'], db, SUPERUSER, e).code, 2)
  assert.equal((await admin(`SELECT pg_has_role('${sp}', '${diag}', 'MEMBER') AS m`)).rows[0].m, false)
})

test('F1 (QA r1-1): the role name is fixed in production; the test override cannot name the owner or an app role', { skip: SKIP }, async () => {
  const { db, dep, owner, sp, diag } = await deployment()
  const operator = await role('operator')
  const member = async (r, g) => (await admin(`SELECT pg_has_role('${r}', '${g}', 'MEMBER') AS m`)).rows[0].m
  for (const env of [DIAG_ENV(owner), { AI_PRISM_DIAG_ROLE: owner }, { AI_PRISM_DIAG_ROLE: diag }, DIAG_ENV(sp)]) {
    const r = cli(['diag-grant', '--role', operator], db, dep, { ...env, AI_PRISM_OWNER_ROLE: owner, DATABRICKS_CLIENT_ID: sp })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /fixed|ai_prism_diag/)
  }
  assert.equal(await member(operator, owner), false, 'the operator never became the owner')
  const bad = await scratchDb()
  await admin(`ALTER DATABASE ${bad} SET ai_prism.diag_role = '${owner}'`)
  await assert.rejects(as(bad, SUPERUSER, (c) => migrateUp(c, { log: quietLog() })), (e) => e.code === 'AIP05' || /not allowed/.test(e.message))
  assert.match(upSql(), /ai_prism_diag_test_\[a-z0-9\]\+/)
})

test('F1 (QA r1-2): diag-grant gives an early error for a group related to the SP / owner (courtesy: the boundary is the guard); the edge is INHERIT FALSE', { skip: SKIP }, async () => {
  const { db, sp, diag, owner } = await deployment()
  const e = DIAG_ENV(diag, { AI_PRISM_OWNER_ROLE: owner, DATABRICKS_CLIENT_ID: sp })
  const parent = await mkRole('parent')
  await admin(`GRANT ${parent} TO ${sp}`)
  const grandparent = await mkRole('grand')
  await admin(`GRANT ${grandparent} TO ${parent}`)
  const child = await mkRole('child')
  await admin(`GRANT ${sp} TO ${child}`)
  const ownerChild = await mkRole('ochild')
  await admin(`GRANT ${owner} TO ${ownerChild}`)
  for (const [label, target] of [['parent group', parent], ['grandparent group', grandparent], ['member of the SP', child], ['the SP', sp], ['the owner', owner], ['a member of the owner', ownerChild]]) {
    const r = cli(['diag-grant', '--role', target], db, SUPERUSER, e)
    assert.equal(r.code, 1, `${label}: ${r.out}`)
  }
  assert.equal((await admin(`SELECT pg_has_role('${sp}', '${diag}', 'MEMBER') AS m`)).rows[0].m, false)
  const op = await mkRole('op2')
  assert.equal(cli(['diag-grant', '--role', op], db, SUPERUSER, e).code, 0)
  const edge = (await admin(`SELECT inherit_option, set_option FROM pg_auth_members WHERE roleid = '${diag}'::regrole AND member = '${op}'::regrole`)).rows
  assert.deepEqual(edge, [{ inherit_option: false, set_option: true }])
})
