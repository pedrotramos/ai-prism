// auth() tells the agent scheduler that a request reached this process (server/agents/events.ts), and only for a
// request that carries an identity: a 401 is not activity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { auth } from './auth.ts'
import { onAgentsActivity } from '../agents/events.ts'

process.env.IDENTITY_BINDING = 'off'

function run(headers: Record<string, string>) {
  let activity = 0
  const off = onAgentsActivity(() => void activity++)
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json() {
      return this
    },
  })
  let nexted = false
  try {
    auth({ headers } as never, res as never, () => void (nexted = true))
  } finally {
    off()
  }
  return { activity, nexted, status: res.statusCode }
}

test('a request with an identity is activity; one without is a 401 and is not', () => {
  const ok = run({ 'x-forwarded-email': 'a@test.invalid', 'x-forwarded-access-token': 't' })
  assert.equal(ok.activity, 1)
  assert.equal(ok.nexted, true)
  const none = run({})
  assert.equal(none.status, 401)
  assert.equal(none.activity, 0)
})
