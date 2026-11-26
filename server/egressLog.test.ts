// logEgress: one JSON line per blocked egress, hosts only, capped per user.
//   node --test server/egressLog.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEgressLogger } from './egressLog.ts'
import { setLogWriter, runWithRequestContext } from './log.ts'

type Line = { level: string; msg: string; user_hash: string | null; route: string | null }

function capture() {
  const lines: Line[] = []
  const prev = setLogWriter((l) => lines.push(JSON.parse(l)))
  return { lines, restore: () => setLogWriter(prev) }
}
const payload = (l: Line) => JSON.parse(l.msg)
const asUser = <T>(email: string, fn: () => T): T => runWithRequestContext({ requestId: 'r1', req: { email } }, fn)

test('logEgress writes one warn line with {event, surface, kind, hosts, count, route}', () => {
  const c = capture()
  try {
    const logEgress = makeEgressLogger({ env: {}, now: () => 0 })
    asUser('a@x.com', () => logEgress({ surface: 'answer', kind: 'image', hosts: ['evil.com', 'img.evil2.com'], route: 'POST /api/sessions/:id/messages' }))
    assert.equal(c.lines.length, 1)
    assert.equal(c.lines[0]!.level, 'warn')
    assert.deepEqual(payload(c.lines[0]!), { event: 'egress_blocked', surface: 'answer', kind: 'image', hosts: ['evil.com', 'img.evil2.com'], count: 2, route: 'POST /api/sessions/:id/messages' })
    assert.match(c.lines[0]!.user_hash || '', /^[0-9a-f]{12}$/)
  } finally {
    c.restore()
  }
})

test('logEgress emits hosts only: paths, queries, userinfo, ports and fragments are cut', () => {
  const c = capture()
  try {
    const logEgress = makeEgressLogger({ env: {}, now: () => 0 })
    logEgress({ surface: 'deck', kind: 'css', hosts: ['Evil.com/p.png?d=SECRET', 'https://u:pw@x.evil.com:8443/a#frag', 'ok.evil.com?token=abc', 'bad host', ''], route: 'PATCH /api/x?token=SECRET' })
    const p = payload(c.lines[0]!)
    assert.deepEqual(p.hosts, ['evil.com', 'x.evil.com', 'ok.evil.com'])
    assert.equal(p.route, 'PATCH /api/x')
    assert.equal(c.lines[0]!.msg.includes('SECRET'), false)
    assert.equal(/[?#]|pw|frag/.test(c.lines[0]!.msg), false)
  } finally {
    c.restore()
  }
})

test('logEgress lists at most 10 hosts but counts all of them; hosts are deduped', () => {
  const c = capture()
  try {
    const logEgress = makeEgressLogger({ env: {}, now: () => 0 })
    const hosts = [...Array.from({ length: 15 }, (_, i) => `h${i}.evil.com`), 'h0.evil.com']
    logEgress({ surface: 'document', kind: 'link', hosts })
    const p = payload(c.lines[0]!)
    assert.equal(p.hosts.length, 10)
    assert.equal(p.count, 15)
    assert.equal(p.route, null)
  } finally {
    c.restore()
  }
})

test('logEgress writes nothing when there is no valid host', () => {
  const c = capture()
  try {
    const logEgress = makeEgressLogger({ env: {}, now: () => 0 })
    logEgress({ surface: 'answer', kind: 'image', hosts: [] })
    logEgress({ surface: 'answer', kind: 'image', hosts: ['', ' ', '/x'] })
    assert.equal(c.lines.length, 0)
  } finally {
    c.restore()
  }
})

test('logEgress is capped per user (EGRESS_LOG_PER_MIN, default 60) and refills with time', () => {
  const c = capture()
  try {
    let t = 0
    const logEgress = makeEgressLogger({ env: { EGRESS_LOG_PER_MIN: '3' }, now: () => t })
    const emit = (email: string) => asUser(email, () => logEgress({ surface: 'answer', kind: 'image', hosts: ['evil.com'] }))
    for (let i = 0; i < 10; i++) emit('a@x.com')
    assert.equal(c.lines.length, 3)
    emit('b@x.com') // another user has its own bucket
    assert.equal(c.lines.length, 4)
    t = 60_000
    emit('a@x.com')
    assert.equal(c.lines.length, 5)
  } finally {
    c.restore()
  }
})

test('logEgress default cap is 60 per minute per user', () => {
  const c = capture()
  try {
    const logEgress = makeEgressLogger({ env: {}, now: () => 0 })
    for (let i = 0; i < 100; i++) asUser('a@x.com', () => logEgress({ surface: 'web_fetch', kind: 'url', hosts: ['evil.com'] }))
    assert.equal(c.lines.length, 60)
  } finally {
    c.restore()
  }
})

test('logEgress never throws into the caller', () => {
  const c = capture()
  try {
    const logEgress = makeEgressLogger({ env: {}, now: () => 0 })
    assert.doesNotThrow(() => logEgress({ surface: 'answer', kind: 'image', hosts: null as unknown as string[] }))
    assert.doesNotThrow(() => logEgress(undefined as never))
  } finally {
    c.restore()
  }
})
