// /api/image-models guard: PUT /selected answers 400 for an id outside the enabled set; IMAGE_GENERATION=off
// empties the list. Real app on the fake gateway and the local Postgres (skipped without it).
//
//   node --test tests/routes/imageModels.test.mjs
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.LOCAL_PGVECTOR = '1'
env.APPKIT_BOOT = '1'
env.RATE_LIMIT_API_PER_MIN = '0'
env.RATE_LIMIT_TURNS_PER_MIN = '0'
delete env.IMAGE_GENERATION
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL

const USER = `imgguard-${Date.now().toString(36)}@test.invalid`
env.APP_OWNER_EMAIL = USER // the test user is the app admin (model catalog is org-wide)
async function skipReason() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 })
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
let gw, server, base

// model_catalog_overrides is ORG-WIDE (no user_email): this file must leave every row it touches exactly as it
// found it. `touched` = the curated image ids plus any existing image-modality row; they are snapshotted in
// `before`, cleared (so the run starts from the fresh-install state) and put back, byte for byte, in `after`.
let touched = []
let snapshot = []
const withDb = async (fn) => {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    await c.query('SET search_path TO ai_prism, public')
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}
async function snapshotAndClear() {
  const { MODELS } = await import('../../server/llm.ts')
  const { deriveModality } = await import('../../server/serving.ts')
  await withDb(async (c) => {
    const all = (await c.query('SELECT * FROM model_catalog_overrides')).rows
    const ids = new Set(MODELS.filter((m) => m.modality === 'image').map((m) => m.id))
    for (const r of all) if (deriveModality(r.endpoint_id) === 'image') ids.add(r.endpoint_id)
    touched = [...ids]
    snapshot = all.filter((r) => ids.has(r.endpoint_id))
    await c.query('DELETE FROM model_catalog_overrides WHERE endpoint_id = ANY($1)', [touched])
  })
}
async function restore() {
  if (!touched.length) return
  await withDb(async (c) => {
    await c.query('DELETE FROM model_catalog_overrides WHERE endpoint_id = ANY($1)', [touched])
    for (const row of snapshot) {
      await c.query('INSERT INTO model_catalog_overrides SELECT * FROM json_populate_record(NULL::model_catalog_overrides, $1::json)', [JSON.stringify(row)])
    }
  })
}

before(async () => {
  if (SKIP) return
  const { startFakeGateway } = await import('../../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
  const { app } = await import('../../server/index.js')
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)))
  base = `http://127.0.0.1:${server.address().port}`
  await call('GET', '/api/image-models') // ensureReady: creates the schema on a fresh database
  await snapshotAndClear()
})
after(async () => {
  if (server) await new Promise((r) => (server.close(r), server.closeAllConnections()))
  await gw?.close()
  delete env.IMAGE_GENERATION
  if (!SKIP) await restore()
})

const call = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'x-forwarded-email': USER, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

test('PUT /api/image-models/selected: 400 for an id outside the enabled set, 200 for an enabled one', { skip: SKIP }, async () => {
  const list = await call('GET', '/api/image-models')
  assert.equal(list.status, 200)
  assert.ok(list.body.models.length > 0)
  const bad = await call('PUT', '/api/image-models/selected', { modelId: 'not-an-enabled-image-model' })
  assert.equal(bad.status, 400)
  const ok = await call('PUT', '/api/image-models/selected', { modelId: list.body.models[0].id })
  assert.equal(ok.status, 200)
  assert.equal((await call('GET', '/api/image-models')).body.selected, list.body.models[0].id)
})

test('IMAGE_GENERATION=off: GET /api/image-models is empty and PUT is refused', { skip: SKIP }, async () => {
  env.IMAGE_GENERATION = 'off'
  try {
    const list = await call('GET', '/api/image-models')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.models, [])
    assert.equal((await call('PUT', '/api/image-models/selected', { modelId: 'databricks-gemini-3-1-flash-image' })).status, 400)
  } finally {
    delete env.IMAGE_GENERATION
  }
})

test('admin disabling every image model: GET is empty and PUT selected is 400', { skip: SKIP }, async () => {
  try {
    for (const id of touched) {
      const r = await call('PUT', `/api/admin/model-endpoints/${encodeURIComponent(id)}`, { enabled: false })
      assert.equal(r.status, 200)
    }
    const list = await call('GET', '/api/image-models')
    assert.deepEqual(list.body.models, [])
    assert.equal(list.body.defaultId, null)
    assert.equal((await call('PUT', '/api/image-models/selected', { modelId: 'databricks-gemini-3-1-flash-image' })).status, 400)
  } finally {
    // back to the fresh-install state for any later test here; `after` restores the original rows
    await withDb((c) => c.query('DELETE FROM model_catalog_overrides WHERE endpoint_id = ANY($1)', [touched]))
  }
})
