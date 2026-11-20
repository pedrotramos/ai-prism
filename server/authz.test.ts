// server/authz.ts: owner resolution from env, the SCIM /Me request, the group
// lookup (and the 'ok' | 'unavailable' status it drives) and the owner
// short-circuit of isAdmin. No database: the admins table is never reached.
//
//   node --test server/authz.test.ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchScimMe, groupCheckStatus, isAdmin, isOwner, ownerEmail, userGroups, workspaceHost } from './authz.ts'

const KEYS = ['APP_OWNER_EMAIL', 'DATABRICKS_USER_EMAIL', 'DATABRICKS_HOST'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const realFetch = globalThis.fetch
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  globalThis.fetch = realFetch
})

test('ownerEmail: APP_OWNER_EMAIL wins over DATABRICKS_USER_EMAIL, trimmed and lowercased; empty when neither is set', () => {
  process.env.APP_OWNER_EMAIL = '  Boss@Example.com '
  process.env.DATABRICKS_USER_EMAIL = 'dev@example.com'
  assert.equal(ownerEmail(), 'boss@example.com')
  delete process.env.APP_OWNER_EMAIL
  assert.equal(ownerEmail(), 'dev@example.com')
  delete process.env.DATABRICKS_USER_EMAIL
  assert.equal(ownerEmail(), '')
})

test('isOwner: case-insensitive match; never true without an owner or without an email', () => {
  process.env.APP_OWNER_EMAIL = 'boss@example.com'
  assert.equal(isOwner(' BOSS@example.com '), true)
  assert.equal(isOwner('other@example.com'), false)
  assert.equal(isOwner(null), false)
  assert.equal(isOwner(undefined), false)
  delete process.env.APP_OWNER_EMAIL
  delete process.env.DATABRICKS_USER_EMAIL
  assert.equal(isOwner('boss@example.com'), false)
})

test('workspaceHost: adds https:// when the host has no scheme, keeps one that has it, empty when unset', () => {
  process.env.DATABRICKS_HOST = 'adb-1.azuredatabricks.net'
  assert.equal(workspaceHost(), 'https://adb-1.azuredatabricks.net')
  process.env.DATABRICKS_HOST = 'https://adb-2.azuredatabricks.net'
  assert.equal(workspaceHost(), 'https://adb-2.azuredatabricks.net')
  delete process.env.DATABRICKS_HOST
  assert.equal(workspaceHost(), '')
})

test('fetchScimMe: GET /Me with the caller token as bearer, attributes URL-encoded, signal passed through', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response('{}')
  }) as typeof fetch
  const ac = new AbortController()
  await fetchScimMe('tok', { attributes: 'groups,userName', fetchImpl, base: 'https://h.example', signal: ac.signal })
  await fetchScimMe('tok2', { fetchImpl, base: 'https://h.example' })
  assert.equal(calls[0]!.url, 'https://h.example/api/2.0/preview/scim/v2/Me?attributes=groups%2CuserName')
  assert.deepEqual(calls[0]!.init?.headers, { authorization: 'Bearer tok' })
  assert.equal(calls[0]!.init?.signal, ac.signal)
  assert.equal(calls[1]!.url, 'https://h.example/api/2.0/preview/scim/v2/Me')
})

test('userGroups: lowercases group names, caches per email, and flips groupCheckStatus when SCIM fails', async () => {
  process.env.DATABRICKS_HOST = 'https://h.example'
  let n = 0
  globalThis.fetch = (async () => {
    n++
    return new Response(JSON.stringify({ groups: [{ display: 'Data-Admins' }, { display: 'Eng' }, {}] }))
  }) as typeof fetch
  const g = await userGroups('ana@example.com', 'tok')
  assert.deepEqual([...g].sort(), ['data-admins', 'eng'])
  assert.equal(groupCheckStatus(), 'ok')
  await userGroups('ana@example.com', 'tok')
  assert.equal(n, 1, 'second lookup is served from the cache')

  globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch
  const none = await userGroups('bia@example.com', 'tok')
  assert.equal(none.size, 0)
  assert.equal(groupCheckStatus(), 'unavailable')

  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  assert.equal((await userGroups('caio@example.com', 'tok')).size, 0)
  assert.equal(groupCheckStatus(), 'unavailable')
})

test('isAdmin: the owner is an admin without touching the admins table', async () => {
  process.env.APP_OWNER_EMAIL = 'boss@example.com'
  assert.equal(await isAdmin('Boss@Example.com', 'tok'), true)
})
