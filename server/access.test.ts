// Project access layer (W2-3, design D4): roles owner > manage > view, the
// decision table every project route asks, principal normalisation, and the
// SCIM group lookup that must fail CLOSED (an error never grants a group).
//
//   node --test server/access.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

const access = (await import('./access.ts').catch(() => ({}))) as typeof import('./access.ts') // the {} fallback makes `fn` fail loudly

// a loose handle on an export by name: the assertions call each one with the argument shapes under test
function fn(name: string) {
  const exports = access as unknown as Record<string, (...args: any[]) => any> // calls below pass deliberately odd values
  assert.equal(typeof exports[name], 'function', `server/access.ts must export ${name}`)
  return exports[name]!
}

test('roles rank owner > manage > view; anything else ranks 0', () => {
  const roleRank = fn('roleRank')
  assert.equal(roleRank('owner'), 3)
  assert.equal(roleRank('manage'), 2)
  assert.equal(roleRank('view'), 1)
  for (const x of [null, undefined, '', 'admin', 'OWNER', 'viewer', 3, {}]) assert.equal(roleRank(x), 0, JSON.stringify(x))
})

// The D4 matrix: non-members (null role, app admins included) get 404 so a
// project's existence never leaks; members below the needed role get 403.
const MATRIX = [
  // action            owner manage view  none
  ['read',              200, 200, 200, 404],
  ['post',              200, 200, 200, 404],
  ['attachSession',     200, 200, 200, 404],
  ['editProject',       200, 200, 403, 404],
  ['manageMembers',     200, 200, 403, 404],
  ['manageFiles',       200, 200, 403, 404],
  ['detachSession',     200, 200, 403, 404],
  ['deleteProject',     200, 403, 403, 404],
]

test('decide(role, action) returns the D4 matrix codes, DENY cells included', () => {
  const decide = fn('decide')
  for (const [action, owner, manage, view, none] of MATRIX) {
    assert.equal(decide('owner', action), owner, `owner × ${action}`)
    assert.equal(decide('manage', action), manage, `manage × ${action}`)
    assert.equal(decide('view', action), view, `view × ${action}`)
    assert.equal(decide(null, action), none, `non-member × ${action}`)
    assert.equal(decide('admin', action), none, `an unknown role is a non-member × ${action}`)
  }
})

test('decide refuses an unknown action for every role (no default allow)', () => {
  const decide = fn('decide')
  for (const role of ['owner', 'manage', 'view']) assert.equal(decide(role, 'everything'), 403)
  assert.equal(decide(null, 'everything'), 404)
})

test('canAssignRole: manage grants up to manage, only owner grants owner, view grants nothing', () => {
  const canAssignRole = fn('canAssignRole')
  assert.equal(canAssignRole('owner', 'owner'), true)
  assert.equal(canAssignRole('owner', 'manage'), true)
  assert.equal(canAssignRole('owner', 'view'), true)
  assert.equal(canAssignRole('manage', 'owner'), false)
  assert.equal(canAssignRole('manage', 'manage'), true)
  assert.equal(canAssignRole('manage', 'view'), true)
  assert.equal(canAssignRole('view', 'view'), false)
  assert.equal(canAssignRole(null, 'view'), false)
  assert.equal(canAssignRole('owner', 'admin'), false, 'not a role')
})

test('normalizePrincipal lowercases and trims; rejects empty, malformed and control characters', () => {
  const normalizePrincipal = fn('normalizePrincipal')
  assert.equal(normalizePrincipal('user', '  Ana.Silva@Example.COM '), 'ana.silva@example.com')
  assert.equal(normalizePrincipal('group', ' Data Team '), 'data team')
  for (const bad of ['', '   ', 'no-at-sign', '@x', 'a@', 'a b@x.com', 'a@x.com\n', null, undefined, 42]) {
    assert.equal(normalizePrincipal('user', bad), null, `user ${JSON.stringify(bad)}`)
  }
  for (const bad of ['', '  ', 'tab\there', 'x'.repeat(257), null]) {
    assert.equal(normalizePrincipal('group', bad), null, `group ${JSON.stringify(bad)}`)
  }
  assert.equal(normalizePrincipal('role', 'a@x.com'), null, 'unknown kind')
})

// ---- SCIM groups, fail closed ----------------------------------------------

function scimResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function resolverWith(fetchImpl: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => unknown, extra = {}) {
  const createGroupResolver = fn('createGroupResolver')
  let t = 0
  const clock = { now: () => t, advance: (ms: number) => (t += ms) }
  const resolve = createGroupResolver({ fetchImpl, host: () => 'https://ws.example', now: clock.now, ...extra })
  return { resolve, clock }
}

test('groups: a 200 with display names → lowercased names', async () => {
  const { resolve } = resolverWith(async () => scimResponse(200, { groups: [{ display: 'Data Team' }, { display: 'Finance' }, { value: 'no-display' }] }))
  assert.deepEqual((await resolve('a@x.com', 'tok')).sort(), ['data team', 'finance'])
})

test('groups fail closed: HTTP error, network error, timeout, malformed body → no groups', async () => {
  const cases = {
    'HTTP 403': async () => scimResponse(403, { detail: 'scope' }),
    'HTTP 500': async () => scimResponse(500, {}),
    'network error': async () => {
      throw new Error('ECONNRESET')
    },
    'groups not an array': async () => scimResponse(200, { groups: 'Data Team' }),
    'body not JSON': async () => ({ ok: true, status: 200, json: async () => JSON.parse('{') }),
    'timeout': (url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  }
  for (const [name, impl] of Object.entries(cases)) {
    const { resolve } = resolverWith(impl, { timeoutMs: 20 })
    assert.deepEqual(await resolve('a@x.com', 'tok'), [], name)
  }
})

test('groups: no identity, no token or no host → no groups and no SCIM call', async () => {
  let calls = 0
  const impl = async () => {
    calls++
    return scimResponse(200, { groups: [{ display: 'g' }] })
  }
  const createGroupResolver = fn('createGroupResolver')
  const resolve = createGroupResolver({ fetchImpl: impl, host: () => 'https://ws.example' })
  assert.deepEqual(await resolve('', 'tok'), [])
  assert.deepEqual(await resolve('a@x.com', ''), [])
  assert.deepEqual(await createGroupResolver({ fetchImpl: impl, host: () => '' })('a@x.com', 'tok'), [])
  assert.equal(calls, 0)
})

test('groups: a success is cached; a failure is cached shorter and then retried', async () => {
  let calls = 0
  let fail = true
  const { resolve, clock } = resolverWith(
    async () => {
      calls++
      return fail ? scimResponse(500, {}) : scimResponse(200, { groups: [{ display: 'g' }] })
    },
    { ttlMs: 1000, failTtlMs: 100 }
  )
  assert.deepEqual(await resolve('a@x.com', 'tok'), [])
  assert.deepEqual(await resolve('a@x.com', 'tok'), [])
  assert.equal(calls, 1, 'the failure is cached')
  fail = false
  clock.advance(101)
  assert.deepEqual(await resolve('a@x.com', 'tok'), ['g'])
  clock.advance(500)
  assert.deepEqual(await resolve('a@x.com', 'tok'), ['g'])
  assert.equal(calls, 2, 'the success is cached for ttlMs')
})

test('groups: the cache is per e-mail (one user never gets another user’s groups)', async () => {
  const { resolve } = resolverWith(async (url, init) =>
    scimResponse(200, { groups: [{ display: init.headers.authorization === 'Bearer ta' ? 'ga' : 'gb' }] })
  )
  assert.deepEqual(await resolve('a@x.com', 'ta'), ['ga'])
  assert.deepEqual(await resolve('b@x.com', 'tb'), ['gb'])
})

test('an explicit partial SCIM response fails closed instead of granting from its partial group list', async () => {
  const { resolve } = resolverWith(async () => scimResponse(206, {
    groups: [{ display: 'Data Team' }],
    totalResults: 2,
  }))
  assert.deepEqual(await resolve('a@x.com', 'tok'), [], 'an incomplete group list must grant no project memberships')
})

test('groups fail closed on anything but a complete 200: other 2xx, totalResults beyond the list, a malformed entry', async () => {
  const cases = {
    'HTTP 203': scimResponse(203, { groups: [{ display: 'g' }] }),
    'HTTP 204': scimResponse(204, { groups: [{ display: 'g' }] }),
    '200 with totalResults > groups': scimResponse(200, { groups: [{ display: 'g' }], totalResults: 2 }),
    '200 with itemsPerPage < totalResults': scimResponse(200, { groups: [{ display: 'g' }], totalResults: 3, itemsPerPage: 1 }),
    '200 with a group entry that is not an object': scimResponse(200, { groups: [{ display: 'g' }, 'h'] }),
  }
  for (const [name, response] of Object.entries(cases)) {
    const { resolve } = resolverWith(async () => response)
    assert.deepEqual(await resolve('a@x.com', 'tok'), [], name)
  }
  // a complete 200 still grants (totalResults equal to the list is complete)
  const { resolve } = resolverWith(async () => scimResponse(200, { groups: [{ display: 'G' }], totalResults: 1 }))
  assert.deepEqual(await resolve('a@x.com', 'tok'), ['g'])
})
