// Per-session turn lock (server/turnLock.js): one turn at a time per chat
// session, refused (not queued) when busy, with a stale-holder takeover so a
// hung turn can never leave a session busy forever.
//
//   node --test server/turnLock.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('./turnLock.js').catch(() => ({}))

function lock(opts) {
  assert.equal(typeof mod.createTurnLock, 'function', 'server/turnLock.js must export createTurnLock')
  return mod.createTurnLock(opts)
}

test('the first acquire on a key wins and a second one is refused', () => {
  const l = lock()
  assert.equal(typeof l.acquire('7'), 'function')
  assert.equal(l.acquire('7'), null)
})

test('keys are independent', () => {
  const l = lock()
  assert.ok(l.acquire('7'))
  assert.ok(l.acquire('8'))
})

test('a number id and its string are the same key', () => {
  const l = lock()
  assert.ok(l.acquire(7))
  assert.equal(l.acquire('7'), null)
})

test('release frees the key, and releasing twice is harmless', () => {
  const l = lock()
  const release = l.acquire('7')
  release()
  release()
  const again = l.acquire('7')
  assert.equal(typeof again, 'function')
  assert.equal(l.acquire('7'), null, 'the double release did not free the new holder')
})

test('busy reports since as an ISO timestamp of the acquire, and null when free', () => {
  let t = Date.parse('2026-11-18T10:00:00.000Z')
  const l = lock({ now: () => t })
  assert.equal(l.busy('7'), null)
  const release = l.acquire('7')
  t += 5000
  assert.deepEqual(l.busy('7'), { since: '2026-11-18T10:00:00.000Z' })
  release()
  assert.equal(l.busy('7'), null)
})

test('a holder older than staleMs can be taken over, and its late release does not free the new holder', () => {
  let t = 0
  const l = lock({ staleMs: 1000, now: () => t })
  const oldRelease = l.acquire('7')
  t = 999
  assert.equal(l.acquire('7'), null, 'not stale yet')
  t = 1000
  const newRelease = l.acquire('7')
  assert.equal(typeof newRelease, 'function', 'stale holder taken over')
  oldRelease()
  assert.equal(l.acquire('7'), null, 'the stale release left the new holder in place')
  assert.deepEqual(l.busy('7'), { since: new Date(1000).toISOString() })
  newRelease()
  assert.equal(l.busy('7'), null)
})

test('busy is null for a stale holder', () => {
  let t = 0
  const l = lock({ staleMs: 1000, now: () => t })
  l.acquire('7')
  t = 1000
  assert.equal(l.busy('7'), null)
})

test('the default stale timeout is 15 minutes', () => {
  let t = 0
  const l = lock({ now: () => t })
  l.acquire('7')
  t = 15 * 60 * 1000 - 1
  assert.equal(l.acquire('7'), null)
  t = 15 * 60 * 1000
  assert.ok(l.acquire('7'))
})

test('touch() keeps a live turn from going stale, and busy.since stays the start of the turn', () => {
  let t = 0
  const l = lock({ staleMs: 1000, now: () => t })
  const release = l.acquire('7')
  assert.equal(typeof release.touch, 'function')
  t = 900
  release.touch()
  t = 1800
  assert.equal(l.acquire('7'), null, 'still live: last activity at 900 ms')
  assert.deepEqual(l.busy('7'), { since: new Date(0).toISOString() })
  t = 1900
  assert.ok(l.acquire('7'), 'stale 1000 ms after the last activity')
})

test('touch() from a taken-over hold does not refresh the new holder', () => {
  let t = 0
  const l = lock({ staleMs: 1000, now: () => t })
  const old = l.acquire('7')
  t = 1000
  const fresh = l.acquire('7')
  assert.ok(fresh)
  t = 1999
  old.touch()
  t = 2000
  assert.ok(l.acquire('7'), 'the new hold went stale; the old touch did not count')
})
