// N7 item 1: reading /api/tool-policy warms the user's adopted MCP connections
// in the background (credential admission + the tool listing), so a by-name
// connection has its tools on the first turn after a restart or 10 idle
// minutes. Never awaited by the request; deduped per user.
//
//   node --test server/mcpWarm.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { warmUserMcpConnections, resetMcpWarm } from './mcpWarm.ts'
import registerModelRoutes from './routes/models.ts'

const USER = 'warm@example.com'
const TOKEN = 'fake-obo-token-not-a-secret'
const tick = () => new Promise((r) => setTimeout(r, 0))

function deps(over: Record<string, unknown> = {}) {
  const calls: { admit: string[]; list: { url: string; key: string }[] } = { admit: [], list: [] }
  return {
    calls,
    listUserMcpConnections: async () => [
      { connectionName: 'acme.tools.a', status: 'connected' },
      { connectionName: 'acme.tools.b', status: 'forbidden' },
      { connectionName: 'acme.tools.c', status: 'unknown' },
    ],
    getHiddenMcpNames: async () => new Set(['acme.tools.c']),
    admitMcpConnection: async (_token: string, _email: string, name: string) => (calls.admit.push(name), { ok: name !== 'acme.tools.refused' }),
    listMcpServerCached: async (url: string, _token: string, key: string) => (calls.list.push({ url, key }), undefined),
    ...over,
  }
}

test.beforeEach(() => resetMcpWarm())

test('N7-1: warms admission + listing of each adopted connection, skipping forbidden and admin-hidden ones', async () => {
  const d = deps()
  await warmUserMcpConnections(TOKEN, USER, d)
  assert.deepEqual(d.calls.admit, ['acme.tools.a'])
  assert.equal(d.calls.list.length, 1)
  assert.equal(d.calls.list[0]!.key, USER, 'listing cached under the user, the key the turn reads')
  assert.match(d.calls.list[0]!.url, /acme\.tools\.a/)
})

test('N7-1: every adopted connection is warmed, past the first eight too', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `acme.tools.${i + 1}`)
  const d = deps({
    listUserMcpConnections: async () => names.map((connectionName) => ({ connectionName, status: 'connected' })),
    getHiddenMcpNames: async () => new Set(),
  })
  await warmUserMcpConnections(TOKEN, USER, d)
  assert.deepEqual([...d.calls.admit].sort(), [...names].sort())
  assert.equal(d.calls.list.length, names.length)
})

test('N7-1: warming runs with bounded concurrency, not all at once', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `acme.tools.${i + 1}`)
  let live = 0
  let peak = 0
  const d = deps({
    listUserMcpConnections: async () => names.map((connectionName) => ({ connectionName, status: 'connected' })),
    getHiddenMcpNames: async () => new Set(),
    admitMcpConnection: async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 1))
      live--
      return { ok: false }
    },
  })
  await warmUserMcpConnections(TOKEN, USER, d)
  assert.ok(peak <= 4 && peak >= 1, `peak concurrency ${peak}`)
})

test('N7-1: a refused connection is never contacted', async () => {
  const d = deps({ listUserMcpConnections: async () => [{ connectionName: 'acme.tools.refused', status: 'connected' }], getHiddenMcpNames: async () => new Set() })
  await warmUserMcpConnections(TOKEN, USER, d)
  assert.deepEqual(d.calls.admit, ['acme.tools.refused'])
  assert.deepEqual(d.calls.list, [])
})

test('N7-1: deduped per user for a short window; another user is warmed on its own', async () => {
  const d = deps()
  await warmUserMcpConnections(TOKEN, USER, d)
  await warmUserMcpConnections(TOKEN, USER, d)
  assert.equal(d.calls.admit.length, 1)
  await warmUserMcpConnections('tok-2', 'other@example.com', d)
  assert.equal(d.calls.admit.length, 2)
})

test('N7-1: never throws (a failing DB or gateway only skips the warm-up)', async () => {
  await warmUserMcpConnections(TOKEN, USER, deps({ listUserMcpConnections: async () => { throw new Error('db down') } }))
  await warmUserMcpConnections(TOKEN, 'x@example.com', deps({ listMcpServerCached: async () => { throw new Error('gateway') } }))
})

test('N7-1: GET /api/tool-policy starts the warm-up and answers without waiting for it', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const started: string[] = []
  const app = express()
  registerModelRoutes(app, {
    auth: (req: Request, _res: Response, next: NextFunction) => (Object.assign(req, { email: USER, token: TOKEN }), next()),
    ensureReady: async () => {},
    getToolPolicy: async () => ({}),
    warmWebSearch: async () => {},
    warmUserMcpConnections: (_token: string, email: string) => (started.push(email), gate),
  })
  const server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)) })
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tool-policy`)
    assert.equal(r.status, 200, 'answered while the warm-up is still pending')
    await tick()
    assert.deepEqual(started, [USER])
  } finally {
    release()
    server.close()
  }
})
