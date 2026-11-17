// The lazy schema latch behind every API route (server/middleware/ensureReady.js).
// The schema DDL must run once per process even when the first requests arrive
// together (a cold app usually gets several at once: /api/me, /api/models,
// /api/sessions), and a failed DDL must be retried by a later request.
// No database: ensureSchema/ensureSpGrants/startUsageBackfill are stubs.
//
//   node --test server/middleware/ensureReady.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnsureReady } from './ensureReady.js'

const REQ = { email: 'a@test.invalid', token: 'tok-a' }

// a DDL stub the test resolves or rejects by hand, counting its calls
function controlledSchema() {
  const calls = []
  const ensureSchema = (email, token) => {
    let resolve, reject
    const p = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    calls.push({ email, token, resolve, reject })
    return p
  }
  return { calls, ensureSchema }
}

function deps(ensureSchema) {
  const counts = { grants: 0, backfill: 0 }
  return {
    counts,
    ensureReady: createEnsureReady({
      ensureSchema,
      ensureSpGrants: async () => {
        counts.grants++
      },
      startUsageBackfill: () => {
        counts.backfill++
      },
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
  schema.calls[0].resolve()
  await Promise.all([first, second])
  assert.equal(schema.calls.length, 1, 'still once after both resolve')
  assert.equal(counts.backfill, 1, 'usage backfill started once')
  assert.equal(counts.grants, 2, 'SP grants are attempted on every request')
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
  schema.calls[0].resolve()
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
  schema.calls[0].reject(new Error('ddl failed'))
  await assert.rejects(first, /ddl failed/)
  assert.equal(counts.backfill, 0, 'no backfill when the schema failed')

  const retry = ensureReady(REQ)
  await tick()
  assert.equal(schema.calls.length, 2, 'the next request runs the DDL again')
  schema.calls[1].resolve()
  await retry
  assert.equal(counts.backfill, 1)
})
