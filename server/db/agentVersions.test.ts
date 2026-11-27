// Agent versions (migration 0017): server/db/agentVersions.ts and the version side of server/db/agents.ts against a real
// Postgres, connected as the app role (so RLS binds it).
//
//   V1  every save is a version (create = v1, each edit the next); a save that changes nothing is not
//   V2  history is the owner's, newest first, paged; an agent saved before 0017 gets the row of its current revision
//   V3  a version cannot be changed or deleted by anyone; deleting the agent removes its history and its shares
//   V4  restore saves the old content as a NEW version (origin recorded); the history stays
//   V5  approval is per version: submit and decide on the agent carry to its current version; a version is decided on its own
//   V6  sharing: a share is inert until its version is approved; user, group and whole-app audiences; re-pinning; revoke unshares
//   V7  a recipient reads the approved, shared version only, and duplicates it as her own draft
//
// Scratch database on the local test server, db.js connected as ai_prism_app (scripts/ci/pg-roles.sql).
// No Postgres with pgvector -> skipped.
//
//   node --test server/db/agentVersions.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { AgentDefinition } from '../agents/definition.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')

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
const A = `dbv-a-${stamp}@test.invalid`
const B = `dbv-b-${stamp}@test.invalid`
const C = `dbv-c-${stamp}@test.invalid`
const BOSS = `dbv-boss-${stamp}@test.invalid`

function opts(database: string | undefined, user = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 }
}

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
const quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} }

let DB = ''
let raw: pg.Client
const createdDbs: string[] = []

async function superuser(sql: string, params: unknown[] = [], database: string | undefined = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

if (!SKIP) {
  DB = `av17_agents_${stamp}`
  await superuser(`CREATE DATABASE ${DB}`)
  createdDbs.push(DB)
  const c = new pg.Client(opts(DB))
  await c.connect()
  try {
    if (!(await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./migrate.ts')
    const { applyAppGrants } = await import('./grants.ts')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet } as any) // any: JS option bag
  } finally {
    await c.end().catch(() => {})
  }
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
}

after(async () => {
  if (SKIP) return
  await raw.end().catch(() => {})
  const db = await import('../db.ts')
  await (db as any).closePool?.().catch?.(() => {})
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const DEF: AgentDefinition = { instructions: 'i', prompt: 'p', model: 'm', reasoningEffort: null, tools: [], schedule: null, lang: 'en' }
const input = (name: string, over: Record<string, unknown> = {}, description = '') => ({ name, description, definition: { ...DEF, ...over } as any })
const mod = () => import('./agents.ts')
const vmod = () => import('./agentVersions.ts')
const hashOf = async (def: unknown) => (await import('../agents/definition.ts')).approvalHash(def as any)
const auditRows = async (target: string) => (await raw.query(`SELECT action, target, details FROM admin_audit WHERE target = $1 ORDER BY id`, [target])).rows

// the groups of each test identity, the way the SCIM resolver would answer
const GROUPS = new Map<string, string[]>()
const pool = await import('./pool.ts')
const previousResolver = SKIP ? null : pool.setTxGroupsResolver((email: string) => GROUPS.get(email) ?? [])
after(() => {
  if (!SKIP) pool.setTxGroupsResolver(previousResolver)
})

test('V1 every save is a version; a save that changes nothing is not', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('first'))
  assert.equal(a.revision, 1)
  let h = await v.listAgentVersions(A, null, a.id)
  assert.equal(h?.versions.length, 1)
  assert.equal(h?.versions[0]?.version, 1)
  assert.equal(h?.versions[0]?.createdBy, A)
  assert.equal(h?.versions[0]?.isHead, true)
  assert.equal(h?.versions[0]?.status, 'draft')
  assert.equal(h?.versions[0]?.origin, null)
  const b = (await m.updateAgent(A, null, a.id, { name: 'first', description: '', definition: { ...DEF, prompt: 'two' } }, { revision: 1 })) as any
  assert.equal(b.revision, 2)
  const c = (await m.updateAgent(A, null, a.id, { name: 'renamed', description: 'd', definition: { ...DEF, prompt: 'two' } }, { revision: 2 })) as any
  assert.equal(c.revision, 3, 'a rename alone is a version')
  // nothing changed: the same row comes back, no new revision, no new version
  const same = (await m.updateAgent(A, null, a.id, { name: 'renamed', description: 'd', definition: { ...DEF, prompt: 'two' } }, { revision: 3 })) as any
  assert.equal(same.revision, 3)
  h = await v.listAgentVersions(A, null, a.id)
  assert.deepEqual(h?.versions.map((x) => x.version), [3, 2, 1], 'newest first')
  assert.deepEqual(h?.versions.map((x) => x.isHead), [true, false, false])
  assert.equal(h?.versions[2]?.name, 'first')
  assert.equal(h?.versions[2]?.definition.prompt, 'p', 'v1 keeps the content it was saved with')
  assert.equal(h?.versions[1]?.definition.prompt, 'two')
  assert.equal(h?.versions[0]?.name, 'renamed')
  assert.equal(await m.updateAgent(A, null, a.id, { name: 'x', description: '', definition: DEF as any }, { revision: 2 }), 'conflict')
  assert.equal((await v.listAgentVersions(A, null, a.id))?.versions.length, 3, 'a conflict saves nothing')
})

test('V2 history is the owner\'s and is paged; an agent saved before the migration gets its head row on first use', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('paged'))
  for (let i = 0; i < 4; i++) await m.updateAgent(A, null, a.id, { name: 'paged', description: '', definition: { ...DEF, prompt: `p${i}` } as any }, { revision: i + 1 })
  const p1 = await v.listAgentVersions(A, null, a.id, { limit: 2 })
  assert.deepEqual(p1?.versions.map((x) => x.version), [5, 4])
  assert.equal(p1?.hasMore, true)
  const p2 = await v.listAgentVersions(A, null, a.id, { limit: 2, before: 4 })
  assert.deepEqual(p2?.versions.map((x) => x.version), [3, 2])
  const p3 = await v.listAgentVersions(A, null, a.id, { limit: 2, before: 2 })
  assert.deepEqual(p3?.versions.map((x) => x.version), [1])
  assert.equal(p3?.hasMore, false)
  assert.equal(await v.listAgentVersions(B, null, a.id), null, 'B: not found, not an error')

  // a legacy agent: inserted without a version row, at revision 4
  const legacy = (await raw.query(`INSERT INTO agents (owner_email, name, definition, revision, updated_at) VALUES ($1, 'legacy', $2::jsonb, 4, now() - interval '3 days') RETURNING id`, [A, JSON.stringify(DEF)])).rows[0].id as string
  assert.equal((await raw.query(`SELECT 1 FROM agent_versions WHERE agent_id = $1`, [legacy])).rowCount, 0)
  const h = await v.listAgentVersions(A, null, String(legacy))
  assert.deepEqual(h?.versions.map((x) => x.version), [4], 'history starts at the revision the agent was at')
  const age = Date.now() - Date.parse(h!.versions[0]!.createdAt)
  assert.ok(age > 2.9 * 86400_000, 'the row says when the agent was last saved, not when the history was first opened')
  const next = (await m.updateAgent(A, null, String(legacy), { name: 'legacy', description: '', definition: { ...DEF, prompt: 'new' } as any }, { revision: 4 })) as any
  assert.equal(next.revision, 5)
  assert.deepEqual((await v.listAgentVersions(A, null, String(legacy)))?.versions.map((x) => x.version), [5, 4], 'no duplicate, no gap')
  // an edit of a legacy agent that was never listed first also keeps both ends
  const legacy2 = (await raw.query(`INSERT INTO agents (owner_email, name, definition, revision) VALUES ($1, 'legacy2', $2::jsonb, 2) RETURNING id`, [A, JSON.stringify(DEF)])).rows[0].id as string
  await m.updateAgent(A, null, String(legacy2), { name: 'legacy2', description: '', definition: { ...DEF, prompt: 'z' } as any }, { revision: 2 })
  assert.deepEqual((await v.listAgentVersions(A, null, String(legacy2)))?.versions.map((x) => x.version), [3, 2])
})

test('V3 a saved version cannot change or be deleted, by anyone; deleting the agent takes its history and shares with it', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('frozen'))
  await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: B })
  // the app role as the owner, through the module's own path: nothing but an UPDATE of a column the module never writes
  const { withTx } = await import('./pool.ts')
  for (const sql of [`UPDATE agent_versions SET definition = '{"x":1}'::jsonb WHERE agent_id = $1`, `UPDATE agent_versions SET name = 'pwn' WHERE agent_id = $1`, `UPDATE agent_versions SET version = 9 WHERE agent_id = $1`, `UPDATE agent_versions SET created_by = 'x' WHERE agent_id = $1`, `UPDATE agent_versions SET origin = '{}'::jsonb WHERE agent_id = $1`]) {
    await assert.rejects(withTx(A, null, (c) => c.query(sql, [a.id])), /a saved version cannot change/, sql)
  }
  // even the admin flag and the seed identity (admin, no user) cannot
  await assert.rejects(withTx(BOSS, null, (c) => c.query(`UPDATE agent_versions SET definition = '{"x":1}'::jsonb WHERE agent_id = $1`, [a.id]), { admin: true }), /a saved version cannot change/)
  await raw.query('BEGIN')
  await raw.query(`SELECT set_config('app.is_admin', 'on', true)`)
  await assert.rejects(raw.query(`UPDATE agent_versions SET name = 'seed' WHERE agent_id = $1`, [a.id]), /a saved version cannot change/)
  await raw.query('ROLLBACK')
  // no delete policy: the owner deletes nothing
  assert.equal((await withTx(A, null, (c) => c.query(`DELETE FROM agent_versions WHERE agent_id = $1`, [a.id]))).rowCount, 0)
  // numbers only go up
  await assert.rejects(withTx(A, null, (c) => c.query(`INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by) VALUES ($1, 1, $2, 'dup', '{}'::jsonb, $2)`, [a.id, A])), /agent_versions_unique|increasing order/)
  assert.equal((await raw.query(`SELECT count(*)::int n FROM agent_versions WHERE agent_id = $1`, [a.id])).rows[0].n, 1)
  // the cascade
  assert.equal(await m.deleteAgent(A, null, a.id), true)
  assert.equal((await raw.query(`SELECT count(*)::int n FROM agent_versions WHERE agent_id = $1`, [a.id])).rows[0].n, 0)
  assert.equal((await raw.query(`SELECT count(*)::int n FROM agent_shares WHERE agent_id = $1`, [a.id])).rows[0].n, 0)
})

test('V4 restore saves the old content as a new version and keeps the whole history', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('rest', { prompt: 'original' }))
  await m.updateAgent(A, null, a.id, { name: 'rest', description: '', definition: { ...DEF, prompt: 'edited' } as any }, { revision: 1 })
  const old = await v.getVersionForUse(A, null, a.id, 1)
  assert.equal(old?.definition.prompt, 'original')
  const back = (await m.updateAgent(A, null, a.id, { name: old!.name, description: old!.description, definition: old!.definition }, { revision: 2, origin: { kind: 'restore', agentId: a.id, version: 1 } })) as any
  assert.equal(back.revision, 3)
  assert.equal(back.definition.prompt, 'original')
  const h = await v.listAgentVersions(A, null, a.id)
  assert.deepEqual(h?.versions.map((x) => x.version), [3, 2, 1])
  assert.deepEqual(h?.versions[0]?.origin, { kind: 'restore', agentId: a.id, version: 1 })
  assert.equal(h?.versions[1]?.definition.prompt, 'edited', 'the version that was replaced is still there')
  // restoring what is already current is not a new version
  const again = (await m.updateAgent(A, null, a.id, { name: old!.name, description: old!.description, definition: old!.definition }, { revision: 3, origin: { kind: 'restore', agentId: a.id, version: 1 } })) as any
  assert.equal(again.revision, 3)
})

test('V5 approval is per version: the agent\'s submit and decision carry to its current version, a version is also decided alone', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('appr'))
  await m.updateAgent(A, null, a.id, { name: 'appr', description: '', definition: { ...DEF, prompt: 'v2' } as any }, { revision: 1 })
  // the agent's submit moves its current version (2) to pending, not v1
  assert.equal((await m.submitAgent(A, null, a.id))?.status, 'pending')
  let h = (await v.listAgentVersions(A, null, a.id))!.versions
  assert.deepEqual(h.map((x) => x.status), ['pending', 'draft'])
  // v2 is the head of a pending agent: it is decided on the agent card
  assert.equal(await v.decideAgentVersion(BOSS, null, a.id, 2, { decision: 'approve', expectedHash: await hashOf(h[0]!.definition) }), 'agent_pending')
  const def2 = h[0]!.definition
  const done = (await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: await hashOf(def2) })) as any
  assert.equal(done.status, 'approved')
  h = (await v.listAgentVersions(A, null, a.id))!.versions
  assert.deepEqual(h.map((x) => x.status), ['approved', 'draft'], 'the approved agent carried its version with it')
  assert.ok(h[0]!.approvedAt)
  // an edit voids the SCHEDULING approval (0015) and leaves v2\'s sharing approval where it was: the content it covers did not change
  const v3 = (await m.updateAgent(A, null, a.id, { name: 'appr', description: '', definition: { ...DEF, prompt: 'v3' } as any }, { revision: 2 })) as any
  assert.equal(v3.status, 'draft')
  h = (await v.listAgentVersions(A, null, a.id))!.versions
  assert.deepEqual(h.map((x) => [x.version, x.status]), [[3, 'draft'], [2, 'approved'], [1, 'draft']])
  // v1 on its own: submit, stale hash, approve, audit row
  assert.equal((await v.submitAgentVersion(A, null, a.id, 1))?.status, 'pending')
  assert.equal(await v.submitAgentVersion(A, null, a.id, 1), null, 'already pending')
  assert.equal(await v.submitAgentVersion(B, null, a.id, 1), null, 'not B\'s')
  const auditBefore = (await auditRows(`agent:${a.id}:v1`)).length
  assert.equal(await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'approve', expectedHash: 'f'.repeat(64) }), 'stale')
  assert.equal((await auditRows(`agent:${a.id}:v1`)).length, auditBefore, 'a stale decision writes nothing')
  const ok = (await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'approve', expectedHash: await hashOf(DEF) })) as any
  assert.equal(ok.status, 'approved')
  assert.equal(ok.previous, null)
  assert.equal(ok.agentStatus, 'draft')
  const rows = await auditRows(`agent:${a.id}:v1`)
  assert.equal(rows.length - auditBefore, 1)
  assert.equal(rows.at(-1).action, 'agent.version.approve')
  assert.ok(!JSON.stringify(rows.at(-1)).includes(BOSS))
  // the review row of v3 says what the previous approved version was
  await v.submitAgentVersion(A, null, a.id, 3)
  const queue = await v.listVersionsForReview(BOSS, null, { status: 'pending' })
  const q3 = queue.find((x) => x.agentId === a.id && x.version === 3)!
  assert.equal(q3.previous?.version, 2)
  assert.equal(q3.previous?.definition.prompt, 'v2')
  assert.equal(q3.currentHash, await hashOf(q3.definition))
  assert.equal(q3.ownerEmail, A)
  // reject needs a pending version; revoke needs approved or pending
  assert.equal(await v.decideAgentVersion(BOSS, null, a.id, 2, { decision: 'reject', expectedHash: '', reason: 'no' }), 'stale')
  const rev = (await v.decideAgentVersion(BOSS, null, a.id, 2, { decision: 'revoke', expectedHash: '', reason: 'offboarded' })) as any
  assert.equal(rev.status, 'revoked')
  assert.equal(rev.decisionReason, 'offboarded')
  assert.equal(await v.decideAgentVersion(BOSS, null, '999999999', 1, { decision: 'revoke', expectedHash: '' }), null)
  // the agent's own reject and revoke carry the same way
  const b = await m.createAgent(A, null, input('appr2'))
  await m.submitAgent(A, null, b.id)
  await m.decideAgent(BOSS, null, b.id, { decision: 'reject', expectedHash: await hashOf(DEF), reason: 'too broad' })
  assert.equal((await v.listAgentVersions(A, null, b.id))?.versions[0]?.status, 'rejected')
  await m.submitAgent(A, null, b.id)
  await m.decideAgent(BOSS, null, b.id, { decision: 'approve', expectedHash: await hashOf(DEF) })
  await m.decideAgent(BOSS, null, b.id, { decision: 'revoke', expectedHash: '', reason: 'x' })
  assert.equal((await v.listAgentVersions(A, null, b.id))?.versions[0]?.status, 'revoked')
})

test('V6 sharing: a share is inert until its version is approved; user, group and whole-app audiences; re-pinning; revoke unshares', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  GROUPS.set(B, ['finance-team'])
  const a = await m.createAgent(A, null, input('shared', { prompt: 'one' }, 'for the team'))
  await m.updateAgent(A, null, a.id, { name: 'shared', description: 'for the team', definition: { ...DEF, prompt: 'two' } as any }, { revision: 1 })
  // an unapproved version shared with B: B sees nothing
  const s1 = await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: B })
  assert.ok(s1 && s1 !== 'limit' && s1 !== 'no_version')
  assert.deepEqual(await v.listSharedWithMe(B, null), [])
  assert.equal(await v.getVersionForUse(B, null, a.id, 1), null)
  // approved: B sees v1, not the newer v2 that nobody shared
  await v.submitAgentVersion(A, null, a.id, 1)
  await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'approve', expectedHash: await hashOf({ ...DEF, prompt: 'one' }) })
  const seen = await v.listSharedWithMe(B, null)
  assert.deepEqual(seen.map((x) => [x.agentId, x.version, x.name, x.ownerEmail]), [[a.id, 1, 'shared', A]])
  assert.equal(seen[0]?.definition.prompt, 'one')
  assert.equal((await v.getVersionForUse(B, null, a.id, null))?.version, 1, 'no version asked: the newest one shared with her')
  assert.equal(await v.getVersionForUse(B, null, a.id, 2), null, 'v2 is not shared')
  assert.equal(await v.listAgentVersions(B, null, a.id), null, 'a recipient has no history')
  assert.equal(await v.listAgentShares(B, null, a.id), null)
  assert.deepEqual(await v.listSharedWithMe(C, null), [], 'C: nobody shared it with her')
  assert.deepEqual(await v.listSharedWithMe(A, null), [], 'the owner does not see her own agent as shared with her')
  // a recipient cannot share, and the owner cannot pin someone else's agent
  assert.equal(await v.upsertAgentShare(B, null, a.id, { version: 1, kind: 'app', principal: '*' }), null)
  assert.equal(await v.upsertAgentShare(A, null, a.id, { version: 9, kind: 'app', principal: '*' }), 'no_version')
  // by group, with the group a SCIM answer
  await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'group', principal: 'finance-team' })
  GROUPS.set(C, ['other'])
  assert.deepEqual(await v.listSharedWithMe(C, null), [])
  GROUPS.set(C, ['Finance-Team'])
  assert.equal((await v.listSharedWithMe(C, null)).length, 1, 'group names are case-insensitive')
  GROUPS.delete(C)
  assert.deepEqual(await v.listSharedWithMe(C, null), [], 'no groups, no access')
  // whole app: anybody with an identity
  await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'app', principal: '*' })
  assert.equal((await v.listSharedWithMe(C, null)).length, 1)
  assert.deepEqual(await v.listSharedWithMe('', null), [], 'no identity, nothing')
  // re-pin B to v2, which is not approved: B loses it (the app share still pins v1 and B matches it, so B still reads v1)
  const re = await v.upsertAgentShare(A, null, a.id, { version: 2, kind: 'user', principal: B })
  assert.equal((re as any).version, 2)
  assert.equal((await v.listAgentShares(A, null, a.id))?.length, 3, 're-pinning does not add a row')
  assert.equal((await v.listSharedWithMe(B, null))[0]?.version, 1)
  // remove the app and group shares: now B holds only the pin on the unapproved v2
  assert.equal(await v.removeAgentShare(A, null, a.id, 'app', '*'), true)
  assert.equal(await v.removeAgentShare(A, null, a.id, 'group', 'finance-team'), true)
  assert.equal(await v.removeAgentShare(A, null, a.id, 'group', 'finance-team'), false)
  assert.deepEqual(await v.listSharedWithMe(B, null), [])
  // the owner's list says which version each audience holds
  const h = (await v.listAgentVersions(A, null, a.id))!.versions
  assert.deepEqual(h.find((x) => x.version === 2)?.shares.map((s) => [s.kind, s.principal]), [['user', B]])
  assert.deepEqual(h.find((x) => x.version === 1)?.shares, [])
  // approving the version B is pinned to brings it to her; revoking it takes it away at once
  await v.submitAgentVersion(A, null, a.id, 2)
  await v.decideAgentVersion(BOSS, null, a.id, 2, { decision: 'approve', expectedHash: await hashOf({ ...DEF, prompt: 'two' }) })
  assert.deepEqual((await v.listSharedWithMe(B, null)).map((x) => [x.agentId, x.version]), [[a.id, 2]])
  await v.decideAgentVersion(BOSS, null, a.id, 2, { decision: 'revoke', expectedHash: '' })
  assert.deepEqual(await v.listSharedWithMe(B, null), [])
})

test('V6b revoke removes access at once, and the share cap is enforced', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('revoked-share'))
  await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: B })
  await v.submitAgentVersion(A, null, a.id, 1)
  await m.updateAgent(A, null, a.id, { name: 'revoked-share', description: '', definition: { ...DEF, prompt: 'next' } as any }, { revision: 1 })
  await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'approve', expectedHash: await hashOf(DEF) })
  const mine = async () => (await v.listSharedWithMe(B, null)).filter((x) => x.agentId === a.id)
  assert.equal((await mine()).length, 1)
  await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'revoke', expectedHash: '', reason: 'no longer' })
  assert.deepEqual(await mine(), [], 'revoked: gone for the recipient')
  assert.equal((await v.listAgentShares(A, null, a.id))?.length, 1, 'the owner\'s row stays, inert')
  // approving again brings it back with no new share
  await v.submitAgentVersion(A, null, a.id, 1)
  await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'approve', expectedHash: await hashOf(DEF) })
  assert.equal((await mine()).length, 1)
  // the cap
  const { AGENT_LIMITS } = await import('../agents/definition.ts')
  for (let i = 0; i < AGENT_LIMITS.sharesPerAgent - 1; i++) await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: `u${i}-${stamp}@test.invalid` })
  assert.equal(await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: `over-${stamp}@test.invalid` }), 'limit')
  assert.ok((await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: B })) !== 'limit', 'moving an existing pin is never refused by the cap')
})

test('V7 a recipient copies the shared version as her own draft; the copy is hers and starts unapproved', { skip: SKIP }, async () => {
  const m = await mod()
  const v = await vmod()
  const a = await m.createAgent(A, null, input('to-copy', { prompt: 'shared prompt' }, 'desc'))
  await v.upsertAgentShare(A, null, a.id, { version: 1, kind: 'user', principal: C })
  await v.submitAgentVersion(A, null, a.id, 1)
  await v.decideAgentVersion(BOSS, null, a.id, 1, { decision: 'approve', expectedHash: await hashOf({ ...DEF, prompt: 'shared prompt' }) })
  const src = await v.getVersionForUse(C, null, a.id, null)
  assert.ok(src)
  const copy = await m.createAgent(C, null, { name: 'Copy of to-copy', description: src!.description, definition: src!.definition }, { kind: 'shared', agentId: src!.agentId, version: src!.version })
  assert.equal(copy.ownerEmail, C)
  assert.equal(copy.status, 'draft')
  assert.equal(copy.revision, 1)
  const h = await v.listAgentVersions(C, null, copy.id)
  assert.deepEqual(h?.versions[0]?.origin, { kind: 'shared', agentId: a.id, version: 1 })
  assert.equal(h?.versions[0]?.definition.prompt, 'shared prompt')
  // the original owner's history is untouched, and she does not see C's copy
  assert.equal((await v.listAgentVersions(A, null, a.id))?.versions.length, 1)
  assert.equal(await v.listAgentVersions(A, null, copy.id), null)
})
