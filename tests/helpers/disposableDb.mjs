// Guard + snapshot helpers for tests that WRITE to an org-wide table (model_catalog_overrides, ...).
//
// Those tables have no owner column, so a test that writes there on the persistent local dev database
// (`npm run local:up`: 127.0.0.1:55432 / ai_prism) would change the developer's real settings. Such a test
// must be skipped unless the database is disposable: a throwaway cluster on any other port, or the runner that
// created it exports AI_PRISM_TEST_DISPOSABLE_DB=1 (tests/run.mjs does when CI is set: the CI database is a
// per-job service container).
export const DEFAULT_PERSISTENT_PORT = '55432'
export const DEFAULT_PERSISTENT_DB = 'ai_prism'

/** Why this test must not write org-wide rows here, or null when the target is disposable. */
export function disposableDbSkipReason(env = process.env) {
  if (env.AI_PRISM_TEST_DISPOSABLE_DB === '1') return null
  const port = String(env.PGPORT || DEFAULT_PERSISTENT_PORT)
  const db = env.PGDATABASE || DEFAULT_PERSISTENT_DB
  if (port === DEFAULT_PERSISTENT_PORT && db === DEFAULT_PERSISTENT_DB) {
    return `refusing to write org-wide rows on the persistent dev database ${env.PGHOST || '127.0.0.1'}:${port}/${db}; use a throwaway cluster on another port or set AI_PRISM_TEST_DISPOSABLE_DB=1`
  }
  return null
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
