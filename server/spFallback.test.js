// The SP → per-user fallback of withClient (server/db/pool.js), narrowed in W1-5:
// a "permission denied" (SQLSTATE 42501) on the SP connection no longer demotes
// the request to the caller's own identity. It warns, asks for one grants run
// (throttled, non-blocking) and surfaces the original error; the next request
// still uses the SP. Auth/connection failures keep demoting (W2-1 removes them).
// No database: the SP pool and the per-user path are fakes.
//
//   node --test server/spFallback.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import * as db from './db.js'
import { createGrantsRetry, createWithClient, spErrorAction } from './db/pool.js'

const SP_ENV = { DATABRICKS_CLIENT_ID: 'sp-client-id', DATABRICKS_CLIENT_SECRET: 'sp-secret' }

function pgError(message, code) {
  const e = new Error(message)
  if (code) e.code = code
  return e
}

// A fake SP pool whose clients run fn; `fail` decides what a query throws.
function fakeSpPool() {
  const pool = { acquired: 0, released: 0 }
  pool.connect = async () => {
    pool.acquired++
    return { identity: 'sp', release: () => pool.released++ }
  }
  return pool
}

// A fake per-user client: answers the role check (pg_roles for current_user) with `role`.
// `queries` records every statement so a test can count the checks.
function fakeUserClient(role = { rolsuper: false, rolbypassrls: false }, queries = []) {
  return {
    identity: 'user',
    query: async (sql) => {
      queries.push(String(sql))
      if (/pg_roles/.test(String(sql))) return { rows: [role] }
      throw new Error('unexpected query: ' + sql)
    },
  }
}

function harness({ env = SP_ENV, start = 1_000_000, role, userClient } = {}) {
  const pool = fakeSpPool()
  const log = { warns: [], warn: (...a) => log.warns.push(a.join(' ')), log: () => {} }
  const clock = { t: start }
  const grants = []
  const userCalls = []
  const withClient = createWithClient({
    env,
    now: () => clock.t,
    log,
    getSpPool: async () => pool,
    userPath: async (email, token, fn) => {
      userCalls.push(email)
      return fn(userClient || fakeUserClient(role))
    },
    requestGrants: (reason) => {
      grants.push(reason)
      return true
    },
  })
  return { withClient, pool, log, clock, grants, userCalls }
}

test('spErrorAction: 42501 asks for grants, auth/connection failures demote, the rest throws', () => {
  assert.equal(spErrorAction(pgError('permission denied for table chat_sessions', '42501')), 'grants')
  assert.equal(spErrorAction(pgError('permission denied for schema ai_prism')), 'grants')
  assert.equal(spErrorAction(pgError('password authentication failed for user "x"', '28P01')), 'demote')
  assert.equal(spErrorAction(pgError('role "x" does not exist', '28000')), 'demote')
  assert.equal(spErrorAction(pgError('External authorization failed', '28000')), 'demote')
  assert.equal(spErrorAction(pgError('sp token: HTTP 401')), 'demote')
  assert.equal(spErrorAction(pgError('connect ECONNREFUSED 127.0.0.1:5432')), 'demote')
  assert.equal(spErrorAction(pgError('connect ETIMEDOUT')), 'demote')
  assert.equal(spErrorAction(pgError('duplicate key value violates unique constraint', '23505')), 'throw')
  assert.equal(spErrorAction(pgError('must be owner of table chat_sessions', '42501')), 'grants')
})

test('42501 on the SP: warns, requests grants, rethrows the same error; identity unchanged', async () => {
  const h = harness()
  const denied = pgError('permission denied for table chat_sessions', '42501')
  await assert.rejects(
    h.withClient('a@test.invalid', 'tok-a', async () => {
      throw denied
    }),
    (e) => e === denied
  )
  assert.equal(h.userCalls.length, 0, 'no demotion to the per-user identity')
  assert.equal(h.grants.length, 1, 'one grants run requested')
  assert.equal(h.pool.released, 1, 'the SP client went back to the pool')
  assert.ok(h.log.warns.some((w) => /permission denied/.test(w) && /grants/.test(w)), h.log.warns.join('\n'))

  // the very next request still runs on the SP (no 5-minute demotion latch)
  const who = await h.withClient('a@test.invalid', 'tok-a', async (c) => c.identity)
  assert.equal(who, 'sp')
  assert.equal(h.userCalls.length, 0)
})

test('an auth failure on the SP still demotes to the per-user identity (unchanged)', async () => {
  const h = harness()
  const who = await h.withClient('a@test.invalid', 'tok-a', async (c) => {
    if (c.identity === 'sp') throw pgError('password authentication failed for user "sp-client-id"', '28P01')
    return c.identity
  })
  assert.equal(who, 'user')
  assert.deepEqual(h.userCalls, ['a@test.invalid'])
  assert.equal(h.grants.length, 0)
  // and the SP stays off for the cooldown: the next request goes straight to the user path
  assert.equal(await h.withClient('a@test.invalid', 'tok-a', async (c) => c.identity), 'user')
})

test('a real query error on the SP surfaces without grants or demotion', async () => {
  const h = harness()
  await assert.rejects(
    h.withClient('a@test.invalid', 'tok-a', async () => {
      throw pgError('duplicate key value violates unique constraint "x"', '23505')
    }),
    /duplicate key/
  )
  assert.equal(h.userCalls.length, 0)
  assert.equal(h.grants.length, 0)
})

test('without SP credentials the per-user path runs directly', async () => {
  const h = harness({ env: {} })
  assert.equal(await h.withClient('a@test.invalid', 'tok-a', async (c) => c.identity), 'user')
  assert.equal(h.pool.acquired, 0)
})

test('createGrantsRetry: at most one run per interval, never awaited by the caller, failures only warn', async () => {
  const clock = { t: 0 }
  const warns = []
  let runs = 0
  let release
  const gate = new Promise((r) => (release = r))
  const request = createGrantsRetry({
    intervalMs: 5 * 60 * 1000,
    now: () => clock.t,
    log: { warn: (...a) => warns.push(a.join(' ')) },
    run: async () => {
      runs++
      await gate
      throw new Error('no owner identity')
    },
  })
  assert.equal(request('42501'), true, 'first request starts a run')
  assert.equal(request('42501'), false, 'a second request inside the interval is dropped')
  clock.t += 60_000
  assert.equal(request('42501'), false)
  release()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(runs, 1)
  assert.ok(warns.some((w) => /no owner identity/.test(w)), 'a failed run warns, it does not throw')
  clock.t += 5 * 60 * 1000
  assert.equal(request('42501'), true, 'after the interval a new run is allowed')
})

test('the per-request ensureSpGrants path is gone', () => {
  assert.equal('ensureSpGrants' in db, false, 'server/db.js must not export ensureSpGrants')
})

// ---- F2 (G15): the per-user fallback fails closed under a role that skips RLS ----

const SP_AUTH_FAIL = () => pgError('password authentication failed for user "sp-client-id"', '28P01')

// first call on the SP fails to log in (demote); the work function only counts calls
async function runDemoted(h, work) {
  return h.withClient('victim@test.invalid', 'tok-secret-123', async (c) => {
    if (c.identity === 'sp') throw SP_AUTH_FAIL()
    return work(c)
  })
}

for (const [label, role] of [
  ['BYPASSRLS', { rolsuper: false, rolbypassrls: true }],
  ['superuser', { rolsuper: true, rolbypassrls: false }],
]) {
  test(`G15: fallback under a ${label} role is refused (503, work never runs, one warn without email or token)`, async () => {
    const h = harness({ role })
    let ran = 0
    await assert.rejects(
      runDemoted(h, () => ran++),
      (e) => e.status === 503 && e.code === 'lakebase_fallback_refused' && !/victim|tok-secret/.test(e.message)
    )
    assert.equal(ran, 0, 'the work function must never run outside the policies')
    const refusals = h.log.warns.filter((w) => /rls|row-level/i.test(w) && /fallback/i.test(w))
    assert.equal(refusals.length, 1, h.log.warns.join('\n'))
    assert.ok(!h.log.warns.some((w) => /victim@test\.invalid|tok-secret-123/.test(w)), 'no identity or token in logs')
    assert.match(refusals[0], label === 'superuser' ? /rolsuper/ : /rolbypassrls/)
  })
}

test('G15: a NOSUPERUSER NOBYPASSRLS fallback role still works (and the check runs once per client)', async () => {
  const queries = []
  const client = fakeUserClient({ rolsuper: false, rolbypassrls: false }, queries)
  const h = harness({ userClient: client })
  assert.equal(await runDemoted(h, (c) => c.identity), 'user')
  h.clock.t += 6 * 60 * 1000 // SP cooldown over; fail it again to land on the user path with the SAME client
  assert.equal(await runDemoted(h, (c) => c.identity), 'user')
  assert.equal(queries.filter((q) => /pg_roles/.test(q)).length, 1, 'cached on the client object, not per query')
})

test('G15: the verdict is per client: a second connection under a bypass role is checked again', async () => {
  const h = harness({ role: { rolsuper: false, rolbypassrls: false } })
  assert.equal(await runDemoted(h, (c) => c.identity), 'user')
  const h2 = harness({ role: { rolsuper: false, rolbypassrls: true } })
  await assert.rejects(runDemoted(h2, () => 'ran'), (e) => e.status === 503)
})

test('G15: a failed role check fails closed', async () => {
  const bad = { identity: 'user', query: async () => { throw pgError('connection terminated') } }
  const h = harness({ userClient: bad })
  let ran = 0
  await assert.rejects(runDemoted(h, () => ran++), (e) => e.status === 503)
  assert.equal(ran, 0)
})

test('G15: with no SP credentials but on Databricks Apps the guard applies to the direct per-user path', async () => {
  const h = harness({ env: { DATABRICKS_APP_NAME: 'ai-prism' }, role: { rolsuper: false, rolbypassrls: true } })
  let ran = 0
  await assert.rejects(h.withClient('a@test.invalid', 'tok', async () => ran++), (e) => e.status === 503)
  assert.equal(ran, 0)
})

test('G15: local dev (no SP credentials, no DATABRICKS_APP_*) is unaffected: no role query, bypass role allowed', async () => {
  const queries = []
  const client = fakeUserClient({ rolsuper: true, rolbypassrls: true }, queries)
  const h = harness({ env: { LOCAL_DEV_MODE: '1' }, userClient: client })
  assert.equal(await h.withClient('a@test.invalid', 'tok', async (c) => c.identity), 'user')
  assert.equal(queries.length, 0)
})
