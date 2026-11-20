// commitTurnAnswer (server/db/turnCommit.js): the answer of a turn as ONE
// transaction, against a real Postgres, with db.js connected as the non-owner app
// role (scripts/ci/pg-roles.sql) under FORCE ROW LEVEL SECURITY, as in
// server/isolation.test.js. Raw checks run as the superuser of the test server,
// which bypasses RLS; every "nothing written" assertion is paired with a
// positive control (the prompt row, read through the same helper), so a zero is
// never just an invisible row. Without the database the suite is SKIPPED with
// the reason; CI runs --fail-on-skip.
//
//   node --test server/db/turnCommit.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE ||= '1'
env.LOCAL_PGVECTOR = '1'
// the service-principal pool would route every query through another identity
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
const SUPERUSER = env.PGUSER
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function connectionOptions(user = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 }
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test database)`
  }
  const c = new pg.Client(connectionOptions())
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed in this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}

const SKIP = (await skipReason()) || false
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const A = `tc-a-${stamp}@test.invalid`
const B = `tc-b-${stamp}@test.invalid`
const TOKEN = 'token-a'

let raw
let db
let commitTurnAnswer
let spErrorAction

async function q(sql, params = []) {
  return (await raw.query(sql, params)).rows
}

if (!SKIP) {
  raw = new pg.Client(connectionOptions())
  await raw.connect()
  await raw.query('SET search_path TO ai_prism, public')
  const hasRole = await raw.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
  if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
    await raw.query(fs.readFileSync(path.join(HERE, '..', '..', 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
  }
  const { migrateUp } = await import('./migrate.js')
  const { applyAppGrants } = await import('./grants.js')
  await migrateUp(raw, { log: { log() {}, warn() {} } })
  await raw.query('SET search_path TO ai_prism, public')
  await applyAppGrants(raw, { role: APP_ROLE, log: { log() {}, warn() {} } })
  env.PGUSER = APP_ROLE
  db = await import('../db.js')
  await db.ensureSchema(A, TOKEN)
  ;({ commitTurnAnswer } = await import('./turnCommit.js'))
  ;({ spErrorAction } = await import('./pool.js'))
}

after(async () => {
  if (!raw) return
  await raw.query(`DROP TRIGGER IF EXISTS tc_reject_tool_call ON chat_tool_calls`).catch(() => {})
  await raw.query(`DROP FUNCTION IF EXISTS tc_reject_tool_call()`).catch(() => {})
  await raw.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[A, B]])
  await raw.end().catch(() => {})
})

/** A session of A with its prompt (the turn's input, committed before the answer). */
async function sessionWithPrompt(label) {
  const sessionId = await db.createSession(A, TOKEN, `tc ${label}`, 'm1', null, [])
  const prompt = await db.addMessage(A, TOKEN, { sessionId, role: 'user', content: `prompt ${label} ${stamp}` })
  return { sessionId, promptId: prompt.id }
}

function answerInput(sessionId, label) {
  return {
    sessionId,
    chartState: { nextId: 3, items: [{ id: 1 }, { id: 2 }] },
    blocks: [
      { type: 'deck-html', title: `deck ${label}`, slides: ['<section>1</section>'], audience: 'x', author: 'y' },
      { type: 'chart', spec: { kind: 'bar' } },
      { type: 'spreadsheet', title: `sheet ${label}`, sheets: [] },
      { type: 'document', title: `doc ${label}`, markdown: '# doc' },
    ],
    message: { content: `answer ${label}`, model: 'm1', promptTokens: 10, completionTokens: 5 },
    toolTrace: [{ id: 'c1', name: `tool-${label}`, args: {}, status: 'ok', result: 'r', durationMs: 3 }],
  }
}

/** Everything a turn's answer could leave in a session, plus the prompt (the positive control). */
async function persisted(sessionId) {
  const [row] = await q(
    `SELECT (SELECT count(*)::int FROM chat_messages WHERE session_id = $1 AND role = 'user') AS prompts,
            (SELECT count(*)::int FROM chat_messages WHERE session_id = $1 AND role = 'assistant') AS answers,
            (SELECT count(*)::int FROM chat_tool_calls t JOIN chat_messages m ON m.id = t.message_id WHERE m.session_id = $1) AS tool_calls,
            (SELECT count(*)::int FROM chat_decks WHERE session_id = $1) AS decks,
            (SELECT count(*)::int FROM chat_spreadsheets WHERE session_id = $1) AS sheets,
            (SELECT count(*)::int FROM chat_documents WHERE session_id = $1) AS docs,
            (SELECT coalesce((chart_candidates->>'nextId')::int = 3, false) FROM chat_sessions WHERE id = $1) AS charted`,
    [sessionId]
  )
  return row
}

const NOTHING = { prompts: 1, answers: 0, tool_calls: 0, decks: 0, sheets: 0, docs: 0, charted: false }

async function waitFor(fn, { timeoutMs = 5000, stepMs = 20 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

test('commits the whole answer in one go: candidates, artifacts, message, tool trace', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('ok')
  const input = answerInput(sessionId, 'ok')
  const out = await commitTurnAnswer(A, TOKEN, input)
  assert.deepEqual(await persisted(sessionId), { prompts: 1, answers: 1, tool_calls: 1, decks: 1, sheets: 1, docs: 1, charted: true })
  const [deck, chart, sheet, doc] = out.blocks
  assert.ok(deck.deckId && sheet.spreadsheetId && doc.documentId, 'artifact ids stamped on the returned blocks')
  assert.equal(chart.deckId, undefined)
  const [stored] = await q(`SELECT blocks, role, variant_group::text AS vg, id::text AS id FROM chat_messages WHERE id = $1`, [out.id])
  assert.equal(stored.role, 'assistant')
  assert.equal(stored.vg, stored.id, 'a new answer is its own variant group')
  assert.deepEqual(stored.blocks, out.blocks, 'the message stores the stamped copy')
  const [m] = await db.listMessages(A, TOKEN, sessionId).then((ms) => ms.filter((x) => x.role === 'assistant'))
  assert.equal(m.content, 'answer ok', 'the owner reads the answer through RLS')
  assert.ok(await db.getDeck(A, TOKEN, deck.deckId))
})

test('an already-aborted signal writes nothing and rejects with the signal\'s own reason', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('pre-abort')
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(commitTurnAnswer(A, TOKEN, answerInput(sessionId, 'pre-abort'), { signal: ac.signal }), (e) => e === ac.signal.reason)
  assert.deepEqual(await persisted(sessionId), NOTHING)
})

test('a cancel while the statements wait on a lock rolls back at the pre-COMMIT check (AbortError, unwrapped, not an SP demotion)', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('lock')
  const blocker = new pg.Client(connectionOptions(SUPERUSER))
  await blocker.connect()
  const ac = new AbortController()
  try {
    await blocker.query('SET search_path TO ai_prism, public')
    await blocker.query('BEGIN')
    await blocker.query(`SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE`, [sessionId])
    const pending = commitTurnAnswer(A, TOKEN, answerInput(sessionId, 'lock'), { signal: ac.signal }).catch((e) => e)
    const waiting = await waitFor(async () =>
      (await q(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'UPDATE chat_sessions SET chart_candidates%'`
      ))[0]
    )
    assert.ok(waiting, 'the first statement of the answer is waiting on the lock')
    ac.abort()
    await blocker.query('ROLLBACK')
    const err = await pending
    assert.equal(err, ac.signal.reason, 'the signal\'s own reason, never wrapped')
    assert.equal(err.name, 'AbortError')
    assert.equal(spErrorAction(err), 'throw', 'a cancel never demotes the service principal')
  } finally {
    await blocker.query('ROLLBACK').catch(() => {})
    await blocker.end().catch(() => {})
  }
  assert.deepEqual(await persisted(sessionId), NOTHING)
})

test('a failing later statement (the tool trace, after candidates, artifacts and message) writes nothing', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('fail')
  const input = answerInput(sessionId, 'fail')
  await raw.query(`
    CREATE OR REPLACE FUNCTION tc_reject_tool_call() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.tool_name = 'tool-fail' THEN RAISE EXCEPTION 'tc persistence failure'; END IF;
      RETURN NEW;
    END $$`)
  await raw.query(`DROP TRIGGER IF EXISTS tc_reject_tool_call ON chat_tool_calls`)
  await raw.query(`CREATE TRIGGER tc_reject_tool_call BEFORE INSERT ON chat_tool_calls FOR EACH ROW EXECUTE FUNCTION tc_reject_tool_call()`)
  try {
    await assert.rejects(commitTurnAnswer(A, TOKEN, input), /tc persistence failure/)
  } finally {
    await raw.query(`DROP TRIGGER IF EXISTS tc_reject_tool_call ON chat_tool_calls`)
  }
  assert.deepEqual(await persisted(sessionId), NOTHING)
})

test('pure on its inputs: the same input twice yields two independent complete answers; the caller\'s blocks are untouched', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('pure')
  const input = answerInput(sessionId, 'pure')
  const snapshot = structuredClone(input)
  const one = await commitTurnAnswer(A, TOKEN, input)
  const two = await commitTurnAnswer(A, TOKEN, input)
  assert.deepEqual(input, snapshot, 'the input (blocks included) is never mutated')
  assert.notEqual(one.id, two.id)
  assert.notEqual(one.blocks, two.blocks)
  assert.notEqual(one.blocks[0].deckId, two.blocks[0].deckId)
  assert.notEqual(one.blocks[2].spreadsheetId, two.blocks[2].spreadsheetId)
  assert.notEqual(one.blocks[3].documentId, two.blocks[3].documentId)
  assert.deepEqual(await persisted(sessionId), { prompts: 1, answers: 2, tool_calls: 2, decks: 2, sheets: 2, docs: 2, charted: true })
})

test('another user\'s session: 404 and nothing written (the ownership predicate of every helper)', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('foreign')
  await assert.rejects(commitTurnAnswer(B, 'token-b', answerInput(sessionId, 'foreign')), (e) => e.status === 404)
  assert.deepEqual(await persisted(sessionId), NOTHING)
})

test('the message is the assistant\'s: another role is refused before any write', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('role')
  const input = { ...answerInput(sessionId, 'role'), message: { role: 'user', content: 'x' } }
  await assert.rejects(commitTurnAnswer(A, TOKEN, input), TypeError)
  assert.deepEqual(await persisted(sessionId), NOTHING)
})

test('N7-10: a spreadsheet block keeps its instructions in the stored spec (and none when it has none)', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('instr')
  const input = {
    sessionId,
    blocks: [
      { type: 'spreadsheet', title: 'with', sheets: [], instructions: ['Preencha a aba Entradas', 'Não edite as fórmulas'] },
      { type: 'spreadsheet', title: 'without', sheets: [] },
    ],
    message: { content: 'answer instr', model: 'm1' },
  }
  const out = await commitTurnAnswer(A, TOKEN, input)
  const [withI, withoutI] = out.blocks
  const specOf = async (id) => (await q(`SELECT spec FROM chat_spreadsheets WHERE id = $1`, [id]))[0].spec
  assert.deepEqual((await specOf(withI.spreadsheetId)).instructions, ['Preencha a aba Entradas', 'Não edite as fórmulas'])
  assert.equal('instructions' in (await specOf(withoutI.spreadsheetId)), false)
})

test('N7-14: a pending image block gets its chat_images row in the answer transaction, stamped on the stored block', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('img')
  const imgs = async () => q(`SELECT id::text AS id, volume_path, prompt, model FROM chat_images WHERE session_id = $1`, [sessionId])
  const out = await commitTurnAnswer(A, TOKEN, {
    sessionId,
    blocks: [{ type: 'image', pendingImage: { volumePath: '/Volumes/x/n7.png', contentType: 'image/png', prompt: 'a cat', model: 'img-1' }, prompt: 'a cat', caption: 'c' }],
    message: { content: 'answer img', model: 'm1' },
  })
  const rows = await imgs()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].volume_path, '/Volumes/x/n7.png')
  assert.equal(out.blocks[0].imageId, rows[0].id)
  assert.equal('pendingImage' in out.blocks[0], false, 'the pending insert is not stored')
  const [m] = await q(`SELECT blocks FROM chat_messages WHERE id = $1`, [out.id])
  assert.equal(m.blocks[0].imageId, rows[0].id)
  assert.equal('pendingImage' in m.blocks[0], false)
})

test('N7-14: a cancel before COMMIT leaves no chat_images row', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('img-cancel')
  const ac = new AbortController()
  const input = {
    sessionId,
    blocks: [{ type: 'image', pendingImage: { volumePath: '/Volumes/x/n7c.png', contentType: 'image/png', prompt: 'p', model: 'm' } }],
    message: { content: 'x', model: 'm1' },
  }
  ac.abort()
  await assert.rejects(commitTurnAnswer(A, TOKEN, input, { signal: ac.signal }))
  assert.deepEqual(await q(`SELECT id FROM chat_images WHERE session_id = $1`, [sessionId]), [])
})

test('N7-15: updateSpreadsheet / updateDocument report whether a row matched (false once the row is gone)', { skip: SKIP }, async () => {
  const { sessionId } = await sessionWithPrompt('gone')
  const out = await commitTurnAnswer(A, TOKEN, {
    sessionId,
    blocks: [{ type: 'spreadsheet', title: 's', sheets: [] }, { type: 'document', title: 'd', markdown: '# d' }],
    message: { content: 'x', model: 'm1' },
  })
  const [sheet, doc] = out.blocks
  assert.equal(await db.updateSpreadsheet(A, TOKEN, sheet.spreadsheetId, 's2', {}), true)
  assert.equal(await db.updateDocument(A, TOKEN, doc.documentId, 'd2', '# d2'), true)
  await q(`DELETE FROM chat_spreadsheets WHERE id = $1`, [sheet.spreadsheetId]) // what the sweep's cascade does
  await q(`DELETE FROM chat_documents WHERE id = $1`, [doc.documentId])
  assert.equal(await db.updateSpreadsheet(A, TOKEN, sheet.spreadsheetId, 's3', {}), false)
  assert.equal(await db.updateDocument(A, TOKEN, doc.documentId, 'd3', '# d3'), false)
})
