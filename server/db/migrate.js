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
// lock, so it is fine on the request path (ensureSchema in server/db.js). The
// lock is session-level and polled (see MIGRATION_LOCK_WAIT_MS).
// Consequence of the per-file transaction: a statement that Postgres refuses
// inside a transaction (CREATE INDEX CONCURRENTLY, VACUUM) cannot go in a
// migration file.
//
// Owner role (W1-5, server/db/grants.js): when the connecting identity is a
// DIRECT member of the owner role with SET (the deploy's hand-off), every write
// this runner makes runs as that role (SET LOCAL ROLE in each transaction), so
// what migrations create is owned by the owner role from the start. Superusers
// are not switched (membership must be explicit). The runner also pins the
// connection's search_path to `ai_prism, public`: after 0002, schema_migrations
// lives in ai_prism, and a runner that could not see it would think the
// database is empty.
//
// Used by server/db.js (ensureSchema, once per process) and by
// scripts/migrate.mjs (up / down --to N / status / grants / prepare).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerRoleName } from './grants.js'
import { APP_SEARCH_PATH } from './pool.js'

// pg_advisory_lock key shared by every runner of this app (any constant works,
// it only has to be the same everywhere and unlikely to collide with another
// app's lock in the same database). 0x41505231 = "APR1".
export const MIGRATION_LOCK_KEY = 0x41505231
// How long a runner waits for another one to finish. The lock is polled with
// pg_try_advisory_lock instead of a blocking pg_advisory_lock: a blocking call
// would hit the pool's query_timeout and leave the lock request queued on a
// pooled socket, which would then hold the lock after the caller gave up.
export const MIGRATION_LOCK_WAIT_MS = 2 * 60 * 1000
const LOCK_POLL_MS = 250

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

// ---- adoption of databases built before migrations (1.x) -----------------------

// What 0001_baseline builds, as read back from the Postgres catalog: every
// column of every table, every index that is not a constraint's, every
// constraint with its definition. A database without schema_migrations is
// recorded as version 1 only when ALL of it is present: the 1.x probe looked
// at the newest artifacts only, so a schema missing an older table or column
// passed it. Kept exact by server/migrate.test.js (baselineCatalog vs a
// database 0001 just built, in both pgvector modes).
const BASELINE_COLUMNS = {
  app_admins: 'principal kind added_by created_at',
  app_mcp_catalog: 'service_name display_name description hidden added_by created_at updated_at credential_class',
  app_tool_policy: 'tool_key enabled updated_by updated_at',
  chat_compactions:
    'id session_id upto_message_id content model auto messages tokens_before tokens_after instructions prompt_tokens completion_tokens created_at',
  chat_decks: 'id session_id user_email title slides created_at updated_at meta',
  chat_documents: 'id session_id user_email title markdown created_at updated_at',
  chat_genie_conversations: 'session_id space_id conversation_id updated_at',
  chat_images: 'id session_id user_email prompt model volume_path content_type created_at',
  chat_message_embeddings: 'message_id session_id embedding created_at',
  chat_messages:
    'id session_id role content attachments model prompt_tokens completion_tokens created_at blocks media_processing intent_classify reasoning variant_group active',
  chat_sessions: 'id user_email title model system_prompt created_at updated_at embedding enabled_tools chart_candidates',
  chat_spreadsheets: 'id session_id user_email title spec created_at updated_at',
  chat_tool_calls: 'id message_id seq tool_name tool_label arguments result status duration_ms created_at call_id',
  deck_templates:
    'user_email name primary_color secondary_color accent_color heading_font body_font logo_data_url style_notes updated_at id is_selected ' +
    'background_color created_at icon_assets preview_slides cover_plate_data_url mined_style logo_light_data_url readme brand_rules palette ' +
    'font_assets ds_cards scope',
  model_catalog_overrides: 'endpoint_id enabled display_name blurb sort_order updated_by updated_at price_in price_out',
  skills: 'id scope owner_email name title description body triggers embedding source enabled created_by created_at updated_at',
  usage_ledger:
    'id user_email session_id message_id kind model prompt_tokens completion_tokens cache_read_tokens cache_write_tokens estimated cost_usd source created_at',
  user_image_model_selection: 'user_email model_id updated_at',
  user_mcp_connections: 'user_email connection_name comment status last_checked_at created_at',
  user_template_selection: 'user_email template_id updated_at',
}

const BASELINE_INDEXES =
  'idx_chat_compactions_session idx_chat_decks_session idx_chat_documents_session idx_chat_images_session ' +
  'idx_chat_messages_session idx_chat_messages_variant_group idx_chat_sessions_user idx_chat_spreadsheets_session ' +
  'idx_chat_tool_calls_message idx_deck_templates_global idx_deck_templates_user idx_msg_emb_session ' +
  'idx_skills_global_name idx_skills_user_name idx_usage_ledger_session idx_usage_ledger_user_time uq_usage_ledger_backfill'

const BASELINE_CONSTRAINTS = [
  ['app_admins_pkey', 'PRIMARY KEY (principal)'],
  ['app_mcp_catalog_pkey', 'PRIMARY KEY (service_name)'],
  ['app_tool_policy_pkey', 'PRIMARY KEY (tool_key)'],
  ['chat_compactions_pkey', 'PRIMARY KEY (id)'],
  ['chat_compactions_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_compactions_upto_message_id_fkey', 'FOREIGN KEY (upto_message_id) REFERENCES chat_messages(id) ON DELETE CASCADE'],
  ['chat_decks_pkey', 'PRIMARY KEY (id)'],
  ['chat_decks_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_documents_pkey', 'PRIMARY KEY (id)'],
  ['chat_documents_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_genie_conversations_pkey', 'PRIMARY KEY (session_id, space_id)'],
  ['chat_genie_conversations_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_images_pkey', 'PRIMARY KEY (id)'],
  ['chat_images_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_message_embeddings_message_id_fkey', 'FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE'],
  ['chat_message_embeddings_pkey', 'PRIMARY KEY (message_id)'],
  ['chat_message_embeddings_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_messages_pkey', 'PRIMARY KEY (id)'],
  ['chat_messages_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_sessions_pkey', 'PRIMARY KEY (id)'],
  ['chat_spreadsheets_pkey', 'PRIMARY KEY (id)'],
  ['chat_spreadsheets_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE'],
  ['chat_tool_calls_message_id_fkey', 'FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE'],
  ['chat_tool_calls_pkey', 'PRIMARY KEY (id)'],
  ['deck_templates_pkey', 'PRIMARY KEY (id)'],
  ['model_catalog_overrides_pkey', 'PRIMARY KEY (endpoint_id)'],
  ['skills_pkey', 'PRIMARY KEY (id)'],
  ['usage_ledger_pkey', 'PRIMARY KEY (id)'],
  ['usage_ledger_session_id_fkey', 'FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL'],
  ['user_image_model_selection_pkey', 'PRIMARY KEY (user_email)'],
  ['user_mcp_connections_pkey', 'PRIMARY KEY (user_email, connection_name)'],
  ['user_template_selection_pkey', 'PRIMARY KEY (user_email)'],
  ['user_template_selection_template_id_fkey', 'FOREIGN KEY (template_id) REFERENCES deck_templates(id) ON DELETE CASCADE'],
]

/** The catalog 0001 builds: { columns: ['table.column'], indexes: [name], constraints: ['name: definition'] }, sorted. */
export function baselineCatalog({ pgvector = pgvectorEnabled() } = {}) {
  const columns = Object.entries(BASELINE_COLUMNS).flatMap(([t, cols]) => cols.split(' ').map((col) => `${t}.${col}`))
  const indexes = BASELINE_INDEXES.split(' ').concat(pgvector ? ['idx_msg_emb_hnsw'] : [])
  const constraints = BASELINE_CONSTRAINTS.map(([n, d]) => `${n}: ${d}`)
  return { columns: columns.sort(), indexes: indexes.sort(), constraints: constraints.sort() }
}

/** The same shape, read from the current schema (schema_migrations excluded). Needs no privilege beyond USAGE. */
export async function readSchemaCatalog(c) {
  const columns = await c.query(`
    SELECT t.relname || '.' || a.attname AS x FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
     WHERE t.relnamespace = current_schema()::regnamespace AND t.relkind = 'r' AND a.attnum > 0
       AND NOT a.attisdropped AND t.relname <> 'schema_migrations'`)
  const indexes = await c.query(`
    SELECT i.relname AS x FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
     WHERE t.relnamespace = current_schema()::regnamespace AND t.relname <> 'schema_migrations'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid)`)
  const constraints = await c.query(`
    SELECT conname || ': ' || pg_get_constraintdef(oid) AS x FROM pg_constraint
     WHERE connamespace = current_schema()::regnamespace AND conrelid <> 0
       AND conrelid IS DISTINCT FROM to_regclass('schema_migrations')`)
  const list = (r) => r.rows.map((row) => row.x).sort()
  return { columns: list(columns), indexes: list(indexes), constraints: list(constraints) }
}

/** Baseline objects absent (or, for constraints, defined differently) in the current schema; [] = complete. */
export async function missingBaselineObjects(c, { pgvector = pgvectorEnabled() } = {}) {
  const want = baselineCatalog({ pgvector })
  const have = await readSchemaCatalog(c)
  const missing = []
  for (const kind of ['columns', 'indexes', 'constraints']) {
    const got = new Set(have[kind])
    for (const x of want[kind]) if (!got.has(x)) missing.push(x)
  }
  return missing
}

const summary = (list, max = 12) =>
  list.length > max ? `${list.slice(0, max).join(', ')} … (+${list.length - max} more)` : list.join(', ')

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
  await pinSearchPath(c)
  const st = await readState(c, loadMigrations(dir))
  return { applied: st.applied, pending: st.pending, mismatched: st.mismatched, unknown: st.unknown }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withLock(c, waitMs, fn) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const r = await c.query(`SELECT pg_try_advisory_lock($1) AS ok`, [MIGRATION_LOCK_KEY])
    if (r.rows[0]?.ok) break
    const left = deadline - Date.now()
    if (left <= 0) {
      throw new MigrationError(
        'MIGRATION_LOCK_TIMEOUT',
        `migrations: another runner has held the migration lock for over ${Math.round(waitMs / 1000)} s; retry later ` +
          `(holder: SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${MIGRATION_LOCK_KEY})`
      )
    }
    await sleep(Math.min(LOCK_POLL_MS, left))
  }
  try {
    return await fn()
  } finally {
    // a broken connection releases the lock by itself
    await c.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => {})
  }
}

// ctx: { pgvector, ownerRole, useOwner } (see runContext)
async function inTransaction(c, ctx, fn) {
  await c.query('BEGIN')
  try {
    if (ctx.useOwner) await c.query(`SET LOCAL ROLE "${ctx.ownerRole.replace(/"/g, '""')}"`)
    // read by 0001 / 0002 (and any later file that needs them); transaction-local
    await c.query(
      `SELECT set_config('ai_prism.pgvector', $1, true), set_config('ai_prism.owner_role', $2, true),
              set_config('ai_prism.use_owner_role', $3, true)`,
      [ctx.pgvector ? 'on' : 'off', ctx.ownerRole, ctx.useOwner ? 'on' : 'off']
    )
    await fn()
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
}

async function pinSearchPath(c) {
  await c.query(`SET search_path TO ${APP_SEARCH_PATH}`)
}

// Whether this identity runs migrations as the owner role: a direct, SET-able
// membership only (never inferred from superuser or inherited rights).
async function runContext(c, { pgvector, ownerRole }) {
  const r = await c.query(
    `SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                     WHERE g.rolname = $1 AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND m.set_option) AS ok`,
    [ownerRole]
  )
  return { pgvector, ownerRole, useOwner: Boolean(r.rows[0]?.ok) }
}

// SQLSTATE raised by 0002 when this identity cannot own every app table yet
// (mixed ownership without the deploy's hand-off).
export const OWNERSHIP_NOT_NORMALIZED = 'AIP02'
// Versions whose effect is invisible to the app's queries (the baseline it was
// built against, and the schema move resolved by search_path): a runner that
// cannot apply them may let the app boot. Anything newer must surface.
const SCHEMA_TRANSPARENT = new Set([1, 2])

// ---- up / down -----------------------------------------------------------------

function warnUnknown(state, log) {
  if (!state.unknown.length) return
  log.warn(
    `migrations: the database has versions this code does not know (${state.unknown.map(label).join(', ')}); ` +
      'it was migrated by a newer release'
  )
}

/**
 * Applies every pending migration. Returns { applied: [versions], adopted, skipped, deferred: [versions] }.
 * deferred: 0002 stopped with OWNERSHIP_NOT_NORMALIZED (nothing changed; the app
 * runs on public and ensureReady retries later), or a schema-transparent version
 * this identity has no privilege for.
 * adopted: a 1.x database with the complete baseline catalog and no
 * schema_migrations rows was recorded as version 1 without running 0001 (a
 * partial one gets 0001 run, which is idempotent). skipped: this identity
 * cannot create, read or write schema_migrations (42501) on a complete 1.x
 * database; the app keeps working (the 1.x behaviour) and the owner records it later.
 */
export async function migrateUp(
  c,
  { dir, pgvector = pgvectorEnabled(), log = console, lockWaitMs = MIGRATION_LOCK_WAIT_MS, ownerRole = ownerRoleName() } = {}
) {
  const migrations = loadMigrations(dir)
  await pinSearchPath(c)
  const ctx = await runContext(c, { pgvector, ownerRole })
  const transparentOnly = (list) => list.every((m) => SCHEMA_TRANSPARENT.has(m.version))
  const complete = async () => {
    try {
      return (await missingBaselineObjects(c, { pgvector })).length === 0
    } catch {
      return false
    }
  }

  // A non-owner identity (the app's SP on a database another identity built)
  // may lack CREATE on the schema, or SELECT/INSERT on schema_migrations. With
  // only schema-transparent versions to apply (the baseline, the schema move)
  // and the baseline catalog complete, the app's queries work: warn and boot,
  // as 1.x did. With a newer migration pending the error surfaces.
  const tolerate = async (e) => {
    if (e?.code !== '42501' || !transparentOnly(migrations) || !(await complete())) return false
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
    if (await tolerate(e)) return { applied: [], adopted: false, skipped: true, deferred: [] }
    throw e
  }
  if (state.exists) {
    refuseMismatch(state)
    if (!state.pending.length) {
      warnUnknown(state, log)
      return { applied: [], adopted: false, skipped: false, deferred: [] }
    }
  }

  return withLock(c, lockWaitMs, async () => {
    try {
      if (!(await tableExists(c))) await inTransaction(c, ctx, () => c.query(CREATE_TABLE))
      state = await readState(c, migrations) // again, under the lock
    } catch (e) {
      if (await tolerate(e)) return { applied: [], adopted: false, skipped: true, deferred: [] }
      throw e
    }
    refuseMismatch(state)

    let pending = state.pending
    let adopted = false
    let missing = []
    if (!state.rows.length && pending[0]?.version === 1) {
      missing = await missingBaselineObjects(c, { pgvector })
      const wanted = baselineCatalog({ pgvector })
      const total = wanted.columns.length + wanted.indexes.length + wanted.constraints.length
      if (missing.length && missing.length < total) {
        log.log(
          `migrations: existing 1.x schema is incomplete (missing ${missing.length}: ${summary(missing)}); ` +
            `running ${label(pending[0])} (idempotent) instead of recording it`
        )
      }
    }
    if (!state.rows.length && pending[0]?.version === 1 && !missing.length) {
      const base = pending[0]
      try {
        await inTransaction(c, ctx, () =>
          c.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
            base.version,
            base.name,
            base.checksum,
          ])
        )
      } catch (e) {
        if (await tolerate(e)) return { applied: [], adopted: false, skipped: true, deferred: [] }
        throw e
      }
      adopted = true
      pending = pending.slice(1)
      log.log(`migrations: recorded ${label(base)} for an existing 1.x schema (no DDL run)`)
    }

    const newest = Math.max(0, ...state.rows.map((r) => Number(r.version)))
    const late = pending.filter((m) => m.version < newest)
    if (late.length) {
      log.warn(
        `migrations: applying out of order: ${late.map(label).join(', ')} after ${String(newest).padStart(4, '0')}; ` +
          'check that it does not depend on, or conflict with, the newer versions'
      )
    }
    const applied = []
    for (const m of pending) {
      try {
        await inTransaction(c, ctx, async () => {
          await c.query(m.up)
          await c.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
            m.version,
            m.name,
            m.checksum,
          ])
        })
      } catch (e) {
        if (e?.code === OWNERSHIP_NOT_NORMALIZED) {
          const rest = pending.filter((p) => p.version >= m.version)
          log.warn(
            `migrations: ${label(m)} deferred, the app keeps running on the current schema: ${e.message}` +
              (e.hint ? ` (${e.hint})` : '')
          )
          warnUnknown(state, log)
          return { applied, adopted, skipped: false, deferred: rest.map((p) => p.version) }
        }
        throw e
      }
      applied.push(m.version)
      log.log(`migrations: applied ${label(m)}`)
      if (m.version === 1) {
        // the idempotent baseline cannot fix everything on a drifted 1.x
        // schema (it never re-adds a dropped constraint, for instance)
        const still = await missingBaselineObjects(c, { pgvector })
        if (still.length) {
          log.warn(
            `migrations: after ${label(m)} the schema still differs from the baseline ` +
              `(missing or different ${still.length}: ${summary(still)}); fix it by hand or restore from a backup`
          )
        }
      }
    }
    warnUnknown(state, log)
    return { applied, adopted, skipped: false, deferred: [] }
  })
}

/**
 * Rolls back, newest first, every applied migration with version > to, each
 * in its own transaction with the removal of its schema_migrations row.
 * Returns { reverted: [versions] }. `to` is required: 0 rolls back everything
 * and then drops schema_migrations itself, leaving the schema empty.
 */
export async function migrateDown(
  c,
  { dir, to, pgvector = pgvectorEnabled(), log = console, lockWaitMs = MIGRATION_LOCK_WAIT_MS, ownerRole = ownerRoleName() } = {}
) {
  const target = typeof to === 'string' && to.trim() !== '' ? Number(to) : to
  if (!Number.isSafeInteger(target) || target < 0) {
    throw new MigrationError('MIGRATION_USAGE', 'migrations: down needs --to N (a version >= 0; 0 rolls back everything)')
  }
  const migrations = loadMigrations(dir)
  await pinSearchPath(c)
  const ctx = await runContext(c, { pgvector, ownerRole })
  return withLock(c, lockWaitMs, async () => {
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
      await inTransaction(c, ctx, async () => {
        await c.query(m.down)
        await c.query(`DELETE FROM schema_migrations WHERE version = $1`, [m.version])
      })
      reverted.push(m.version)
      log.log(`migrations: reverted ${label(m)}`)
    }
    if (target === 0) {
      const left = await c.query(`SELECT count(*)::int AS n FROM schema_migrations`)
      if (left.rows[0].n === 0) {
        await inTransaction(c, ctx, () => c.query(`DROP TABLE schema_migrations`))
        log.log('migrations: dropped schema_migrations (nothing applied)')
      }
    }
    return { reverted }
  })
}
