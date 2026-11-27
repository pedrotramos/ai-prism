// A pre-existing, admin-customized override of a CURATED image model must survive both image-model route tests
// (QA r3). Runs tests/routes/imageModels.test.mjs and tests/routes/imageModelsCleanup.test.mjs as child
// processes around that row. Skipped on the persistent dev database (tests/helpers/disposableDb.mjs).
//
//   node --test tests/routes/imageModelsPreservation.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { disposableDbSkipReason, snapshotRows, restoreRows } from '../helpers/disposableDb.mjs'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
const dbOpts = { host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 }

async function skipReason() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const disposable = disposableDbSkipReason(env)
  if (disposable) return disposable
  const c = new pg.Client(dbOpts)
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false

// NODE_TEST_CONTEXT would make a nested `node --test` report to this runner and exit 0 whatever happened
const run = (file) => {
  const e = { ...env, RATE_LIMIT_API_PER_MIN: '0' }
  delete e.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--test', file], { env: e, encoding: 'utf8', timeout: 240000 })
}

for (const file of ['tests/routes/imageModels.test.mjs', 'tests/routes/imageModelsCleanup.test.mjs']) {
  test(`${file} leaves a pre-existing curated image override exactly as it was`, { skip: SKIP }, async () => {
    const { MODELS } = await import('../../server/llm.ts')
    const id = MODELS.find((m) => m.modality === 'image').id
    assert.equal(run('tests/routes/imageModels.test.mjs').status, 0, 'first run (also creates the schema)')
    const c = new pg.Client(dbOpts)
    await c.connect()
    await c.query('SET search_path TO ai_prism, public')
    const original = await snapshotRows(c, 'model_catalog_overrides', 'endpoint_id', [id])
    try {
      await c.query(
        `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, sort_order, price_in) VALUES ($1, true, 'Admin name', 5, 1.5)
         ON CONFLICT (endpoint_id) DO UPDATE SET enabled = true, display_name = 'Admin name', sort_order = 5, price_in = 1.5`,
        [id]
      )
      const before = await snapshotRows(c, 'model_catalog_overrides', 'endpoint_id', [id])
      const r = run(file)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.deepEqual(await snapshotRows(c, 'model_catalog_overrides', 'endpoint_id', [id]), before)
    } finally {
      await restoreRows(c, 'model_catalog_overrides', 'endpoint_id', [id], original).catch(() => {})
      await c.end().catch(() => {})
    }
  })
}
