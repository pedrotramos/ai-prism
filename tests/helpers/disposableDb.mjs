// Guard + snapshot helpers for tests that WRITE to an org-wide table (model_catalog_overrides, ...).
//
// Those tables have no owner column, so a test that writes there on the persistent local dev database
// (`npm run local:up`: 127.0.0.1:55432 / ai_prism) would change the developer's real settings. Such a test
// must be skipped unless the database is disposable: a throwaway cluster on any other port, or the runner that
// created it exports AI_PRISM_TEST_DISPOSABLE_DB=1 (tests/run.mjs does when CI is set: the CI database is a
// per-job service container).
export const DEFAULT_PERSISTENT_PORT = 55432
export const DEFAULT_PERSISTENT_DB = 'ai_prism'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', ''])

const normHost = (h) => String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')

/**
 * The ONE place that turns the PG* environment into what the test clients connect to AND decides whether that
 * target may take org-wide writes, so the guard and the clients cannot diverge. `config` is a node-postgres
 * client config (port parsed with Number, as every client does); `skipReason` is null only for a disposable target.
 */
export function testDbTarget(env = process.env) {
  const rawPort = String(env.PGPORT ?? '').trim()
  const port = rawPort === '' ? 5432 : Number(rawPort) // unset: the pg default, never "unknown"
  const database = env.PGDATABASE || DEFAULT_PERSISTENT_DB
  const config = {
    host: env.PGHOST || '127.0.0.1',
    port,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database,
    ssl: false,
    connectionTimeoutMillis: 2000,
  }
  let skipReason = null
  if (env.AI_PRISM_TEST_DISPOSABLE_DB !== '1') {
    // another consumer of PGPORT (the app) may read it with parseInt: refuse if EITHER reading is the dev port
    const readings = [port, parseInt(rawPort, 10)]
    const isDevPort = readings.some((p) => p === DEFAULT_PERSISTENT_PORT)
    const isDevDb = String(database).trim().toLowerCase() === DEFAULT_PERSISTENT_DB
    if (!Number.isInteger(port) || port <= 0) skipReason = `PGPORT=${JSON.stringify(env.PGPORT)} is not a valid port`
    else if (isDevPort && isDevDb && LOCAL_HOSTS.has(normHost(config.host))) {
      skipReason = `refusing to write org-wide rows on the persistent dev database ${normHost(config.host) || '127.0.0.1'}:${DEFAULT_PERSISTENT_PORT}/${DEFAULT_PERSISTENT_DB}; use a throwaway cluster on another port or set AI_PRISM_TEST_DISPOSABLE_DB=1`
    }
  }
  return { config, skipReason }
}

/** Why this test must not write org-wide rows here, or null when the target is disposable. */
export function disposableDbSkipReason(env = process.env) {
  return testDbTarget(env).skipReason
}

/** Full rows of `table` for exactly these ids (search_path must resolve the table). */
export async function snapshotRows(c, table, idColumn, ids) {
  return (await c.query(`SELECT * FROM ${table} WHERE ${idColumn} = ANY($1)`, [ids])).rows
}

/** Puts `ids` back to `rows`: deletes only those ids, then re-inserts the snapshot rows byte for byte. */
export async function restoreRows(c, table, idColumn, ids, rows) {
  await c.query(`DELETE FROM ${table} WHERE ${idColumn} = ANY($1)`, [ids])
  for (const row of rows) {
    await c.query(`INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json)`, [JSON.stringify(row)])
  }
}
