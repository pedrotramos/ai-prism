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

import { loadMigrations, migrateDown, migrateUp } from './db/migrate.ts'
import { APP_TABLES, applyAppGrants, prepareOwnerHandoff } from './db/grants.ts'

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
async function deployment() {
  const dep = await role('dep', 'CREATEROLE')
  const sp = await role('sp')
  const owner = `w21_owner_${stamp}_${++seq}`
  createdRoles.push(owner)
  const db = await scratchDb(dep)
  await as(db, dep, (c) => prepareOwnerHandoff(c, { role: sp, owner }))
  const up = await as(db, sp, (c) => migrateUp(c, { log: quietLog(), ownerRole: owner }))
  await as(db, dep, (c) => applyAppGrants(c, { role: sp, owner }))
  return { dep, sp, owner, db, up }
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
  const rls = await import('./db/rls.ts')
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
  assert.deepEqual([...rls.RLS_0015_TABLES], ['agents', 'agent_runs'])
  const later = [...rls.RLS_0007_TABLES, ...rls.RLS_0005_TABLES, ...rls.RLS_0006_TABLES, ...rls.RLS_0015_TABLES]
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
  const up15 = fs.readFileSync(path.join(MIGRATIONS, '0015_agents.up.sql'), 'utf8')
  for (const t of rls.RLS_0015_TABLES) {
    assert.ok(up15.includes(`ai_prism.${t}`), `0015 up creates ${t}`)
    assert.ok(new RegExp(`${t} FORCE ROW LEVEL SECURITY`).test(up15), `0015 up forces RLS on ${t}`)
  }
  for (const t of rls.RLS_TABLES.filter((x) => !later.includes(x))) {
    assert.ok(up.includes(`'${t}'`), `0003 up names ${t}`)
    assert.ok(down.includes(`'${t}'`), `0003 down names ${t}`)
  }
})

// Every query path goes through withTx (identity + admin flag per transaction).
// withClient( may only be called inside server/db/pool.ts.
test('lint: no withClient( call outside server/db/pool.ts (every query runs inside withTx)', () => {
  const offenders = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      if (e.isDirectory()) walk(child)
      else if (/\.(m?js|cjs|ts)$/.test(e.name) && !/\.test\.(m?js|ts)$/.test(e.name) && child !== 'server/db/pool.ts') {
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
  const { spErrorAction, createWithClient } = await import('./db/pool.ts')
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
  const { txIdentity } = await import('./db/pool.ts')
  assert.deepEqual(txIdentity('a@test.invalid'), ['a@test.invalid', 'off'])
  assert.deepEqual(txIdentity('a@test.invalid', { admin: true }), ['a@test.invalid', 'on'])
  for (const poisoned of ['true', 'on', 1, 'yes', {}, []]) {
    assert.deepEqual(txIdentity('a@test.invalid', { admin: poisoned }), ['a@test.invalid', 'off'], JSON.stringify(poisoned))
  }
  assert.deepEqual(txIdentity(undefined), ['', 'off'], 'no identity → empty, which matches no row')
})

test('the per-process cross-user usage backfill is gone from the request path', async () => {
  const usage = await import('./usage.ts')
  const db = await import('./db.ts')
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
  const { RLS_TABLES, RLS_NOT_FORCED_TABLES } = await import('./db/rls.ts')
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
    // 0015: agents 5 (owner, admin read + decide, scheduler read + update), agent_runs 7 (owner select/insert/update,
    // admin read, scheduler select/insert/update) and aiau_sched_insert on admin_audit = 13.
    // A dropped or duplicated policy changes this
    assert.equal(policyTotal, 14 + 2 * 4 + 4 * 4 + 16 + 33 + 2 + 1 + 1 + 4 + 13, 'exactly 108 policies')
    assert.equal(
      (await c.query(`SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class k ON k.oid = p.polrelid WHERE k.relnamespace = 'ai_prism'::regnamespace`)).rows[0].n,
      108,
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
  const { RLS_PER_USER_TABLES } = await import('./db/rls.ts')
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
    const { RLS_TABLES, RLS_NOT_FORCED_TABLES } = await import('./db/rls.ts')
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
  const { runInIdentityTx } = await import('./db/pool.ts')
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
  const { createWithClient, runInIdentityTx, spErrorAction } = await import('./db/pool.ts')
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
