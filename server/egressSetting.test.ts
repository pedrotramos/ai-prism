// The allowlist source the CSP header reads synchronously: the admin setting (app_settings.external_asset_origins) read at
// most every 15 s, single-flight, last good value on failure, and the EXTERNAL_ASSET_ORIGINS env as a floor. Fake clock.
//
//   node --test server/egressSetting.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEgressSetting, EGRESS_SETTING_TTL_MS } from './egressSetting.ts'

const tick = () => new Promise((r) => setImmediate(r))

function harness(over: { env?: Record<string, string | undefined>; values?: Array<string[] | Error> } = {}) {
  let t = 1_000_000
  const reads: number[] = []
  const queue = [...(over.values || [])]
  const s = createEgressSetting({
    read: async () => {
      reads.push(t)
      const v = queue.length > 1 ? queue.shift()! : queue[0]!
      if (v instanceof Error) throw v
      return v
    },
    env: over.env || {},
    now: () => t,
    log: () => {},
  })
  return { s, reads, advance: (ms: number) => (t += ms) }
}

test('TTL is 15 s', () => assert.equal(EGRESS_SETTING_TTL_MS, 15_000))

test('before the first read: the env floor alone (never anything else); the first call starts one read', async () => {
  const h = harness({ env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com' }, values: [['https://a.example.com']] })
  assert.deepEqual(h.s.current(), ['https://floor.example.com'])
  assert.equal(h.reads.length, 1)
  await tick()
  assert.deepEqual(h.s.current(), ['https://floor.example.com', 'https://a.example.com'])
})

test('a fresh value is served without another read; after the TTL one background read refreshes it', async () => {
  const h = harness({ values: [['https://a.example.com'], ['https://b.example.com']] })
  h.s.current()
  await tick()
  h.advance(14_999)
  assert.deepEqual(h.s.current(), ['https://a.example.com'])
  assert.equal(h.reads.length, 1)
  h.advance(2)
  assert.deepEqual(h.s.current(), ['https://a.example.com'], 'stale value served while the refresh runs')
  assert.equal(h.reads.length, 2)
  await tick()
  assert.deepEqual(h.s.current(), ['https://b.example.com'])
})

test('single-flight: concurrent refreshes share one read', async () => {
  const h = harness({ values: [['https://a.example.com']] })
  const [a, b, c] = [h.s.refresh(), h.s.refresh(), h.s.refresh()]
  await Promise.all([a, b, c])
  assert.equal(h.reads.length, 1)
})

test('a failed refresh keeps the last good value and is not retried inside the TTL', async () => {
  const h = harness({ values: [['https://a.example.com'], new Error('db down')] })
  h.s.current()
  await tick()
  h.advance(15_001)
  h.s.current()
  await tick()
  assert.equal(h.reads.length, 2)
  assert.deepEqual(h.s.current(), ['https://a.example.com'])
  assert.equal(h.reads.length, 2, 'no hammering while the database is down')
  h.advance(15_001)
  h.s.current()
  assert.equal(h.reads.length, 3)
})

test('a first-ever failure leaves the env floor, and refresh() itself never rejects', async () => {
  const h = harness({ env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com' }, values: [new Error('db down')] })
  await h.s.refresh()
  assert.deepEqual(h.s.current(), ['https://floor.example.com'])
})

test('invalid values stored in the setting are dropped on read (defence in depth); env ∪ setting is deduped', async () => {
  const h = harness({ env: { EXTERNAL_ASSET_ORIGINS: 'https://a.example.com' }, values: [['https://a.example.com', 'https://*.evil.example', 'http://x.example.com', 'https://b.example.com']] })
  await h.s.refresh()
  assert.deepEqual(h.s.current(), ['https://a.example.com', 'https://b.example.com'])
})

test('invalidate() makes the next read happen at once; the saved value is visible after refresh()', async () => {
  const h = harness({ values: [[], ['https://new.example.com']] })
  await h.s.refresh()
  assert.deepEqual(h.s.current(), [])
  h.s.invalidate()
  await h.s.refresh()
  assert.deepEqual(h.s.current(), ['https://new.example.com'])
  assert.equal(h.reads.length, 2)
})
