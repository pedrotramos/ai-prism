// Skill embedding backfill under row-level security (W2-1): a global skill's
// embedding can only be written by an admin request, so a non-admin's turn keeps
// the computed vector in a process-wide memo instead of re-embedding every turn.
// No database: embed / setSkillEmbedding / isAdmin are fakes.
//
//   node --test server/skills.test.js
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ensureEmbeddings, resetGlobalSkillVectors } from './skills.js'

const req = { email: 'u@test.invalid', token: 'tok' }

function fakes({ admin = false } = {}) {
  const calls = { embed: 0, texts: [], persisted: [] }
  return {
    calls,
    deps: {
      embed: async (_token, texts) => {
        calls.embed++
        calls.texts.push(...texts)
        return texts.map((_, i) => [i + 1, 0.5])
      },
      setSkillEmbedding: async (_email, _token, id, vec, opts) => {
        calls.persisted.push({ id, vec, admin: opts?.admin === true })
      },
      isAdmin: async () => admin,
    },
  }
}

const skill = (id, scope, extra = {}) => ({ id, scope, title: `t${id}`, description: `d${id}`, embedding: null, ...extra })

beforeEach(() => resetGlobalSkillVectors())

test('non-admin: a missing global embedding is computed once per process and never written', async () => {
  const { calls, deps } = fakes({ admin: false })
  const first = [skill('g1', 'global')]
  await ensureEmbeddings(req, first, deps)
  assert.deepEqual(first[0].embedding, [1, 0.5])
  assert.equal(calls.embed, 1)
  assert.deepEqual(calls.persisted, [], 'RLS would refuse it: no write attempted')

  // the next turn reloads the row (embedding still NULL in the database)
  const second = [skill('g1', 'global')]
  await ensureEmbeddings(req, second, deps)
  assert.deepEqual(second[0].embedding, [1, 0.5], 'served from the memo')
  assert.equal(calls.embed, 1, 'no second embedding call')
})

test('an edited global skill (new title/description) is embedded again', async () => {
  const { calls, deps } = fakes()
  await ensureEmbeddings(req, [skill('g1', 'global')], deps)
  await ensureEmbeddings(req, [skill('g1', 'global', { title: 'renamed' })], deps)
  assert.equal(calls.embed, 2)
})

test('admin: a global embedding is persisted with the admin flag', async () => {
  const { calls, deps } = fakes({ admin: true })
  await ensureEmbeddings(req, [skill('g1', 'global')], deps)
  assert.deepEqual(calls.persisted, [{ id: 'g1', vec: [1, 0.5], admin: true }])
})

test("a user's own skill is persisted without the admin flag, and not memoised", async () => {
  const { calls, deps } = fakes({ admin: true })
  await ensureEmbeddings(req, [skill('u1', 'user')], deps)
  assert.deepEqual(calls.persisted, [{ id: 'u1', vec: [1, 0.5], admin: false }])
  await ensureEmbeddings(req, [skill('u1', 'user')], deps)
  assert.equal(calls.embed, 2, 'user skills persist in the database, not the process memo')
})

test('no global skill missing → the admin check is not even called', async () => {
  let checked = 0
  const { deps } = fakes()
  deps.isAdmin = async () => {
    checked++
    return false
  }
  await ensureEmbeddings(req, [skill('u1', 'user'), skill('g1', 'global', { embedding: [9] })], deps)
  assert.equal(checked, 0)
})
