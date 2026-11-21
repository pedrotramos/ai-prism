// Versioned migrations: server/db/migrate.js, scripts/migrate.mjs and the
// withClient/withTx exports of server/db.js.
//
// Every database test runs in its own scratch database (CREATE DATABASE
// w02_mig_<stamp>_<n>), dropped at the end, so it never touches the shared
// `ai_prism` database the isolation suite uses. Same server and defaults as
// server/isolation.test.js (127.0.0.1:55432, user ai_prism, pgvector); no
// server or no pgvector → the database tests are skipped, the pure ones still
// run. Point elsewhere with ISOLATION_TEST_ANY_HOST=1 (never production: the
// tests create and drop databases and a role).
//
//   node --test server/migrate.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// any: pg rows are untyped
type Row = any
type Err = Error & { code?: string }
type Migration = ReturnType<typeof loadMigrations>[number]

import {
  baselineCatalog,
  checksumOf,
  loadMigrations,
  missingBaselineObjects,
  readSchemaCatalog,
  migrateDown,
  migrateUp,
  migrationStatus,
  MIGRATION_LOCK_KEY,
  pgvectorEnabled,
} from './db/migrate.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const SOURCE_MIGRATIONS = path.join(HERE, 'migrations')
// The runner tests below are about the runner and the baseline (W0-2): they run
// against a copy of the migrations dir that holds 0001 only. 0002 (the ai_prism
// schema) and the owner hand-off are tested in server/schemaAiPrism.test.js; the
// db.js and CLI tests at the end use the real dir.
const MIGRATIONS = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-mig-baseline-'))
for (const f of ['0001_baseline.up.sql', '0001_baseline.down.sql']) {
  fs.copyFileSync(path.join(SOURCE_MIGRATIONS, f), path.join(MIGRATIONS, f))
}

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
const ADMIN_DB = env.PGDATABASE || 'ai_prism'
// the db.js test opens a pool: let it drain fast so teardown does not have to
// terminate its connections (read when server/db/pool.js is first imported)
env.PG_POOL_IDLE_TIMEOUT_MS = '1000'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET

const LOCAL_HOSTS = new Set<string | undefined>(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const created: string[] = []
let seq = 0

function opts(database: string, user = env.PGUSER) {
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
  } catch (err) {
    const e = err as Error & { code?: string }
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false

async function admin(sql: string) {
  const c = new pg.Client(opts(ADMIN_DB))
  await c.connect()
  try {
    return await c.query(sql)
  } finally {
    await c.end().catch(() => {})
  }
}

async function scratchDb() {
  const name = `w02_mig_${stamp}_${++seq}`
  await admin(`CREATE DATABASE ${name}`)
  created.push(name)
  return name
}

async function connect(database: string, user?: string) {
  const c = new pg.Client(opts(database, user))
  await c.connect()
  return c
}

async function withDb<T>(fn: (c: pg.Client, db: string) => Promise<T>): Promise<T> {
  const db = await scratchDb()
  const c = await connect(db)
  try {
    return await fn(c, db)
  } finally {
    await c.end().catch(() => {})
  }
}

// Every SQL text the runner sends, so a test can prove what did NOT run.
function recording(c: pg.Client) {
  const seen: string[] = []
  return {
    seen,
    client: {
      query(text: string | { text: string }, params?: unknown[]) {
        seen.push(typeof text === 'string' ? text : text.text)
        return c.query(text as string, params)
      },
    },
  }
}

// Polls `check` (fresh state every call) until it returns truthy, or fails.
async function waitFor(check: () => Promise<unknown> | unknown, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const APP_TABLES = [
  'app_admins',
  'app_mcp_catalog',
  'app_tool_policy',
  'chat_compactions',
  'chat_decks',
  'chat_documents',
  'chat_genie_conversations',
  'chat_images',
  'chat_message_embeddings',
  'chat_messages',
  'chat_sessions',
  'chat_spreadsheets',
  'chat_tool_calls',
  'deck_templates',
  'model_catalog_overrides',
  'skills',
  'usage_ledger',
  'user_image_model_selection',
  'user_mcp_connections',
  'user_template_selection',
]

async function tables(c: pg.Client) {
  const r = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)
  return r.rows.map((x: Row) => x.tablename)
}

async function publicObjects(c: pg.Client) {
  const r = await c.query(`
    SELECT c.relkind::text AS kind, c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname NOT LIKE 'schema_migrations%'
    UNION ALL
    SELECT 'type', t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype <> 'c' AND t.typname NOT LIKE '%schema_migrations%'
       AND t.typname NOT LIKE '\\_%'
    UNION ALL
    SELECT 'function', p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'extension', extname FROM pg_extension WHERE extname <> 'plpgsql'
    ORDER BY 1, 2`)
  return r.rows.map((x: Row) => `${x.kind}:${x.name}`)
}

// Columns (in order, with type, NOT NULL and default), indexes, constraints,
// sequences and extensions of the public schema, schema_migrations excluded.
async function catalogFingerprint(c: pg.Client) {
  const q = async (sql: string) => (await c.query(sql)).rows.map((r: Row) => Object.values(r).map((v) => String(v)).join(' | '))
  const parts = [
    '# columns',
    ...(await q(`
      SELECT c.relname, row_number() OVER (PARTITION BY c.relname ORDER BY a.attnum) AS pos, a.attname,
             format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND c.relname <> 'schema_migrations'
       ORDER BY 1, a.attnum`)),
    '# indexes',
    ...(await q(`SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1`)),
    '# constraints',
    ...(await q(`SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 AND conrelid::regclass::text <> 'schema_migrations'
       ORDER BY 1, 2`)),
    '# sequences',
    ...(await q(`SELECT sequencename, data_type, start_value, increment_by FROM pg_sequences
       WHERE schemaname = 'public' ORDER BY 1`)),
    '# extensions',
    ...(await q(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`)),
  ]
  const text = parts.join('\n')
  return { text, sha256: crypto.createHash('sha256').update(text).digest('hex') }
}

// The probe-era state: the baseline DDL applied the way the old ensureSchema
// did (no schema_migrations table). The baseline file IS that DDL, verbatim.
async function probeEra(c: pg.Client, { pgvector = true } = {}) {
  const [base] = loadMigrations(MIGRATIONS) as [Migration]
  await c.query(`SELECT set_config('ai_prism.pgvector', $1, false)`, [pgvector ? 'on' : 'off'])
  await c.query(base.up)
  await c.query(`RESET ai_prism.pgvector`)
}

after(async () => {
  if (SKIP) return
  for (const db of created) {
    // idle pool connections close after PG_POOL_IDLE_TIMEOUT_MS; FORCE only
    // for whatever is still there after that
    await waitFor(
      async () => (await admin(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = '${db}'`)).rows[0].n === 0,
      `connections to ${db} to close`,
      5_000
    ).catch(() => {})
    await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {})
  }
  await admin(`DROP ROLE IF EXISTS w02_nonowner_${stamp}`).catch(() => {})
})

// ---- pure: file loading and checksums ---------------------------------------

test('loadMigrations reads 0001_baseline with both directions and a sha256 checksum', () => {
  const list = loadMigrations(MIGRATIONS)
  assert.ok(list.length >= 1)
  const [base] = list as [Migration]
  assert.equal(base.version, 1)
  assert.equal(base.name, 'baseline')
  assert.match(base.checksum, /^[0-9a-f]{64}$/)
  assert.match(base.up, /CREATE TABLE IF NOT EXISTS chat_sessions/)
  assert.match(base.down, /DROP TABLE/)
  const versions = list.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'sorted by version')
})

test('checksum ignores CRLF line endings and a UTF-8 BOM (Windows checkouts)', () => {
  const lf = 'CREATE TABLE a (id int);\nSELECT 1;\n'
  assert.equal(checksumOf(lf), checksumOf(lf.replace(/\n/g, '\r\n')))
  assert.equal(checksumOf(lf), checksumOf('﻿' + lf))
  assert.notEqual(checksumOf(lf), checksumOf(lf.replace('a (', 'b (')))
})

test('loadMigrations refuses an up file without its down, duplicates and bad names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-mig-'))
  try {
    fs.writeFileSync(path.join(dir, '0001_a.up.sql'), 'SELECT 1;')
    assert.throws(() => loadMigrations(dir), /0001_a\.down\.sql/)
    fs.writeFileSync(path.join(dir, '0001_a.down.sql'), 'SELECT 1;')
    assert.equal(loadMigrations(dir).length, 1)
    fs.writeFileSync(path.join(dir, '0001_b.up.sql'), 'SELECT 1;')
    fs.writeFileSync(path.join(dir, '0001_b.down.sql'), 'SELECT 1;')
    assert.throws(() => loadMigrations(dir), /duplicate.*1/i)
    fs.rmSync(path.join(dir, '0001_b.up.sql'))
    fs.rmSync(path.join(dir, '0001_b.down.sql'))
    fs.writeFileSync(path.join(dir, 'oops.sql'), 'SELECT 1;')
    assert.throws(() => loadMigrations(dir), /oops\.sql/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pgvectorEnabled mirrors the old LOCAL_DEV_MODE / LOCAL_PGVECTOR switch', () => {
  assert.equal(pgvectorEnabled({}), true)
  assert.equal(pgvectorEnabled({ LOCAL_DEV_MODE: '1' }), false)
  assert.equal(pgvectorEnabled({ LOCAL_DEV_MODE: '1', LOCAL_PGVECTOR: '1' }), true)
  assert.equal(pgvectorEnabled({ LOCAL_PGVECTOR: '0' }), true)
})

test('the advisory lock key is a fixed integer constant', () => {
  assert.ok(Number.isSafeInteger(MIGRATION_LOCK_KEY))
})

// ---- database: upgrade, adoption, rollback, integrity ------------------------

test('empty DB: up applies 0001, records it once, and a second up is a no-op', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    const r1 = await migrateUp(c, { dir: MIGRATIONS })
    assert.deepEqual(r1.applied, [1])
    assert.equal(r1.adopted, false)
    assert.deepEqual(
      (await tables(c)).filter((t: string) => t !== 'schema_migrations'),
      APP_TABLES
    )
    const rows = (await c.query(`SELECT version, name, checksum, applied_at FROM schema_migrations`)).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].version, 1)
    assert.equal(rows[0].name, 'baseline')
    assert.equal(rows[0].checksum, loadMigrations(MIGRATIONS)[0]!.checksum)
    assert.ok(rows[0].applied_at instanceof Date)

    const rec = recording(c)
    const r2 = await migrateUp(rec.client, { dir: MIGRATIONS })
    assert.deepEqual(r2.applied, [])
    assert.ok(!rec.seen.some((s: string) => /advisory_lock|CREATE|ALTER/i.test(s)), 'steady state takes no lock and runs no DDL')
  })
})

test('empty DB: the baseline builds the schema the app relies on', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await migrateUp(c, { dir: MIGRATIONS })
    const col = async (t: string, name: string) =>
      (
        await c.query(
          `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
             FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = $2 AND NOT a.attisdropped`,
          [t, name]
        )
      ).rows[0]
    assert.equal((await col('chat_message_embeddings', 'embedding')).type, 'vector(1024)')
    assert.equal((await col('usage_ledger', 'cost_usd')).type, 'numeric(14,6)')
    assert.equal((await col('chat_messages', 'active')).notnull, true)
    const pk = await c.query(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'deck_templates'::regclass AND i.indisprimary`
    )
    assert.deepEqual(pk.rows.map((r: Row) => r.attname), ['id'], 'deck_templates PK moved to id')
    const idx = (await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r: Row) => r.indexname)
    for (const name of [
      'idx_msg_emb_hnsw',
      'idx_skills_global_name',
      'idx_skills_user_name',
      'uq_usage_ledger_backfill',
      'idx_chat_compactions_session',
      'idx_deck_templates_global',
    ]) {
      assert.ok(idx.includes(name), `index ${name}`)
    }
  })
})

test('LOCAL_DEV_MODE without pgvector: embeddings fall back to double precision[]', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await migrateUp(c, { dir: MIGRATIONS, pgvector: false })
    const t = await c.query(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = 'chat_message_embeddings'::regclass AND attname = 'embedding'`
    )
    assert.equal(t.rows[0].type, 'double precision[]')
    assert.equal((await c.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).rows.length, 0)
    // the GUC is transaction-local: nothing leaks into the session
    assert.equal((await c.query(`SELECT current_setting('ai_prism.pgvector', true) AS v`)).rows[0].v || '', '')
  })
})

test('probe-era DB: up adopts it as version 1 without re-running any DDL, once', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await probeEra(c)
    await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('keep@test.invalid', 't', 'm')`)
    const before = await publicObjects(c)

    const rec = recording(c)
    const r = await migrateUp(rec.client, { dir: MIGRATIONS })
    assert.deepEqual(r.applied, [])
    assert.equal(r.adopted, true)
    const base = loadMigrations(MIGRATIONS)[0] as Migration
    assert.ok(!rec.seen.includes(base.up), 'the baseline body was not sent')
    assert.ok(
      !rec.seen.some((s: string) => /ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE EXTENSION/i.test(s)),
      'no app DDL ran'
    )
    const rows = (await c.query(`SELECT version, checksum FROM schema_migrations`)).rows
    assert.deepEqual(rows, [{ version: 1, checksum: base.checksum }])
    assert.deepEqual(await publicObjects(c), before, 'objects unchanged')
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n, 1, 'data untouched')

    const again = recording(c)
    const r2 = await migrateUp(again.client, { dir: MIGRATIONS })
    assert.equal(r2.adopted, false)
    assert.ok(!again.seen.some((s: string) => /chat_compactions/.test(s)), 'the probe runs only once')
  })
})

test('older probe-era DB (newest artifact missing): up re-runs the idempotent baseline', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await probeEra(c)
    await c.query(`DROP TABLE chat_compactions`)
    await c.query(`ALTER TABLE app_mcp_catalog DROP COLUMN credential_class`)
    await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ('keep@test.invalid', 't', 'm')`)
    const r = await migrateUp(c, { dir: MIGRATIONS })
    assert.deepEqual(r.applied, [1])
    assert.equal(r.adopted, false)
    assert.ok((await tables(c)).includes('chat_compactions'))
    const cc = await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'app_mcp_catalog' AND column_name = 'credential_class'`
    )
    assert.equal(cc.rows.length, 1)
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n, 1, 'data kept')
  })
})

test('partial 1.x schema missing an earlier table is repaired instead of adopted', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await probeEra(c)
    await c.query(`DROP TABLE chat_genie_conversations`)
    const r = await migrateUp(c, { dir: MIGRATIONS })
    assert.deepEqual(r.applied, [1])
    assert.equal((await c.query(`SELECT to_regclass('public.chat_genie_conversations') AS table_name`)).rows[0].table_name, 'chat_genie_conversations')
  })
})

test('partial 1.x schema missing an earlier column and index is repaired, and the log says why', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await probeEra(c)
    await c.query(`ALTER TABLE chat_tool_calls DROP COLUMN call_id`)
    await c.query(`DROP INDEX idx_chat_sessions_user`)
    const lines: string[] = []
    const r = await migrateUp(c, { dir: MIGRATIONS, log: { warn: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')) } })
    assert.deepEqual(r.applied, [1])
    assert.equal(r.adopted, false)
    assert.deepEqual(await missingBaselineObjects(c), [])
    assert.ok(lines.some((l: string) => /chat_tool_calls\.call_id/.test(l) && /idx_chat_sessions_user/.test(l)), lines.join('\n'))
  })
})

test('drift the idempotent baseline cannot repair is reported after it runs', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await probeEra(c)
    await c.query(`ALTER TABLE user_template_selection DROP CONSTRAINT user_template_selection_template_id_fkey`)
    const warnings: string[] = []
    const r = await migrateUp(c, { dir: MIGRATIONS, log: { warn: (...a) => warnings.push(a.join(' ')), log() {} } })
    assert.deepEqual(r.applied, [1])
    assert.ok(
      warnings.some((w: string) => /still differs/.test(w) && /user_template_selection_template_id_fkey/.test(w)),
      warnings.join('\n')
    )
  })
})

for (const [variant, pgvector] of [['pgvector', true], ['local', false]] as [string, boolean][]) {
  test(`baselineCatalog (${variant}) is exactly what 0001 builds`, { skip: SKIP }, async () => {
    await withDb(async (c: pg.Client) => {
      await migrateUp(c, { dir: MIGRATIONS, pgvector })
      assert.deepEqual(await readSchemaCatalog(c), baselineCatalog({ pgvector }))
      assert.deepEqual(await missingBaselineObjects(c, { pgvector }), [])
    })
  })
}

test('down --to 0 leaves an empty schema, and up again rebuilds it (round trip)', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await migrateUp(c, { dir: MIGRATIONS })
    const full = await publicObjects(c)
    const d = await migrateDown(c, { dir: MIGRATIONS, to: 0 })
    assert.deepEqual(d.reverted, [1])
    assert.deepEqual(await publicObjects(c), [], 'no tables, sequences, indexes, types, functions or extensions left')
    assert.deepEqual(await tables(c), [], 'schema is empty, including migration metadata')
    assert.equal((await c.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t, null)
    const u = await migrateUp(c, { dir: MIGRATIONS })
    assert.deepEqual(u.applied, [1])
    assert.deepEqual(await publicObjects(c), full)
  })
})

test('down refuses a target that is not a non-negative integer', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    await assert.rejects(migrateDown(c, { dir: MIGRATIONS }), /--to/)
    await assert.rejects(migrateDown(c, { dir: MIGRATIONS, to: -1 }), /--to/)
    await assert.rejects(migrateDown(c, { dir: MIGRATIONS, to: 'x' }), /--to/)
  })
})

test('a changed checksum of an applied file is refused, and nothing else runs', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-mig-'))
  try {
    for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
    await withDb(async (c: pg.Client) => {
      await migrateUp(c, { dir })
      fs.appendFileSync(path.join(dir, '0001_baseline.up.sql'), '\n-- edited after apply\n')
      fs.writeFileSync(path.join(dir, '0002_extra.up.sql'), 'CREATE TABLE should_not_exist (id int);')
      fs.writeFileSync(path.join(dir, '0002_extra.down.sql'), 'DROP TABLE should_not_exist;')
      await assert.rejects(migrateUp(c, { dir }), (e: unknown) => (e as Err).code === 'MIGRATION_CHECKSUM' && /0001/.test((e as Err).message))
      assert.ok(!(await tables(c)).includes('should_not_exist'))
      const st = await migrationStatus(c, { dir })
      assert.deepEqual(st.mismatched.map((m) => m.version), [1])
      await assert.rejects(migrateDown(c, { dir, to: 0 }), (e: unknown) => (e as Err).code === 'MIGRATION_CHECKSUM')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing migration rolls back entirely and is not recorded', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-mig-'))
  try {
    for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
    fs.writeFileSync(path.join(dir, '0002_bad.up.sql'), 'CREATE TABLE half_done (id int);\nSELECT * FROM no_such_table;')
    fs.writeFileSync(path.join(dir, '0002_bad.down.sql'), 'DROP TABLE IF EXISTS half_done;')
    await withDb(async (c: pg.Client) => {
      await assert.rejects(migrateUp(c, { dir }), /no_such_table/)
      const v = (await c.query(`SELECT version FROM schema_migrations ORDER BY 1`)).rows.map((r: Row) => r.version)
      assert.deepEqual(v, [1], '0001 kept, 0002 not recorded')
      assert.ok(!(await tables(c)).includes('half_done'))
      const st = await migrationStatus(c, { dir })
      assert.deepEqual(st.pending.map((m) => m.version), [2])
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('status reports applied, pending and applied-but-unknown versions', { skip: SKIP }, async () => {
  await withDb(async (c: pg.Client) => {
    let st = await migrationStatus(c, { dir: MIGRATIONS })
    assert.deepEqual(st.applied, [])
    assert.deepEqual(st.pending.map((m) => m.version), loadMigrations(MIGRATIONS).map((m) => m.version))
    await migrateUp(c, { dir: MIGRATIONS })
    await c.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES (9999, 'from_newer_code', 'x')`)
    st = await migrationStatus(c, { dir: MIGRATIONS })
    assert.deepEqual(st.applied.map((m) => m.version), [1])
    assert.deepEqual(st.pending, [])
    assert.deepEqual(st.unknown.map((m) => m.version), [9999])
    // a DB migrated by newer code still boots older code (code rollback), and
    // says so even on the fast path (nothing pending, no lock)
    const warnings: string[] = []
    const r = await migrateUp(c, { dir: MIGRATIONS, log: { warn: (...a) => warnings.push(a.join(' ')), log() {} } })
    assert.deepEqual(r.applied, [])
    assert.ok(warnings.some((w: string) => /does not know/.test(w) && /9999/.test(w)), warnings.join('\n'))
  })
})

test('concurrent boots: the advisory lock lets exactly one apply the baseline', { skip: SKIP }, async () => {
  const db = await scratchDb()
  const clients = await Promise.all([connect(db), connect(db), connect(db)])
  try {
    const results = await Promise.all(clients.map((c) => migrateUp(c, { dir: MIGRATIONS })))
    assert.deepEqual(results.map((r) => r.applied).flat(), [1])
    const n = (await clients[0].query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n
    assert.equal(n, 1)
    const held = await clients[0].query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
    assert.equal(held.rows[0].n, 0, 'lock released')
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})))
  }
})

test('non-owner without CREATE on a current probe-era DB: warns and boots (old 42501 tolerance)', { skip: SKIP }, async () => {
  const role = `w02_nonowner_${stamp}`
  await admin(`CREATE ROLE ${role} LOGIN PASSWORD '${env.PGPASSWORD}'`)
  await withDb(async (c: pg.Client, db: string) => {
    await probeEra(c)
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
    const nc = await connect(db, role)
    const warnings: string[] = []
    try {
      const r = await migrateUp(nc, { dir: MIGRATIONS, log: { warn: (...a) => warnings.push(a.join(' ')), log() {} } })
      assert.deepEqual(r.applied, [])
      assert.equal(r.adopted, false)
      assert.equal(r.skipped, true)
      assert.ok(warnings.some((w: string) => /42501|permission/i.test(w)))
    } finally {
      await nc.end().catch(() => {})
    }
    // the owner adopts it on its next boot
    const r = await migrateUp(c, { dir: MIGRATIONS })
    assert.equal(r.adopted, true)
  })
})

test('non-owner on an EMPTY DB still fails loudly (nothing to fall back to)', { skip: SKIP }, async () => {
  const role = `w02_nonowner_${stamp}`
  await admin(`DO $$ BEGIN CREATE ROLE ${role} LOGIN PASSWORD '${env.PGPASSWORD}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
  await withDb(async (c, db) => {
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    const nc = await connect(db, role)
    try {
      await assert.rejects(migrateUp(nc, { dir: MIGRATIONS, log: { warn() {}, log() {} } }), (e: unknown) => (e as Err).code === '42501')
    } finally {
      await nc.end().catch(() => {})
    }
  })
})

// ---- server/db.js: ensureSchema, withTx, withSchemaClient ------------------------

test('db.js: ensureSchema runs the migrations; withTx and withSchemaClient are exported, withClient is not (W2-1)', { skip: SKIP }, async () => {
  const dbName = await scratchDb()
  const prev = { PGDATABASE: env.PGDATABASE, LOCAL_DEV_MODE: env.LOCAL_DEV_MODE, LOCAL_PGVECTOR: env.LOCAL_PGVECTOR }
  env.PGDATABASE = dbName
  env.LOCAL_DEV_MODE = '1'
  env.LOCAL_PGVECTOR = '1'
  const email = `mig-${stamp}@test.invalid`
  try {
    const db = await import('./db.ts')
    const pool = await import('./db/pool.ts')
    assert.equal('ensureSpGrants' in db, false, 'the per-request SP grants are gone (W1-5)')
    assert.equal('withClient' in db, false, 'queries go through withTx (identity per transaction)')
    assert.equal(db.withTx, pool.withTx)
    assert.equal(db.withSchemaClient, pool.withSchemaClient)
    await db.ensureSchema(email, 'tok')
    const v = await db.withTx(email, 'tok', (c) => c.query(`SELECT version FROM schema_migrations ORDER BY 1`))
    // every migration of the repo (server/migrations), whatever the newest is
    assert.deepEqual(v.rows.map((r: Row) => r.version), loadMigrations().map((m) => m.version))

    const id = await db.withTx(email, 'tok', async (c) => {
      const r = await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'a', 'm') RETURNING id`, [email])
      return r.rows[0].id
    })
    assert.ok(id)
    await assert.rejects(
      db.withTx(email, 'tok', async (c) => {
        await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'b', 'm')`, [email])
        throw new Error('boom')
      }),
      /boom/
    )
    const titles = await db.withTx(email, 'tok', (c) =>
      c.query(`SELECT title FROM chat_sessions WHERE user_email = $1 ORDER BY id`, [email])
    )
    assert.deepEqual(titles.rows.map((r: Row) => r.title), ['a'], 'committed once, rolled back once')
    const inTx = await db.withSchemaClient(email, 'tok', (c) => c.query(`SELECT now() = statement_timestamp() AS idle`))
    assert.equal(inTx.rows[0].idle, true, 'the pooled connection came back outside any transaction')
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
  }
})

// ---- scripts/migrate.mjs --------------------------------------------------------

function cli(dbName: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'migrate.mjs'), ...args], {
    env: { ...env, PGDATABASE: dbName, LOCAL_DEV_MODE: '', LOCAL_PGVECTOR: '' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

test('scripts/migrate.mjs: status, up, down --to 0, usage errors', { skip: SKIP }, async () => {
  const dbName = await scratchDb()
  let r = cli(dbName, 'status')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /0001\s+baseline\s+pending/)
  assert.match(r.out, /0002\s+schema_ai_prism\s+pending/)
  r = cli(dbName, 'up')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /applied 0001 baseline/)
  assert.match(r.out, /applied 0002 schema_ai_prism/)
  r = cli(dbName, 'status')
  assert.match(r.out, /0001\s+baseline\s+applied/)
  assert.match(r.out, /0002\s+schema_ai_prism\s+applied/)
  r = cli(dbName, 'down')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /--to/)
  r = cli(dbName, 'down', '--to', '0')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /--yes/)
  assert.match(r.out, new RegExp(`${dbName}`), 'names the target database')
  r = cli(dbName, 'status')
  assert.match(r.out, /0001\s+baseline\s+applied/, 'nothing rolled back without --yes')
  r = cli(dbName, 'down', '--to', '0', '--yes')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`target: .*${dbName}`))
  assert.match(r.out, /reverted 0002 schema_ai_prism/)
  assert.match(r.out, /reverted 0001 baseline/)
  const c = await connect(dbName)
  try {
    assert.deepEqual(await publicObjects(c), [])
    assert.deepEqual(await tables(c), [], 'schema_migrations dropped too')
    const ns = await c.query(`SELECT to_regnamespace('ai_prism') IS NULL AS gone`)
    assert.equal(ns.rows[0].gone, true, 'the ai_prism schema is gone too')
  } finally {
    await c.end()
  }
  r = cli(dbName, 'sideways')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /usage/i)
  r = cli(dbName, 'up', '--to', '1')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /--to/)
})

// ---- the baseline is the 1.4 schema, independently of the file text ------------

// sha256 of catalogFingerprint() on databases built by the 1.4 boot-time DDL
// (runSchemaDdl at 30c37e3) on Postgres 17 + pgvector, before migrations
// existed. Recompute only from a database built by THAT code, never from the
// baseline file itself (that would make this test circular).
const BASELINE_CATALOG_SHA256: Record<string, string> = {
  pgvector: '200dbf867f441dfa5905bd61abae325f2d7422306fc271d9dd00d268249cf9ae',
  local: '9bfbedfcb1cc440b70c68f4c54a37b2ee577b6302efa815f515d39ac91b0f5d5',
}
// 0001 is released: its checksum is part of every database that applied it.
const BASELINE_FILE_SHA256 = 'f82e503ce15a83663b777f000403e9b2ff709621b5b63e1ce0a61d2191d6febb'

test('0001_baseline.up.sql is frozen (any edit would be refused on every deployed DB)', () => {
  assert.equal(loadMigrations(MIGRATIONS)[0]!.checksum, BASELINE_FILE_SHA256)
})

for (const [variant, pgvector] of [['pgvector', true], ['local', false]] as [string, boolean][]) {
  test(`baseline catalog (${variant}) equals the one the 1.4 boot DDL built`, { skip: SKIP }, async () => {
    await withDb(async (c: pg.Client) => {
      await migrateUp(c, { dir: MIGRATIONS, pgvector })
      const fp = await catalogFingerprint(c)
      assert.equal(fp.sha256, BASELINE_CATALOG_SHA256[variant], `catalog changed:\n${fp.text}`)
    })
  })
}

// ---- lock waits, adoption privileges, ordering ----------------------------------

async function advisoryWaiters(c: pg.Client) {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
  )
  return r.rows[0].n
}

test('a runner waits for the lock without a blocked query, then proceeds', { skip: SKIP }, async () => {
  const db = await scratchDb()
  const holder = await connect(db)
  const c = await connect(db)
  try {
    await holder.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY])
    let settled = false
    const rec = recording(c)
    const run = migrateUp(rec.client, { dir: MIGRATIONS }).finally(() => (settled = true))
    const attempts = () => rec.seen.filter((q) => /pg_try_advisory_lock/.test(q)).length
    await waitFor(() => attempts() >= 2, 'a second lock attempt')
    assert.equal(settled, false, 'still waiting while the lock is held')
    assert.equal(await advisoryWaiters(holder), 0, 'no lock request left queued on the socket')
    await holder.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY])
    const r = await run
    assert.deepEqual(r.applied, [1])
  } finally {
    await holder.end().catch(() => {})
    await c.end().catch(() => {})
  }
})

test('the lock wait is bounded and leaves nothing held', { skip: SKIP }, async () => {
  const db = await scratchDb()
  const holder = await connect(db)
  const c = await connect(db)
  try {
    await holder.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY])
    await assert.rejects(migrateUp(c, { dir: MIGRATIONS, lockWaitMs: 300 }), (e: unknown) => (e as Err).code === 'MIGRATION_LOCK_TIMEOUT')
    const mine = await c.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`
    )
    assert.equal(mine.rows[0].n, 0)
    assert.equal(await advisoryWaiters(holder), 0)
  } finally {
    await holder.end().catch(() => {})
    await c.end().catch(() => {})
  }
})

test('non-owner that can read but not write schema_migrations on a 1.x DB: warns and boots', { skip: SKIP }, async () => {
  const role = `w02_nonowner_${stamp}`
  await admin(`DO $$ BEGIN CREATE ROLE ${role} LOGIN PASSWORD '${env.PGPASSWORD}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
  await withDb(async (c, db) => {
    await probeEra(c)
    await c.query(`CREATE TABLE schema_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
                   applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    const nc = await connect(db, role)
    const warnings: string[] = []
    try {
      const r = await migrateUp(nc, { dir: MIGRATIONS, log: { warn: (...a) => warnings.push(a.join(' ')), log() {} } })
      assert.equal(r.skipped, true)
      assert.ok(warnings.some((w: string) => /42501/.test(w)))
    } finally {
      await nc.end().catch(() => {})
    }
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n, 0)
  })
})

test('a pending version older than the newest applied one runs, with a warning', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-mig-'))
  try {
    for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
    await withDb(async (c: pg.Client) => {
      await migrateUp(c, { dir, log: { warn() {}, log() {} } })
      fs.writeFileSync(path.join(dir, '0003_c.up.sql'), 'CREATE TABLE t3 (id int);')
      fs.writeFileSync(path.join(dir, '0003_c.down.sql'), 'DROP TABLE t3;')
      assert.deepEqual((await migrateUp(c, { dir, log: { warn() {}, log() {} } })).applied, [3])
      fs.writeFileSync(path.join(dir, '0002_b.up.sql'), 'CREATE TABLE t2 (id int);')
      fs.writeFileSync(path.join(dir, '0002_b.down.sql'), 'DROP TABLE t2;')
      const warnings: string[] = []
      const r = await migrateUp(c, { dir, log: { warn: (...a) => warnings.push(a.join(' ')), log() {} } })
      assert.deepEqual(r.applied, [2])
      assert.ok(warnings.some((w: string) => /out of order/.test(w) && /0002/.test(w)), warnings.join('\n'))
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
