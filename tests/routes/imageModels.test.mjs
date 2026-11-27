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

before(async () => {
  if (SKIP) return
  const { startFakeGateway } = await import('../../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
  const { app } = await import('../../server/index.js')
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  if (server) await new Promise((r) => (server.close(r), server.closeAllConnections()))
  await gw?.close()
  delete env.IMAGE_GENERATION
  if (!SKIP) await cleanup()
})

async function cleanup() {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    await c.query(`DELETE FROM ai_prism.model_catalog_overrides WHERE endpoint_id LIKE '%image%'`)
  } finally {
    await c.end().catch(() => {})
  }
}

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
  const { MODELS } = await import('../../server/llm.ts')
  try {
    for (const m of MODELS.filter((x) => x.modality === 'image')) {
      const r = await call('PUT', `/api/admin/model-endpoints/${encodeURIComponent(m.id)}`, { enabled: false })
      assert.equal(r.status, 200)
    }
    const list = await call('GET', '/api/image-models')
    assert.deepEqual(list.body.models, [])
    assert.equal(list.body.defaultId, null)
    assert.equal((await call('PUT', '/api/image-models/selected', { modelId: 'databricks-gemini-3-1-flash-image' })).status, 400)
  } finally {
    await cleanup()
  }
})
