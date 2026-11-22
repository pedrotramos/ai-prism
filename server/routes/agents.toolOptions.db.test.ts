// W4-4e (QA r1, blocker 1): GET /api/agents/tool-options must FAIL CLOSED when the catalog cannot be read. The route runs
// with its REAL default dependencies against a scratch Postgres; the catalog table is renamed (restored in `finally`) so
// the read really throws. Before the fix the helper swallowed the error and the route answered 200 with a partial list.
// No Postgres with pgvector -> skipped.
//
//   node --test server/routes/agents.toolOptions.db.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { authed } from './authed.ts'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.LOCAL_PGVECTOR = '1'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME

const SUPERUSER = env.PGUSER
const ADMIN_DB = env.PGDATABASE
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const WHO = `toolopts-${stamp}@test.invalid`
const quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} }

const opts = (database: string | undefined) => ({ host: env.PGHOST, port: Number(env.PGPORT), user: SUPERUSER, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 })

async function skipReason(): Promise<string | null> {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as { code?: string; message?: string }).code || (e as Error).message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false

async function superuser(sql: string, database: string | undefined = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql)
  } finally {
    await c.end().catch(() => {})
  }
}

const DB = `w44e_toolopts_${stamp}`
if (!SKIP) {
  await superuser(`CREATE DATABASE ${DB}`)
  const c = new pg.Client(opts(DB))
  await c.connect()
  try {
    if (!(await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('../db/migrate.ts')
    const { applyAppGrants } = await import('../db/grants.ts')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet } as any) // any: JS option bag
    // one catalog row of each class the route must tell apart
    await c.query(
      `INSERT INTO ai_prism.app_mcp_catalog (service_name, display_name, description, hidden, credential_class, added_by)
       VALUES ('main.tools.sales', 'Sales', 'ok', false, 'databricks', 'x'), ('main.tools.mine', 'Mine', '', false, 'per_user', 'x')`
    )
  } finally {
    await c.end().catch(() => {})
  }
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
}

after(async () => {
  if (SKIP) return
  const db = await import('../db.ts')
  await (db as any).closePool?.().catch?.(() => {})
  await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()`).catch(() => {})
  await superuser(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {})
})

function fakeAuth(req: Request, _res: Response, next: NextFunction) {
  authed(req).email = WHO
  authed(req).token = 'fake-obo-token-not-a-secret'
  next()
}

test('tool-options with the real catalog read: 500 internal_error (no partial list) when the read throws, 200 once it works', { skip: SKIP }, async () => {
  const { default: registerAgentRoutes } = await import('./agents.ts')
  const app = express()
  registerAgentRoutes(app, { auth: fakeAuth, env: { AGENTS_ENABLED: '1' } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/tool-options`
  const get = async () => {
    const res = await fetch(url)
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text) }
  }
  let renamed = false
  try {
    const ok = await get()
    assert.equal(ok.status, 200, ok.text)
    assert.ok(ok.body.kinds.length > 0)

    await superuser(`ALTER TABLE ai_prism.app_mcp_catalog RENAME TO app_mcp_catalog_qa_hold`, DB)
    renamed = true
    await assert.rejects(superuser(`SELECT 1 FROM ai_prism.app_mcp_catalog`, DB), { code: '42P01' })
    // twice: a cached or stale catalog must not turn the second read into a 200 either
    for (let i = 0; i < 2; i++) {
      const r = await get()
      assert.equal(r.status, 500, r.text)
      assert.deepEqual(r.body, { error: 'internal_error', code: 'internal_error' })
      assert.ok(!('kinds' in r.body) && !('mcp' in r.body), 'no partial list')
    }
    await superuser(`ALTER TABLE ai_prism.app_mcp_catalog_qa_hold RENAME TO app_mcp_catalog`, DB)
    renamed = false
    const back = await get()
    assert.equal(back.status, 200, back.text)
    assert.deepEqual(back.body.mcp.map((m: { ref: string }) => m.ref), ['mcp:main.tools.sales'], 'databricks class only, once the read works again')
  } finally {
    if (renamed) await superuser(`ALTER TABLE ai_prism.app_mcp_catalog_qa_hold RENAME TO app_mcp_catalog`, DB)
    await new Promise((r) => server.close(r))
  }
})
