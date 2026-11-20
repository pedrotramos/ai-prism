// Projects under row-level security (W2-3, migration 0005), proven AT THE
// DATABASE: every check below is raw SQL sent by the app role (ai_prism_app:
// not the owner, no BYPASSRLS, scripts/ci/pg-roles.sql) with the transaction
// identity set exactly as server/db/pool.js withTx sets it. No app code runs,
// so a pass here means the policies alone keep the data apart.
//
// What is proven:
//   - a project member (owner / manage / view, directly or through a SCIM
//     group) reads a project chat another member created: the session, its
//     messages, tool calls, compactions, Genie conversations and embeddings;
//   - a non-member reads nothing of it, nor of the project, its members or files;
//   - app admins get NO implicit access (app.is_admin = 'on' changes nothing);
//   - an empty identity never matches (AC-P1), even with a group list set;
//   - a group grant needs the group in app.user_groups; a malformed list = none;
//   - a member of one project gets nothing of another project (no nesting);
//   - the creator of a project chat keeps nothing after leaving the project;
//   - writes: members post into the shared chat, non-members cannot; only
//     manage+ edits the project / members / files; manage cannot touch an owner
//     row; nobody rewrites a session's user_email; only manage+ detaches;
//   - migration 0005 is idempotent and round-trips with 0003 + 0007 present
//     (AC-P2), and re-running 0003 / 0007 leaves its policies alone.
//
// Scratch databases on the local test server (like server/settingsAudit.test.js);
// no Postgres with pgvector → skipped.
//
//   node --test server/isolation.projects.test.js
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const MIGRATIONS = path.join(HERE, 'migrations')

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_PGVECTOR = '1'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET

const SUPERUSER = env.PGUSER
const ADMIN_DB = env.PGDATABASE
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const who = (n) => `w23-${n}-${stamp}@test.invalid`
const OWNER = who('owner')
const MANAGER = who('manage')
const VIEWER = who('view')
const OUTSIDER = who('outsider')
const LEAVER = who('leaver')
const GROUPIE = who('groupie')
const OTHER = who('other') // member of the second project only
const GROUP = `data team ${stamp}`

function opts(database, user = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 }
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test server)`
  }
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false
const quiet = { log() {}, warn() {}, info() {}, error() {} }

const createdDbs = []
async function superuser(sql, params = [], database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

async function scratch() {
  const name = `w23_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
  createdDbs.push(name)
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./db/migrate.js')
    const { applyAppGrants } = await import('./db/grants.js')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  return name
}

let DB
let raw // superuser on the scratch database: fixtures and ground truth, no RLS
let app // the app role on the scratch database: every assertion goes through it
const fx = {}

before(async () => {
  if (SKIP) return
  DB = await scratch()
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  app = new pg.Client(opts(DB, APP_ROLE))
  await app.connect()
  await app.query(`SET search_path TO ai_prism, public`)
  await seed()
})

after(async () => {
  await app?.end().catch(() => {})
  await raw?.end().catch(() => {})
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const q = async (sql, params = []) => (await raw.query(sql, params)).rows
const VEC = `[${Array.from({ length: 1024 }, () => 0.1).join(',')}]`

async function seedChat(email, projectId, title) {
  const s = (await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, $2, 'm', $3) RETURNING id`, [email, title, projectId]))[0].id
  const m = (await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'oi') RETURNING id`, [s]))[0].id
  await q(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 0, 't', 'ok')`, [m])
  await q(`INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id) VALUES ($1, 'sp', 'c')`, [s])
  await q(`INSERT INTO chat_compactions (session_id, upto_message_id, content) VALUES ($1, $2, 'x')`, [s, m])
  await q(`INSERT INTO chat_message_embeddings (message_id, session_id, embedding) VALUES ($1, $2, $3::vector)`, [m, s, VEC])
  return { s: String(s), m: String(m) }
}

async function seed() {
  // projects are created by the superuser here; the owner row comes from the
  // AFTER INSERT trigger (created_by), exactly as on an app insert
  fx.p = String((await q(`INSERT INTO projects (name, created_by) VALUES ('P', $1) RETURNING id`, [OWNER]))[0].id)
  fx.p2 = String((await q(`INSERT INTO projects (name, created_by) VALUES ('P2', $1) RETURNING id`, [OTHER]))[0].id)
  await q(
    `INSERT INTO project_members (project_id, kind, principal, role) VALUES
       ($1, 'user', $2, 'manage'), ($1, 'user', $3, 'view'), ($1, 'group', $4, 'view'),
       -- a GROUP named like the outsider's e-mail: kinds never mix
       ($1, 'group', $5, 'manage')`,
    [fx.p, MANAGER, VIEWER, GROUP, OUTSIDER]
  )
  await q(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'a.txt', 2, 'oi', $2)`, [fx.p, OWNER])
  fx.shared = await seedChat(OWNER, fx.p, 'shared')
  fx.personal = await seedChat(OWNER, null, 'personal')
  fx.other = await seedChat(OTHER, fx.p2, 'other project')
  // the leaver created a chat in P and then left the project
  await q(`INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', $2, 'view')`, [fx.p, LEAVER])
  fx.left = await seedChat(LEAVER, fx.p, 'left behind')
  fx.leaverPersonal = await seedChat(LEAVER, null, 'leaver personal')
  await q(`DELETE FROM project_members WHERE project_id = $1 AND principal = $2`, [fx.p, LEAVER])
}

/** fn(app) inside a transaction carrying this identity (rolled back). */
async function asIdentity(email, fn, { groups, admin = false, rawGroups } = {}) {
  await app.query('BEGIN')
  try {
    await app.query(
      `SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true), set_config('app.user_groups', $3, true)`,
      [email, admin ? 'on' : 'off', rawGroups ?? JSON.stringify(groups || [])]
    )
    return await fn(app)
  } finally {
    await app.query('ROLLBACK')
  }
}

const count = async (c, sql, params = []) => Number((await c.query(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0].n)

/** What of chat `chat` (fixture) this transaction can read, table by table. */
async function visibleOf(c, chat) {
  return {
    chat_sessions: await count(c, `SELECT 1 FROM chat_sessions WHERE id = $1`, [chat.s]),
    chat_messages: await count(c, `SELECT 1 FROM chat_messages WHERE session_id = $1`, [chat.s]),
    chat_tool_calls: await count(c, `SELECT 1 FROM chat_tool_calls WHERE message_id = $1`, [chat.m]),
    chat_genie_conversations: await count(c, `SELECT 1 FROM chat_genie_conversations WHERE session_id = $1`, [chat.s]),
    chat_compactions: await count(c, `SELECT 1 FROM chat_compactions WHERE session_id = $1`, [chat.s]),
    chat_message_embeddings: await count(c, `SELECT 1 FROM chat_message_embeddings WHERE session_id = $1`, [chat.s]),
  }
}
const ALL = { chat_sessions: 1, chat_messages: 1, chat_tool_calls: 1, chat_genie_conversations: 1, chat_compactions: 1, chat_message_embeddings: 1 }
const NONE = { chat_sessions: 0, chat_messages: 0, chat_tool_calls: 0, chat_genie_conversations: 0, chat_compactions: 0, chat_message_embeddings: 0 }

async function projectView(c, pid) {
  return {
    projects: await count(c, `SELECT 1 FROM projects WHERE id = $1`, [pid]),
    members: await count(c, `SELECT 1 FROM project_members WHERE project_id = $1`, [pid]),
    files: await count(c, `SELECT 1 FROM project_files WHERE project_id = $1`, [pid]),
  }
}

// ---- reads -------------------------------------------------------------------

test('the app role is bound: not superuser, no BYPASSRLS, owns none of the project tables', { skip: SKIP }, async () => {
  const r = (await app.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0]
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false })
  const owned = await app.query(
    `SELECT relname FROM pg_class WHERE relnamespace = 'ai_prism'::regnamespace AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`
  )
  assert.deepEqual(owned.rows, [])
})

test('members (owner, manage, view) read the shared chat a member created — every table of it — and the project', { skip: SKIP }, async () => {
  for (const email of [OWNER, MANAGER, VIEWER]) {
    await asIdentity(email, async (c) => {
      assert.deepEqual(await visibleOf(c, fx.shared), ALL, email)
      assert.deepEqual(await projectView(c, fx.p), { projects: 1, members: 5, files: 1 }, email)
    })
  }
})

test('a member through a SCIM group reads the shared chat only while the group is in app.user_groups', { skip: SKIP }, async () => {
  await asIdentity(GROUPIE, async (c) => assert.deepEqual(await visibleOf(c, fx.shared), ALL), { groups: [GROUP] })
  await asIdentity(GROUPIE, async (c) => assert.deepEqual(await visibleOf(c, fx.shared), ALL), { groups: [GROUP.toUpperCase()] })
  // SCIM failed → withTx sets no groups → fail closed
  await asIdentity(GROUPIE, async (c) => assert.deepEqual(await visibleOf(c, fx.shared), NONE), { groups: [] })
  for (const bad of ['not json', '{"a":1}', '"data team"', '[1,2]', 'null']) {
    await asIdentity(GROUPIE, async (c) => assert.deepEqual(await visibleOf(c, fx.shared), NONE, bad), { rawGroups: bad })
  }
})

test('a non-member reads nothing of the project or its chat; a same-named GROUP does not make a user a member', { skip: SKIP }, async () => {
  await asIdentity(OUTSIDER, async (c) => {
    assert.deepEqual(await visibleOf(c, fx.shared), NONE)
    assert.deepEqual(await projectView(c, fx.p), { projects: 0, members: 0, files: 0 })
  })
})

test('app admins get no implicit access: the admin flag changes nothing for a non-member', { skip: SKIP }, async () => {
  await asIdentity(OUTSIDER, async (c) => {
    assert.deepEqual(await visibleOf(c, fx.shared), NONE)
    assert.deepEqual(await projectView(c, fx.p), { projects: 0, members: 0, files: 0 })
  }, { admin: true })
})

test('AC-P1: an empty or unset identity never reads a shared chat, even with a member group and the admin flag', { skip: SKIP }, async () => {
  for (const email of ['', '   '.trim()]) {
    await asIdentity(email, async (c) => {
      assert.deepEqual(await visibleOf(c, fx.shared), NONE)
      assert.deepEqual(await projectView(c, fx.p), { projects: 0, members: 0, files: 0 })
      assert.equal(await count(c, `SELECT 1 FROM projects`), 0)
      assert.equal(await count(c, `SELECT 1 FROM project_members`), 0)
    }, { groups: [GROUP], admin: true })
  }
  // no set_config at all in the transaction
  await app.query('BEGIN')
  try {
    assert.deepEqual(await visibleOf(app, fx.shared), NONE)
    assert.equal(await count(app, `SELECT 1 FROM project_members`), 0)
  } finally {
    await app.query('ROLLBACK')
  }
})

test('membership does not nest: a member of P reads nothing of P2, and the reverse', { skip: SKIP }, async () => {
  await asIdentity(VIEWER, async (c) => {
    assert.deepEqual(await visibleOf(c, fx.other), NONE)
    assert.deepEqual(await projectView(c, fx.p2), { projects: 0, members: 0, files: 0 })
  })
  await asIdentity(OTHER, async (c) => assert.deepEqual(await visibleOf(c, fx.shared), NONE))
})

test('a personal chat stays the creator’s alone, even for members of the creator’s projects', { skip: SKIP }, async () => {
  await asIdentity(VIEWER, async (c) => assert.deepEqual(await visibleOf(c, fx.personal), NONE))
  await asIdentity(OWNER, async (c) => assert.deepEqual(await visibleOf(c, fx.personal), ALL))
})

test('the creator of a project chat keeps nothing after leaving; her personal chats stay hers; members still read it', { skip: SKIP }, async () => {
  await asIdentity(LEAVER, async (c) => {
    assert.deepEqual(await visibleOf(c, fx.left), NONE)
    assert.deepEqual(await visibleOf(c, fx.leaverPersonal), ALL)
  })
  await asIdentity(VIEWER, async (c) => assert.deepEqual(await visibleOf(c, fx.left), ALL))
})

// ---- writes ------------------------------------------------------------------

test('a viewer posts into the shared chat (message, tool call, ledger row); a non-member cannot', { skip: SKIP }, async () => {
  await asIdentity(VIEWER, async (c) => {
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'eu também') RETURNING id`, [fx.shared.s])).rows[0].id
    await c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 0, 't', 'ok')`, [m])
    await c.query(`INSERT INTO usage_ledger (user_email, session_id, kind, model, cost_usd) VALUES ($1, $2, 'chat', 'm', 1)`, [VIEWER, fx.shared.s])
    await c.query(`INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, 'd', 'x')`, [fx.shared.s, VIEWER])
    assert.equal((await c.query(`UPDATE chat_sessions SET updated_at = now() WHERE id = $1`, [fx.shared.s])).rowCount, 1)
  })
  await asIdentity(OUTSIDER, async (c) => {
    await assert.rejects(c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'x')`, [fx.shared.s]), /row-level security/)
  })
  await asIdentity(OUTSIDER, async (c) => {
    await assert.rejects(
      c.query(`INSERT INTO usage_ledger (user_email, session_id, kind, model) VALUES ($1, $2, 'chat', 'm')`, [OUTSIDER, fx.shared.s]),
      /row-level security/
    )
  })
  await asIdentity(OUTSIDER, async (c) => {
    assert.equal((await c.query(`UPDATE chat_sessions SET title = 'x' WHERE id = $1`, [fx.shared.s])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM chat_messages WHERE session_id = $1`, [fx.shared.s])).rowCount, 0)
  })
  // a member may not file her ledger row under someone else's name
  await asIdentity(VIEWER, async (c) => {
    await assert.rejects(
      c.query(`INSERT INTO usage_ledger (user_email, session_id, kind, model) VALUES ($1, $2, 'chat', 'm')`, [OWNER, fx.shared.s]),
      /row-level security/
    )
  })
})

test('nobody rewrites a session’s user_email; only its creator, with manage+, moves a chat out of the project', { skip: SKIP }, async () => {
  await asIdentity(VIEWER, async (c) => {
    await assert.rejects(c.query(`UPDATE chat_sessions SET user_email = $2 WHERE id = $1`, [fx.shared.s, VIEWER]), /user_email/)
  })
  await asIdentity(OWNER, async (c) => {
    await assert.rejects(c.query(`UPDATE chat_sessions SET user_email = $2 WHERE id = $1`, [fx.shared.s, VIEWER]), /user_email/)
  })
  await asIdentity(VIEWER, async (c) => {
    await assert.rejects(c.query(`UPDATE chat_sessions SET project_id = NULL WHERE id = $1`, [fx.shared.s]), /manage/)
  })
  // a detached chat is its creator's personal chat: a manager who is not the
  // creator cannot make it invisible to herself (the new row must stay visible)
  await asIdentity(MANAGER, async (c) => {
    await assert.rejects(c.query(`UPDATE chat_sessions SET project_id = NULL WHERE id = $1`, [fx.shared.s]), /row-level security/)
  })
  await asIdentity(OWNER, async (c) => {
    assert.equal((await c.query(`UPDATE chat_sessions SET project_id = NULL WHERE id = $1`, [fx.shared.s])).rowCount, 1)
  })
  // a viewer who created a project chat cannot take it back out either
  const v = await seedChat(VIEWER, fx.p, 'viewer chat')
  await asIdentity(VIEWER, async (c) => {
    await assert.rejects(c.query(`UPDATE chat_sessions SET project_id = NULL WHERE id = $1`, [v.s]), /manage/)
  })
})

test('attaching: only the creator, into a project she is a member of', { skip: SKIP }, async () => {
  // the outsider's own chat cannot be moved into a project she is not in
  const mine = (await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'mine', 'm') RETURNING id`, [OUTSIDER]))[0].id
  await asIdentity(OUTSIDER, async (c) => {
    await assert.rejects(c.query(`UPDATE chat_sessions SET project_id = $2 WHERE id = $1`, [mine, fx.p]), /row-level security/)
  })
  await asIdentity(OUTSIDER, async (c) => {
    await assert.rejects(
      c.query(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 'x', 'm', $2)`, [OUTSIDER, fx.p]),
      /row-level security/
    )
  })
  // a member cannot attach someone else's personal chat (she cannot even see it)
  await asIdentity(VIEWER, async (c) => {
    assert.equal((await c.query(`UPDATE chat_sessions SET project_id = $2 WHERE id = $1`, [fx.personal.s, fx.p])).rowCount, 0)
  })
  // the creator, a member, can
  const own = (await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'v', 'm') RETURNING id`, [VIEWER]))[0].id
  await asIdentity(VIEWER, async (c) => {
    assert.equal((await c.query(`UPDATE chat_sessions SET project_id = $2 WHERE id = $1`, [own, fx.p])).rowCount, 1)
  })
})

test('project edits: manage+ updates the project; view cannot; only the owner deletes it', { skip: SKIP }, async () => {
  await asIdentity(VIEWER, async (c) => {
    assert.equal((await c.query(`UPDATE projects SET instructions = 'x' WHERE id = $1`, [fx.p])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM projects WHERE id = $1`, [fx.p])).rowCount, 0)
  })
  await asIdentity(MANAGER, async (c) => {
    assert.equal((await c.query(`UPDATE projects SET instructions = 'Responda em tópicos.' WHERE id = $1`, [fx.p])).rowCount, 1)
    assert.equal((await c.query(`DELETE FROM projects WHERE id = $1`, [fx.p])).rowCount, 0)
  })
  await asIdentity(OUTSIDER, async (c) => {
    assert.equal((await c.query(`UPDATE projects SET instructions = 'x' WHERE id = $1`, [fx.p])).rowCount, 0)
  }, { admin: true })
})

test('members: manage adds view/manage but not owner and cannot change or remove an owner row; view adds nothing; self-leave works', { skip: SKIP }, async () => {
  const add = (c, principal, role) =>
    c.query(`INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', $2, $3)`, [fx.p, principal, role])
  await asIdentity(VIEWER, async (c) => {
    await assert.rejects(add(c, who('x1'), 'view'), /row-level security/)
  })
  await asIdentity(MANAGER, async (c) => {
    await add(c, who('x2'), 'view')
    await add(c, who('x3'), 'manage')
  })
  await asIdentity(MANAGER, async (c) => {
    await assert.rejects(add(c, who('x4'), 'owner'), /row-level security/)
  })
  await asIdentity(MANAGER, async (c) => {
    assert.equal((await c.query(`UPDATE project_members SET role = 'view' WHERE project_id = $1 AND principal = $2`, [fx.p, OWNER])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM project_members WHERE project_id = $1 AND principal = $2`, [fx.p, OWNER])).rowCount, 0)
  })
  await asIdentity(MANAGER, async (c) => {
    await assert.rejects(c.query(`UPDATE project_members SET role = 'owner' WHERE project_id = $1 AND principal = $2`, [fx.p, VIEWER]), /row-level security/)
  })
  await asIdentity(OWNER, async (c) => {
    await add(c, who('x5'), 'owner')
  })
  await asIdentity(VIEWER, async (c) => {
    assert.equal((await c.query(`DELETE FROM project_members WHERE project_id = $1 AND kind = 'user' AND principal = $2`, [fx.p, VIEWER])).rowCount, 1)
  })
  await asIdentity(OUTSIDER, async (c) => {
    await assert.rejects(add(c, OUTSIDER, 'owner'), /row-level security/)
  }, { admin: true })
})

test('files: manage+ adds and removes, view only reads, a non-member does neither', { skip: SKIP }, async () => {
  const add = (c, email) =>
    c.query(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'b.txt', 1, 'b', $2)`, [fx.p, email])
  await asIdentity(VIEWER, async (c) => {
    await assert.rejects(add(c, VIEWER), /row-level security/)
  })
  await asIdentity(VIEWER, async (c) => {
    assert.equal((await c.query(`DELETE FROM project_files WHERE project_id = $1`, [fx.p])).rowCount, 0)
  })
  await asIdentity(MANAGER, async (c) => {
    await add(c, MANAGER)
  })
  await asIdentity(MANAGER, async (c) => {
    await assert.rejects(add(c, OWNER), /row-level security/, 'uploaded_by must be the caller')
  })
  await asIdentity(OUTSIDER, async (c) => {
    await assert.rejects(add(c, OUTSIDER), /row-level security/)
  })
})

test('a project is created by the caller only, and its creator becomes its owner', { skip: SKIP }, async () => {
  const creator = who('creator')
  await asIdentity(creator, async (c) => {
    await assert.rejects(c.query(`INSERT INTO projects (name, created_by) VALUES ('x', $1)`, [OWNER]), /row-level security/)
  })
  await asIdentity(creator, async (c) => {
    const id = (await c.query(`SELECT nextval(pg_get_serial_sequence('ai_prism.projects', 'id')) AS id`)).rows[0].id
    await c.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'mine', $2)`, [id, creator])
    assert.equal((await c.query(`SELECT ai_prism.aip_project_rank($1) AS r`, [id])).rows[0].r, 3)
    assert.deepEqual((await c.query(`SELECT kind, principal, role FROM project_members WHERE project_id = $1`, [id])).rows, [
      { kind: 'user', principal: creator, role: 'owner' },
    ])
  })
  await asIdentity('', async (c) => {
    await assert.rejects(c.query(`INSERT INTO projects (name, created_by) VALUES ('x', '')`), /row-level security|check constraint/)
  })
})

test('deleting a project takes its chats with it (ON DELETE CASCADE)', { skip: SKIP }, async () => {
  const p = (await q(`INSERT INTO projects (name, created_by) VALUES ('gone', $1) RETURNING id`, [OWNER]))[0].id
  const chat = await seedChat(OWNER, p, 'gone')
  await asIdentity(OWNER, async (c) => {
    assert.equal((await c.query(`DELETE FROM projects WHERE id = $1`, [p])).rowCount, 1)
  })
  // rolled back above: delete for real as the superuser and check the cascade
  await q(`DELETE FROM projects WHERE id = $1`, [p])
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1`, [chat.s]))[0].n, 0)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1`, [chat.s]))[0].n, 0)
})

// ---- migration 0005 ------------------------------------------------------------

test('AC-P2: 0005 up is idempotent, down → up round-trips with 0003 + 0007 present, and re-running 0003 / 0007 keeps its policies', { skip: SKIP }, async () => {
  const name = await scratch()
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    const state = async () =>
      (
        await c.query(
          `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                  (SELECT array_agg(p.polname::text || ':' || p.polpermissive::text ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                  (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers
             FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace AND c.relkind = 'r' ORDER BY c.relname`
        )
      ).rows
    const before = await state()
    const by = Object.fromEntries(before.map((r) => [r.relname, r]))
    for (const t of ['projects', 'project_files']) {
      assert.equal(by[t].rls, true, `${t} ENABLE`)
      assert.equal(by[t].force, true, `${t} FORCE`)
    }
    assert.equal(by.project_members.rls, true, 'project_members ENABLE')
    assert.equal(by.project_members.force, false, 'project_members: not FORCE (the membership function reads it as the owner)')
    assert.ok(by.chat_sessions.policies.includes('aipj_project_gate:false'), 'the restrictive gate on chat_sessions')
    assert.ok(by.chat_sessions.policies.includes('aipr_maint_read:true'), "0007's sweep policies are still there")
    assert.ok(by.chat_sessions.policies.includes('aip_owner:true'), "0003's owner policy is still there")

    const read = (f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')
    const up5 = read('0005_projects.up.sql')
    const down5 = read('0005_projects.down.sql')
    await c.query('BEGIN')
    await c.query(up5)
    await c.query(up5)
    await c.query('COMMIT')
    assert.deepEqual(await state(), before, 'running the 0005 up body twice changes nothing')
    await c.query('BEGIN')
    await c.query(read('0003_rls.up.sql'))
    await c.query(read('0007_settings_audit.up.sql'))
    await c.query(read('0011_ephemeral.up.sql')) // 0007 up resets the sweep policies; 0011 re-applies its version
    await c.query('COMMIT')
    assert.deepEqual(await state(), before, 're-running 0003 and 0007 leaves the aipj_ policies in place')

    const { migrateDown, migrateUp, loadMigrations } = await import('./db/migrate.js')
    const versions = loadMigrations(MIGRATIONS).map((m) => m.version)
    assert.ok(versions.includes(5) && versions.includes(3) && versions.includes(7))
    const d = await migrateDown(c, { to: 4, log: quiet })
    assert.deepEqual(d.reverted, versions.filter((v) => v > 4).reverse())
    const gone = (
      await c.query(
        `SELECT to_regclass('ai_prism.projects') AS p, to_regclass('ai_prism.project_members') AS m, to_regclass('ai_prism.project_files') AS f,
                (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'ai_prism' AND table_name = 'chat_sessions' AND column_name = 'project_id') AS col,
                (SELECT count(*)::int FROM pg_policy WHERE polname LIKE 'aipj\\_%') AS policies,
                (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'aip\\_project%' OR proname LIKE 'aipj\\_%' OR proname = 'aip_my_groups') AS fns`
      )
    ).rows[0]
    assert.deepEqual(gone, { p: null, m: null, f: null, col: 0, policies: 0, fns: 0 })
    await c.query('BEGIN')
    await c.query(down5)
    await c.query(down5)
    await c.query('ROLLBACK')
    const u = await migrateUp(c, { log: quiet })
    assert.deepEqual(u.applied, versions.filter((v) => v > 4))
    assert.deepEqual(await state(), before)
  } finally {
    await c.end().catch(() => {})
  }
})

// QA r1 blocker 1: AC-P1 has no exception. The retention sweep's maintenance
// identity (0007: empty app.user_email + app.maintenance = 'on') keeps working on
// PERSONAL chats, and gets nothing of a project chat: not the session, not a
// child row, not a delete. Expiring project chats is a follow-up (see the PR).
test('AC-P1 / retention: the maintenance identity expires a personal chat but reads and deletes nothing of a project chat', { skip: SKIP }, async () => {
  const shared = await seedChat(OWNER, fx.p, 'expired shared')
  const personal = await seedChat(OWNER, null, 'expired personal')
  await q(`INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type) VALUES ($1, $2, 'p', 'm', '/Volumes/x/y.png', 'image/png')`, [shared.s, OWNER])
  await q(`INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, 'd', 'x')`, [shared.s, OWNER])
  for (const s of [shared.s, personal.s]) {
    await q(`UPDATE chat_sessions SET updated_at = now() - interval '40 days' WHERE id = $1`, [s])
    await q(`UPDATE chat_messages SET created_at = now() - interval '40 days' WHERE session_id = $1`, [s])
  }
  await q(`INSERT INTO app_settings (key, value) VALUES ('retention_days', '30') ON CONFLICT (key) DO UPDATE SET value = '30'`)
  try {
    await app.query('BEGIN')
    try {
      await app.query(`SELECT set_config('app.user_email', '', true), set_config('app.maintenance', 'on', true)`)
      assert.deepEqual(await visibleOf(app, shared), NONE, 'no row of the shared chat')
      assert.equal(await count(app, `SELECT 1 FROM chat_images WHERE session_id = $1`, [shared.s]), 0)
      assert.equal(await count(app, `SELECT 1 FROM chat_documents WHERE session_id = $1`, [shared.s]), 0)
      assert.equal(await count(app, `SELECT 1 FROM projects`), 0)
      assert.equal((await app.query(`DELETE FROM chat_sessions WHERE id = $1`, [shared.s])).rowCount, 0, 'nor a delete')
      // the sweep itself still works on personal chats
      assert.equal(await count(app, `SELECT 1 FROM chat_sessions WHERE id = $1`, [personal.s]), 1)
      assert.equal((await app.query(`DELETE FROM chat_sessions WHERE id = $1`, [personal.s])).rowCount, 1)
    } finally {
      await app.query('ROLLBACK')
    }
    // a member identity with the maintenance flag gets nothing extra either
    await asIdentity(OUTSIDER, async (c) => {
      await c.query(`SELECT set_config('app.maintenance', 'on', true)`)
      assert.equal(await count(c, `SELECT 1 FROM chat_sessions WHERE id = $1`, [shared.s]), 0)
    })
  } finally {
    await q(`DELETE FROM app_settings WHERE key = 'retention_days'`)
  }
})

test('AC-P1: empty identity cannot read a shared project chat under the maintenance flag', { skip: SKIP }, async () => {
  const old = await seedChat(OWNER, fx.p, 'empty-maintenance-acp1')
  await q(`UPDATE chat_sessions SET updated_at = now() - interval '40 days' WHERE id = $1`, [old.s])
  await q(`INSERT INTO app_settings (key, value) VALUES ('retention_days', '30') ON CONFLICT (key) DO UPDATE SET value = '30'`)
  try {
    await app.query('BEGIN')
    try {
      await app.query(`SELECT set_config('app.user_email', '', true), set_config('app.maintenance', 'on', true)`)
      const seen = (await app.query(`SELECT id FROM chat_sessions WHERE id = $1`, [old.s])).rows
      assert.deepEqual(seen, [], 'AC-P1 forbids any empty-identity transaction from reading a shared session')
    } finally {
      await app.query('ROLLBACK')
    }
  } finally {
    await q(`DELETE FROM app_settings WHERE key = 'retention_days'`)
  }
})
