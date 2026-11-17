// Versioned schema migrations: plain SQL files, applied in order, recorded in
// schema_migrations, one runner at a time.
//
//   server/migrations/NNNN_<name>.up.sql     forward change (required)
//   server/migrations/NNNN_<name>.down.sql   its rollback (required)
//
// Why this replaced the boot-time probe + idempotent DDL of 1.x: a probe entry
// forgotten in a release left a column missing and the app failing later;
// there was no rollback path; and two replicas booting together could both run
// the DDL. Here every applied file is recorded with a checksum, a file edited
// after it was applied is refused (it would mean two databases with the same
// version and different schemas), rollback is an explicit `down` file with a
// test, and a session-level advisory lock serialises concurrent runners.
//
// Each migration runs in its own transaction together with its
// schema_migrations row: it is either fully applied and recorded, or not at
// all. Steady state (everything applied) costs two cheap SELECTs and takes no
// lock, so it is fine on the request path (ensureSchema in server/db.js).
//
// Used by server/db.js (ensureSchema, once per process) and by
// scripts/migrate.mjs (up / down --to N / status).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// pg_advisory_lock key shared by every runner of this app (any constant works,
// it only has to be the same everywhere and unlikely to collide with another
// app's lock in the same database). 0x41505231 = "APR1".
export const MIGRATION_LOCK_KEY = 0x41505231

const FILE_RE = /^(\d{4,9})_([a-z0-9][a-z0-9_]*)\.(up|down)\.sql$/

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

class MigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- files -------------------------------------------------------------------

function baseDir() {
  // bundled CJS (server-dist/index.cjs): __dirname is server-dist/; ESM dev:
  // this file's folder (server/db/). Same pattern as server/index.js.
  if (typeof __dirname !== 'undefined') return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}

// The SQL files ship as files next to the code (they are not bundled):
// server/migrations/ from the source tree, the bundle, or the app's cwd.
export function migrationsDir() {
  const base = baseDir()
  const candidates = [
    path.join(base, '..', 'migrations'),
    path.join(base, '..', 'server', 'migrations'),
    path.join(process.cwd(), 'server', 'migrations'),
  ]
  const found = candidates.find((d) => fs.existsSync(path.join(d, '0001_baseline.up.sql')))
  if (!found) {
    throw new MigrationError(
      'MIGRATION_FILES',
      `migrations: server/migrations not found (looked in ${candidates.join(', ')}); deploy the server/ folder with the app`
    )
  }
  return found
}

// Line endings and a BOM are not part of the identity of a migration: a
// Windows checkout (core.autocrlf) must not look like an edited file.
function normalise(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export function checksumOf(text) {
  return crypto.createHash('sha256').update(normalise(text), 'utf8').digest('hex')
}

const label = (m) => `${String(m.version).padStart(4, '0')} ${m.name}`

/** Every migration in `dir`, sorted by version: { version, name, up, down, checksum }. */
export function loadMigrations(dir = migrationsDir()) {
  const byVersion = new Map()
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue
    const m = FILE_RE.exec(file)
    if (!m) throw new MigrationError('MIGRATION_FILES', `migrations: bad file name ${file} (expected NNNN_name.up.sql / .down.sql)`)
    const version = Number(m[1])
    const entry = byVersion.get(version) || { version, name: m[2], files: {} }
    if (entry.name !== m[2]) {
      throw new MigrationError(
        'MIGRATION_FILES',
        `migrations: duplicate version ${version}: ${m[1]}_${entry.name} and ${m[1]}_${m[2]}`
      )
    }
    entry.files[m[3]] = file
    byVersion.set(version, entry)
  }
  const list = [...byVersion.values()].sort((a, b) => a.version - b.version)
  return list.map((e) => {
    const stem = `${String(e.version).padStart(4, '0')}_${e.name}`
    for (const dirn of ['up', 'down']) {
      if (!e.files[dirn]) {
        const want = e.files.up ? e.files.up.replace(/\.up\.sql$/, `.${dirn}.sql`) : `${stem}.${dirn}.sql`
        throw new MigrationError('MIGRATION_FILES', `migrations: ${want} is missing (every migration needs up and down)`)
      }
    }
    const up = normalise(fs.readFileSync(path.join(dir, e.files.up), 'utf8'))
    const down = normalise(fs.readFileSync(path.join(dir, e.files.down), 'utf8'))
    return { version: e.version, name: e.name, up, down, checksum: checksumOf(up) }
  })
}

/** false only for LOCAL_DEV_MODE=1 without LOCAL_PGVECTOR=1 (Homebrew Postgres without pgvector). */
export function pgvectorEnabled(env = process.env) {
  return !(env.LOCAL_DEV_MODE === '1' && env.LOCAL_PGVECTOR !== '1')
}

// ---- the 1.x schema probe (adoption of databases built before migrations) ----

// The newest artifacts the 1.4 boot-time DDL created (its ensureSchema probe,
// verbatim). All present → the database already has the 0001 baseline.
export async function legacySchemaCurrent(c) {
  try {
    await c.query(`SELECT scope FROM deck_templates LIMIT 0`)
    await c.query(`SELECT principal FROM app_admins LIMIT 0`)
    await c.query(`SELECT template_id FROM user_template_selection LIMIT 0`)
    await c.query(`SELECT id FROM chat_spreadsheets LIMIT 0`)
    await c.query(`SELECT endpoint_id FROM model_catalog_overrides LIMIT 0`)
    await c.query(`SELECT connection_name FROM user_mcp_connections LIMIT 0`)
    await c.query(`SELECT triggers FROM skills LIMIT 0`)
    await c.query(`SELECT message_id FROM chat_message_embeddings LIMIT 0`)
    await c.query(`SELECT volume_path FROM chat_images LIMIT 0`)
    await c.query(`SELECT tool_key FROM app_tool_policy LIMIT 0`)
    await c.query(`SELECT markdown FROM chat_documents LIMIT 0`)
    await c.query(`SELECT media_processing FROM chat_messages LIMIT 0`)
    await c.query(`SELECT intent_classify FROM chat_messages LIMIT 0`)
    await c.query(`SELECT reasoning FROM chat_messages LIMIT 0`)
    await c.query(`SELECT service_name FROM app_mcp_catalog LIMIT 0`)
    await c.query(`SELECT cost_usd FROM usage_ledger LIMIT 0`)
    await c.query(`SELECT credential_class FROM app_mcp_catalog LIMIT 0`)
    await c.query(`SELECT upto_message_id FROM chat_compactions LIMIT 0`)
    return true
  } catch {
    return false
  }
}

// ---- state -------------------------------------------------------------------

async function tableExists(c) {
  const r = await c.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`)
  return Boolean(r.rows[0]?.ok)
}

async function readState(c, migrations) {
  const exists = await tableExists(c)
  const rows = exists
    ? (await c.query(`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`)).rows
    : []
  const recorded = new Map(rows.map((r) => [Number(r.version), r]))
  const files = new Set(migrations.map((m) => m.version))
  const applied = []
  const mismatched = []
  const pending = []
  for (const m of migrations) {
    const r = recorded.get(m.version)
    if (!r) {
      pending.push(m)
      continue
    }
    applied.push({ ...m, appliedAt: r.applied_at, recordedChecksum: r.checksum })
    if (r.checksum !== m.checksum) mismatched.push({ ...m, appliedAt: r.applied_at, recordedChecksum: r.checksum })
  }
  const unknown = rows
    .filter((r) => !files.has(Number(r.version)))
    .map((r) => ({ version: Number(r.version), name: r.name, appliedAt: r.applied_at, recordedChecksum: r.checksum }))
  return { exists, rows, applied, mismatched, pending, unknown }
}

function refuseMismatch(state) {
  if (!state.mismatched.length) return
  const list = state.mismatched
    .map((m) => `${label(m)} (recorded ${m.recordedChecksum.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…)`)
    .join('; ')
  throw new MigrationError(
    'MIGRATION_CHECKSUM',
    `migrations: applied file changed: ${list}. Restore the released file and put the change in a new migration.`
  )
}

/** { applied, pending, mismatched, unknown } — what `scripts/migrate.mjs status` prints. */
export async function migrationStatus(c, { dir } = {}) {
  const st = await readState(c, loadMigrations(dir))
  return { applied: st.applied, pending: st.pending, mismatched: st.mismatched, unknown: st.unknown }
}

async function withLock(c, fn) {
  await c.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY])
  try {
    return await fn()
  } finally {
    // a broken connection releases the lock by itself
    await c.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => {})
  }
}

async function inTransaction(c, pgvector, fn) {
  await c.query('BEGIN')
  try {
    // read by 0001 (and any later file that needs it); transaction-local
    await c.query(`SELECT set_config('ai_prism.pgvector', $1, true)`, [pgvector ? 'on' : 'off'])
    await fn()
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
}

// ---- up / down -----------------------------------------------------------------

/**
 * Applies every pending migration. Returns { applied: [versions], adopted, skipped }.
 * adopted: a 1.x database (current probe, no schema_migrations rows) was
 * recorded as version 1 without running 0001. skipped: this identity cannot
 * create or read schema_migrations (42501) on a current 1.x database; the
 * app keeps working (the 1.x behaviour) and the owner records it later.
 */
export async function migrateUp(c, { dir, pgvector = pgvectorEnabled(), probe = legacySchemaCurrent, log = console } = {}) {
  const migrations = loadMigrations(dir)
  const onlyBaseline = migrations.every((m) => m.version === 1)

  // A non-owner identity (the app's SP on a database another identity built)
  // may lack CREATE on the schema or SELECT on schema_migrations. With only
  // the baseline to apply and the 1.x probe passing, nothing is actually
  // missing: warn and boot, as 1.x did. With a newer migration pending the
  // error surfaces (withClient then falls back to the caller's identity).
  const tolerate = async (e) => {
    if (e?.code !== '42501' || !onlyBaseline || !(await probe(c))) return false
    log.warn(
      `migrations: no privilege to record the schema version (${e.code}: ${e.message}); ` +
        'the 1.x schema is current, continuing. Run `node scripts/migrate.mjs up` as the table owner to record it.'
    )
    return true
  }

  let state
  try {
    state = await readState(c, migrations)
  } catch (e) {
    if (await tolerate(e)) return { applied: [], adopted: false, skipped: true }
    throw e
  }
  if (state.exists) {
    refuseMismatch(state)
    if (!state.pending.length) return { applied: [], adopted: false, skipped: false }
  }

  return withLock(c, async () => {
    try {
      if (!(await tableExists(c))) await c.query(CREATE_TABLE)
      state = await readState(c, migrations) // again, under the lock
    } catch (e) {
      if (await tolerate(e)) return { applied: [], adopted: false, skipped: true }
      throw e
    }
    refuseMismatch(state)

    let pending = state.pending
    let adopted = false
    if (!state.rows.length && pending[0]?.version === 1 && (await probe(c))) {
      const base = pending[0]
      await c.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
        base.version,
        base.name,
        base.checksum,
      ])
      adopted = true
      pending = pending.slice(1)
      log.log(`migrations: recorded ${label(base)} for an existing 1.x schema (no DDL run)`)
    }

    const applied = []
    for (const m of pending) {
      await inTransaction(c, pgvector, async () => {
        await c.query(m.up)
        await c.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
          m.version,
          m.name,
          m.checksum,
        ])
      })
      applied.push(m.version)
      log.log(`migrations: applied ${label(m)}`)
    }
    if (state.unknown.length) {
      log.warn(
        `migrations: the database has versions this code does not know (${state.unknown.map(label).join(', ')}); ` +
          'it was migrated by a newer release'
      )
    }
    return { applied, adopted, skipped: false }
  })
}

/**
 * Rolls back, newest first, every applied migration with version > to, each
 * in its own transaction with the removal of its schema_migrations row.
 * Returns { reverted: [versions] }. `to` is required: 0 rolls back everything.
 */
export async function migrateDown(c, { dir, to, pgvector = pgvectorEnabled(), log = console } = {}) {
  const target = typeof to === 'string' && to.trim() !== '' ? Number(to) : to
  if (!Number.isSafeInteger(target) || target < 0) {
    throw new MigrationError('MIGRATION_USAGE', 'migrations: down needs --to N (a version >= 0; 0 rolls back everything)')
  }
  const migrations = loadMigrations(dir)
  return withLock(c, async () => {
    const state = await readState(c, migrations)
    if (!state.exists) return { reverted: [] }
    refuseMismatch(state)
    const unknown = state.unknown.filter((u) => u.version > target)
    if (unknown.length) {
      throw new MigrationError(
        'MIGRATION_UNKNOWN',
        `migrations: cannot roll back ${unknown.map(label).join(', ')}: no file in this release (use the release that added it)`
      )
    }
    const todo = state.applied.filter((m) => m.version > target).sort((a, b) => b.version - a.version)
    const reverted = []
    for (const m of todo) {
      await inTransaction(c, pgvector, async () => {
        await c.query(m.down)
        await c.query(`DELETE FROM schema_migrations WHERE version = $1`, [m.version])
      })
      reverted.push(m.version)
      log.log(`migrations: reverted ${label(m)}`)
    }
    return { reverted }
  })
}
