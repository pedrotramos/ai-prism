// The lazy schema latch behind every API route (server/middleware/ensureReady.ts).
// The schema DDL must run once per process even when the first requests arrive
// together (a cold app usually gets several at once: /api/me, /api/models,
// /api/sessions), and a failed DDL must be retried by a later request.
// No database: ensureSchema/startAppGrants are stubs. (The usage backfill left
// the request path in W2-1: `node scripts/migrate.mjs backfill-usage`.)
//
//   node --test server/middleware/ensureReady.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnsureReady } from './ensureReady.ts'

const REQ = { email: 'a@test.invalid', token: 'tok-a' }

// a DDL stub the test resolves or rejects by hand, counting its calls
interface Call {
  email: string
  token: string
  resolve: (v?: unknown) => void
  reject: (e?: unknown) => void
}

function controlledSchema() {
  const calls: Call[] = []
  const ensureSchema = (email: string, token: string): Promise<{ deferred?: unknown[] } | undefined> => {
    let resolve!: Call['resolve']
    let reject!: Call['reject']
    const p = new Promise<{ deferred?: unknown[] } | undefined>((res, rej) => {
      resolve = res as Call['resolve']
      reject = rej
    })
    calls.push({ email, token, resolve, reject })
    return p
  }
  return { calls, ensureSchema }
}

function deps(ensureSchema: Parameters<typeof createEnsureReady>[0]['ensureSchema'], { now = () => 0, startAppGrants }: { now?: () => number; startAppGrants?: () => Promise<unknown> } = {}) {
  const counts = { grants: 0 }
  return {
    counts,
    ensureReady: createEnsureReady({
      ensureSchema,
      startAppGrants:
        startAppGrants ||
        (async () => {
          counts.grants++
        }),
      now,
    }),
  }
}

const tick = () => new Promise((r) => setImmediate(r))

test('two concurrent first requests run the schema DDL once', async () => {
  const schema = controlledSchema()
  const { ensureReady, counts } = deps(schema.ensureSchema)
  const first = ensureReady(REQ)
  const second = ensureReady(REQ)
  await tick()
  assert.equal(schema.calls.length, 1, 'ensureSchema called once')
  schema.calls[0]!.resolve()
  await Promise.all([first, second])
  assert.equal(schema.calls.length, 1, 'still once after both resolve')
  assert.equal(counts.grants, 1, 'the app grants run starts once per process, not per request')
})

test('a request that arrives while the DDL runs waits for it to finish', async () => {
  const schema = controlledSchema()
  const { ensureReady } = deps(schema.ensureSchema)
  const first = ensureReady(REQ)
  await tick()
  let secondDone = false
  const second = ensureReady(REQ).then(() => {
    secondDone = true
  })
  await tick()
  assert.equal(secondDone, false, 'second request must not proceed before the schema exists')
  for (const c of schema.calls) c.resolve()
  await Promise.all([first, second])
  assert.equal(secondDone, true)
})

test('after the schema is ready, later requests skip the DDL', async () => {
  const schema = controlledSchema()
  const { ensureReady } = deps(schema.ensureSchema)
  const first = ensureReady(REQ)
  await tick()
  schema.calls[0]!.resolve()
  await first
  await ensureReady(REQ)
  await ensureReady(REQ)
  assert.equal(schema.calls.length, 1)
})

test('a failed DDL rejects its waiters and is retried by the next request', async () => {
  const schema = controlledSchema()
  const { ensureReady, counts } = deps(schema.ensureSchema)
  const first = ensureReady(REQ)
  await tick()
  schema.calls[0]!.reject(new Error('ddl failed'))
  await assert.rejects(first, /ddl failed/)

  const retry = ensureReady(REQ)
  await tick()
  assert.equal(schema.calls.length, 2, 'the next request runs the DDL again')
  schema.calls[1]!.resolve()
  await retry
})

// W1-5: the per-request ensureSpGrants is gone. One grants run starts after the
// schema is ready, in the background: a slow or hanging run never holds a request.
test('the app grants run never blocks a request', async () => {
  const schema = controlledSchema()
  let started = 0
  const { ensureReady } = deps(schema.ensureSchema, {
    startAppGrants: () => {
      started++
      return new Promise(() => {}) // never settles
    },
  })
  const first = ensureReady(REQ)
  await tick()
  schema.calls[0]!.resolve()
  await first
  await ensureReady(REQ)
  assert.equal(started, 1)
})

test('a failing app grants run is swallowed (warned), the request still succeeds', async () => {
  const schema = controlledSchema()
  const { ensureReady } = deps(schema.ensureSchema, {
    startAppGrants: async () => {
      throw new Error('no owner identity')
    },
  })
  const first = ensureReady(REQ)
  await tick()
  schema.calls[0]!.resolve()
  await first
  await tick()
})

// 0002 deferred (ownership not normalized yet): the app keeps serving on public,
// and a later request retries the migrations after the cooldown instead of the
// latch keeping the old schema for the life of the process.
test('a deferred migration is retried after the cooldown, not on every request', async () => {
  const schema = controlledSchema()
  const clock = { t: 0 }
  const { ensureReady } = deps(schema.ensureSchema, { now: () => clock.t })
  const first = ensureReady(REQ)
  await tick()
  schema.calls[0]!.resolve({ applied: [], deferred: [2] })
  await first
  await ensureReady(REQ)
  assert.equal(schema.calls.length, 1, 'inside the cooldown the latch holds')
  clock.t += 61_000
  const later = ensureReady(REQ)
  await tick()
  assert.equal(schema.calls.length, 2, 'after the cooldown the migrations run again')
  schema.calls[1]!.resolve({ applied: [2], deferred: [] })
  await later
  clock.t += 10 * 60_000
  await ensureReady(REQ)
  assert.equal(schema.calls.length, 2, 'once nothing is deferred the latch holds for good')
})
