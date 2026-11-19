// Turn-time MCP admission (W2-11d): every MCP tool def offered to the model
// comes from a connection the credential admission (W2-11c / PR #83) admits.
// A ref to a shared-credential service adopted before #83 — or written straight
// into a session — gets NO tools; an admitted connection keeps resolving; the
// web search slot's designated service is not filtered; and the turn reads the
// admission cache only (a cold entry fails closed and warms in the background,
// never a classification awaited on the turn). No workspace, no database: the
// MCP listings are primed into the per-turn listing cache.
//
//   node --test server/mcpTurnAdmission.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolDefs } from './tools.js'
import { primeMcpServerCache } from './mcpClient.js'
import * as ext from './externalMcp.js'

const { externalMcpUrl, admitMcpConnection, resetMcpAdmissionCache } = ext

const TOKEN = 'fake-obo-token-not-a-secret'
const USER = 'turn-admission@example.com'
const SHARED = 'acme.tools.shared_key' // by-name service with ONE shared credential (saved pre-#83)
const BYNAME_PER_USER = 'acme.tools.per_user_oauth' // by-name, per-user OAuth
const SLACK = 'system.ai.slack' // curated, per_user
const DESIGNATED = 'acme.search.firecrawl' // the web search slot's designated service
const CATALOG = [{ connectionName: SLACK, displayName: 'Slack', source: 'curated', hidden: false, credentialClass: 'per_user' }]

const LISTING = { tools: [{ name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object', properties: {} } }], instructions: '' }
for (const name of [SHARED, BYNAME_PER_USER, SLACK, DESIGNATED]) primeMcpServerCache(externalMcpUrl(name), USER, LISTING)

const ref = (connectionName) => ({ kind: 'mcp-external', connectionName })
const mcpInfo = new Map(CATALOG.map((e) => [e.connectionName, e]))
const mcpNames = (built) => built.tools.map((t) => t.function.name).filter((n) => n.startsWith('mcp_'))
const fromService = (built, name) => [...built.resolvers.values()].filter((r) => (r.ref?.connectionName || r.connectionName) === name)
const NOT_REGISTERED = { registered: false, shadowedServices: new Set(), designatedServices: new Set([DESIGNATED]), reason: 'test' }
const REGISTERED = { registered: true, shadowedServices: new Set(['system.ai.web_search', DESIGNATED]), designatedServices: new Set([DESIGNATED]), reason: 'test' }

/** A classifier that counts calls and answers `byName[name]` (or never settles, `pending`). */
function fakeClassifier(byName, { pending = false } = {}) {
  const calls = []
  const fn = (name) => {
    calls.push(name)
    if (pending) return new Promise(() => {})
    return Promise.resolve({ credentialClass: byName[name] || 'unverified', credentialType: null })
  }
  fn.calls = calls
  return fn
}
const build = (refs, opts = {}) => buildToolDefs(refs, TOKEN, USER, { includePython: false, mcpInfo, ...opts })
const settle = () => new Promise((r) => setTimeout(r, 0))

// the background classifier of the turn path (absent before W2-11d: the RED
// run then fails on behavior, not on this setter)
const setClassify = (fn) => {
  if (ext.mcpAdmissionDeps) ext.mcpAdmissionDeps.classify = fn
}

test.beforeEach(() => {
  resetMcpAdmissionCache()
  setClassify(fakeClassifier({}))
})

test('AC-1: a shared-credential ref (warm cache: classified shared) gets no tools and no status tool', async () => {
  const classify = fakeClassifier({ [SHARED]: 'shared' })
  assert.equal((await admitMcpConnection(TOKEN, USER, SHARED, { catalog: CATALOG, classify })).ok, false)
  const built = await build([ref(SHARED)])
  assert.deepEqual(fromService(built, SHARED), [], 'no resolver of any kind for the shared service')
  assert.deepEqual(mcpNames(built), [])
  assert.equal(built.guide, '', 'the refused server is not described to the model')
})

test('AC-1: a by-name ref with a COLD admission cache fails closed (no tools that turn)', async () => {
  const built = await build([ref(SHARED)])
  assert.deepEqual(fromService(built, SHARED), [])
  assert.deepEqual(mcpNames(built), [])
})

test('AC-2: a curated per-user connection keeps its tools with a cold cache (no classification needed)', async () => {
  const classify = fakeClassifier({})
  setClassify(classify)
  const built = await build([ref(SLACK)])
  assert.equal(mcpNames(built).length, 1)
  assert.equal(fromService(built, SLACK)[0].kind, 'mcp-external')
  await settle()
  assert.equal(classify.calls.length, 0, 'a catalog-known admitted class is never re-classified')
})

test('AC-2: a by-name per-user connection admitted on connect keeps its tools on the turn', async () => {
  const classify = fakeClassifier({ [BYNAME_PER_USER]: 'per_user' })
  assert.equal((await admitMcpConnection(TOKEN, USER, BYNAME_PER_USER, { catalog: CATALOG, classify })).ok, true)
  const built = await build([ref(BYNAME_PER_USER), ref(SLACK)])
  assert.equal(fromService(built, BYNAME_PER_USER).length, 1)
  assert.equal(fromService(built, SLACK).length, 1)
})

test('AC-2: mixed refs — only the refused one is dropped, the admitted ones keep their order', async () => {
  const classify = fakeClassifier({ [SHARED]: 'shared', [BYNAME_PER_USER]: 'per_user' })
  await admitMcpConnection(TOKEN, USER, SHARED, { catalog: CATALOG, classify })
  await admitMcpConnection(TOKEN, USER, BYNAME_PER_USER, { catalog: CATALOG, classify })
  const built = await build([ref(SLACK), ref(SHARED), ref(BYNAME_PER_USER)])
  const services = [...built.resolvers.values()].map((r) => r.ref.connectionName)
  assert.deepEqual(services, [SLACK, BYNAME_PER_USER])
})

test('AC-4: the turn never awaits a classification — a classifier that never settles does not block it', async () => {
  const classify = fakeClassifier({}, { pending: true })
  setClassify(classify)
  const built = await build([ref(SHARED), ref(BYNAME_PER_USER), ref(SLACK)])
  assert.deepEqual([...built.resolvers.values()].map((r) => r.ref.connectionName), [SLACK])
})

test('AC-4: a cold entry starts at most ONE background classification per service, deduped across turns', async () => {
  const classify = fakeClassifier({ [BYNAME_PER_USER]: 'per_user' }, { pending: true })
  setClassify(classify)
  await build([ref(BYNAME_PER_USER)])
  await build([ref(BYNAME_PER_USER)])
  await settle()
  assert.deepEqual(classify.calls, [BYNAME_PER_USER])
})

test('cold → the background warm populates the cache → the next turn resolves the admitted tools', async () => {
  const classify = fakeClassifier({ [BYNAME_PER_USER]: 'per_user', [SHARED]: 'shared' })
  setClassify(classify)
  const first = await build([ref(BYNAME_PER_USER), ref(SHARED)])
  assert.deepEqual(mcpNames(first), [], 'cold: nothing that turn')
  await settle()
  const second = await build([ref(BYNAME_PER_USER), ref(SHARED)])
  assert.deepEqual([...second.resolvers.values()].map((r) => r.ref.connectionName), [BYNAME_PER_USER])
  assert.deepEqual(classify.calls.sort(), [BYNAME_PER_USER, SHARED].sort(), 'one classification each')
})

test('staleness: a cached class older than 10 min is cold again (fails closed, re-warms)', async (t) => {
  const classify = fakeClassifier({ [BYNAME_PER_USER]: 'per_user' })
  await admitMcpConnection(TOKEN, USER, BYNAME_PER_USER, { catalog: CATALOG, classify })
  const realNow = Date.now
  t.after(() => (Date.now = realNow))
  const t0 = realNow()
  const rewarm = fakeClassifier({ [BYNAME_PER_USER]: 'per_user' }, { pending: true })
  setClassify(rewarm)
  Date.now = () => t0 + 5 * 60_000 // past the connect path's 60 s, within 10 min: served, refreshed
  assert.equal(fromService(await build([ref(BYNAME_PER_USER)]), BYNAME_PER_USER).length, 1)
  await settle()
  assert.equal(rewarm.calls.length, 1, 'a background refresh started')
  Date.now = () => t0 + 11 * 60_000
  assert.deepEqual(fromService(await build([ref(BYNAME_PER_USER)]), BYNAME_PER_USER), [])
})

test('AC-3: the web search slot\'s designated service is not filtered (native tool off, cold cache)', async () => {
  const built = await build([ref(DESIGNATED)], { webSearch: NOT_REGISTERED })
  assert.equal(fromService(built, DESIGNATED).length, 1)
})

test('AC-3: with the native tool registered the designated service is still shadowed, web_search unchanged', async () => {
  const built = await build([ref(DESIGNATED), ref(SLACK)], { webSearch: REGISTERED })
  const names = built.tools.map((t) => t.function.name)
  assert.deepEqual(names.slice(0, 2), ['web_search', 'web_fetch'])
  assert.deepEqual(fromService(built, DESIGNATED), [])
  assert.equal(fromService(built, SLACK).length, 1)
})

test('the admission filter never touches non-MCP tools or the artifact tools', async () => {
  const built = await build([ref(SHARED), { kind: 'genie-one' }], { includePython: true, artifacts: { deck: true } })
  const names = built.tools.map((t) => t.function.name)
  assert.ok(names.includes('python') || names.some((n) => /python/.test(n)))
  assert.ok(names.includes('ask_genie_one') || names.some((n) => /genie/.test(n)))
  assert.ok(names.some((n) => /deck/.test(n)), names.join(','))
  assert.deepEqual(mcpNames(built), [])
})
