// The image-models route test shares the org-wide model_catalog_overrides table: it must leave every row that
// existed before it ran exactly as it was (QA r2). Runs that test as a child process around a sentinel row.
//
//   node --test tests/routes/imageModelsCleanup.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { testDbTarget, snapshotRows, restoreRows } from '../helpers/disposableDb.mjs'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
// guard and clients share ONE parse of the PG* env (tests/helpers/disposableDb.mjs)
const target = testDbTarget(env)
const dbOpts = target.config

async function skipReason() {
  if (target.skipReason) return target.skipReason
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
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

const SENTINEL = 'imgguard-sentinel-disabled-image'
// NODE_TEST_CONTEXT would make the nested `node --test` report to this runner and exit 0 whatever happened
const childEnv = () => {
  const e = { ...env, RATE_LIMIT_API_PER_MIN: '0' }
  delete e.NODE_TEST_CONTEXT
  return e
}
const runRouteTest = () =>
  spawnSync(process.execPath, ['--test', 'tests/routes/imageModels.test.mjs'], { env: childEnv(), encoding: 'utf8', timeout: 120000 })

const T = 'model_catalog_overrides'
const open = async () => {
  const c = new pg.Client(dbOpts)
  await c.connect()
  await c.query('SET search_path TO ai_prism, public')
  return c
}

test('imageModels route test leaves pre-existing model_catalog_overrides rows untouched', { skip: SKIP }, async () => {
  assert.equal(runRouteTest().status, 0, 'first run (also creates the schema)')
  const c = await open()
  const original = await snapshotRows(c, T, 'endpoint_id', [SENTINEL])
  try {
    await c.query(
      `INSERT INTO ${T} (endpoint_id, enabled, display_name, sort_order) VALUES ($1, false, 'Sentinel', 77)
       ON CONFLICT (endpoint_id) DO UPDATE SET enabled = false, display_name = 'Sentinel', sort_order = 77`,
      [SENTINEL]
    )
    const before = await snapshotRows(c, T, 'endpoint_id', [SENTINEL])
    assert.equal(before.length, 1)
    const run = runRouteTest()
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.deepEqual(await snapshotRows(c, T, 'endpoint_id', [SENTINEL]), before, 'the route test deleted or changed a row it did not create')
  } finally {
    await restoreRows(c, T, 'endpoint_id', [SENTINEL], original).catch(() => {})
    await c.end().catch(() => {})
  }
})

test('imageModels route test restores a pre-existing row of a curated image model exactly', { skip: SKIP }, async () => {
  const { MODELS } = await import('../../server/llm.ts')
  const id = MODELS.find((m) => m.modality === 'image').id
  assert.equal(runRouteTest().status, 0)
  const c = await open()
  // the curated row is snapshotted before the first write and put back exactly in `finally`
  const original = await snapshotRows(c, T, 'endpoint_id', [id])
  try {
    await c.query(
      `INSERT INTO ${T} (endpoint_id, enabled, display_name, sort_order, price_in) VALUES ($1, true, 'Admin name', 5, 1.5)
       ON CONFLICT (endpoint_id) DO UPDATE SET enabled = true, display_name = 'Admin name', sort_order = 5, price_in = 1.5`,
      [id]
    )
    const before = await snapshotRows(c, T, 'endpoint_id', [id])
    assert.equal(runRouteTest().status, 0)
    assert.deepEqual(await snapshotRows(c, T, 'endpoint_id', [id]), before)
  } finally {
    await restoreRows(c, T, 'endpoint_id', [id], original).catch(() => {})
    await c.end().catch(() => {})
  }
})
