// md-exfil T2: app_settings.external_asset_origins on a real Postgres. Read by everyone, written only with the admin flag
// (RLS, migration 0007), and the admin_audit row ('egress.settings') lands in the same transaction as the value.
// Same harness as server/mcpApps.rls.test.ts; skipped without a local Postgres with pgvector.
//
//   node --test server/db/egressSettings.rls.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { migrateUp } from './migrate.ts'
import { applyAppGrants, prepareOwnerHandoff } from './grants.ts'
import { readExternalAssetOrigins, writeExternalAssetOriginsTx, EXTERNAL_ASSET_ORIGINS_KEY } from './egressSettings.ts'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
const ADMIN_DB = env.PGDATABASE || 'ai_prism'
const SUPERUSER = env.PGUSER
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const createdDbs: string[] = []
const createdRoles: string[] = []
let seq = 0
const opts = (database: string, user: string = SUPERUSER) => ({ host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 })

async function skipReason(): Promise<string | null> {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as { code?: string }).code || (e as Error).message})`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false

async function admin(sql: string, database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql)
  } finally {
    await c.end().catch(() => {})
  }
}
async function role(kind: string, extra = '') {
  const name = `egr_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}
async function as<T>(database: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(opts(database, user))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}
const quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} }

after(async () => {
  if (SKIP) return
  for (const db of createdDbs) {
    await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`).catch(() => {})
    await admin(`DROP DATABASE IF EXISTS ${db}`).catch(() => {})
  }
  for (const r of createdRoles.reverse()) await admin(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
})

async function deployment() {
  const dep = await role('dep', 'CREATEROLE')
  const sp = await role('sp')
  const owner = `egr_owner_${stamp}_${++seq}`
  createdRoles.push(owner)
  const db = `egr_db_${stamp}_${++seq}`
  await admin(`CREATE DATABASE ${db} OWNER ${dep}`)
  createdDbs.push(db)
  await admin(`CREATE EXTENSION IF NOT EXISTS vector`, db)
  await as(db, dep, (c) => prepareOwnerHandoff(c, { role: sp, owner }))
  await as(db, sp, (c) => migrateUp(c, { log: quiet, ownerRole: owner }))
  await as(db, dep, (c) => applyAppGrants(c, { role: sp, owner } as any))
  return { db, sp }
}

// writeExternalAssetOrigins uses withTx (the pooled app identity); the RLS proof drives the same SQL through the SP role with
// the identity set the way withTx sets it.
async function asApp<T>(d: { db: string; sp: string }, who: { email: string; admin: boolean }, fn: (c: pg.Client) => Promise<T>) {
  return as(d.db, d.sp, async (c) => {
    await c.query('BEGIN')
    try {
      await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true)`, [who.email, who.admin ? 'on' : 'off'])
      const r = await fn(c)
      await c.query('COMMIT')
      return r
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}
const WRITE_SQL = `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ($1, $2::jsonb, 'h', NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`

test('everyone reads the key (absent = empty); only an admin writes it; a non-admin write fails at the database', { skip: SKIP }, async () => {
  const d = await deployment()
  const user = { email: 'bob@test.invalid', admin: false }
  const adm = { email: 'ana@test.invalid', admin: true }
  assert.deepEqual(await asApp(d, user, (c) => readExternalAssetOrigins(c)), [])
  await assert.rejects(asApp(d, user, (c) => c.query(WRITE_SQL, [EXTERNAL_ASSET_ORIGINS_KEY, JSON.stringify(['https://evil.example.com'])])), /row-level security|permission denied/i)
  await asApp(d, adm, (c) => c.query(WRITE_SQL, [EXTERNAL_ASSET_ORIGINS_KEY, JSON.stringify(['https://fonts.example.com', 'https://cdn.example.org'])]))
  assert.deepEqual(await asApp(d, user, (c) => readExternalAssetOrigins(c)), ['https://fonts.example.com', 'https://cdn.example.org'])
})

test('writeExternalAssetOrigins writes the value and ONE egress.settings audit row in one transaction', { skip: SKIP }, async () => {
  const d = await deployment()
  const adm = { email: 'ana@test.invalid', admin: true }
  // the transaction body of writeExternalAssetOrigins, on a client bound the way withTx binds it
  await asApp(d, adm, (c) => writeExternalAssetOriginsTx(c, adm.email, ['https://fonts.example.com']))
  const rows = await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    return (await c.query(`SELECT action, target, details FROM admin_audit WHERE action = 'egress.settings'`)).rows
  })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].details.origins, ['https://fonts.example.com'])
  // a refused write leaves no audit row behind
  await assert.rejects(asApp(d, { email: 'bob@test.invalid', admin: false }, (c) => writeExternalAssetOriginsTx(c, 'bob@test.invalid', ['https://evil.example.com'])))
  const after = await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    return (await c.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'egress.settings'`)).rows[0].n
  })
  assert.equal(after, 1)
})
