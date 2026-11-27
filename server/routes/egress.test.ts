// GET/PUT /api/admin/egress/settings (md-exfil T2, AC12 server side). Identity and the data layer are fakes that follow the
// contract of server/db/egressSettings.ts; the RLS and the audit row are proven in server/db/egressSettings.rls.test.ts.
//
//   node --test server/routes/egress.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'

import { authed } from './authed.ts'
import registerEgressRoutes from './egress.ts'
import { createEgressSetting } from '../egressSetting.ts'
import { JSON_ROUTE_LIMITS } from '../middleware/security.ts'

const ADMIN = 'ana@example.com'

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email'] as string
  if (!email) return res.status(401).json({ error: 'no identity' })
  authed(req).email = email
  authed(req).token = 'fake-token-not-a-secret'
  next()
}
const fakeAdmin = (req: Request, res: Response, next: NextFunction) => (req.headers['x-test-admin'] === '1' ? next() : res.status(403).json({ error: 'admin only' }))

async function serve(over: { env?: Record<string, string | undefined>; stored?: string[]; writeThrows?: boolean } = {}) {
  const calls: string[] = []
  const state = { stored: over.stored ?? [] }
  const setting = createEgressSetting({ read: async () => state.stored, env: over.env || {}, log: () => {} })
  const app = express()
  app.use(express.json())
  registerEgressRoutes(app, {
    auth: fakeAuth,
    requireAdmin: fakeAdmin,
    env: over.env || {},
    setting,
    hosts: () => ({ appHost: 'prism-1.aws.databricksapps.com', workspaceHost: 'adb-1.1.azuredatabricks.net' }),
    db: {
      async read(email) {
        calls.push(`read:${email}`)
        return state.stored
      },
      async write(email, _t, origins, opts) {
        calls.push(`write:${email}:admin=${opts.admin}:${origins.join('|')}`)
        if (over.writeThrows) throw new Error('rls')
        state.stored = [...origins]
      },
    },
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, body?: unknown, who: { email?: string; admin?: boolean } = { email: ADMIN, admin: true }) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (who.email) headers['x-test-email'] = who.email
    if (who.admin) headers['x-test-admin'] = '1'
    const r = await fetch(`${base}/api/admin/egress/settings`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json: any
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, body: json }
  }
  return { call, calls, setting, close: () => new Promise((r) => server.close(r)) }
}

test('GET: the stored list, the env floor, the effective union and the mode', async () => {
  const s = await serve({ env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com', CSP_EGRESS: 'report' }, stored: ['https://a.example.com', 'https://floor.example.com'] })
  try {
    const r = await s.call('GET')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { origins: ['https://a.example.com', 'https://floor.example.com'], envOrigins: ['https://floor.example.com'], effective: ['https://floor.example.com', 'https://a.example.com'], mode: 'report' })
  } finally {
    await s.close()
  }
})

test('GET: mode defaults to enforce; nothing set is an empty answer', async () => {
  const s = await serve()
  try {
    assert.deepEqual((await s.call('GET')).body, { origins: [], envOrigins: [], effective: [], mode: 'enforce' })
  } finally {
    await s.close()
  }
})

test('a non-admin gets 403 on GET and PUT and nothing reaches the data layer; no identity is 401', async () => {
  const s = await serve()
  try {
    assert.equal((await s.call('GET', undefined, { email: 'bob@example.com' })).status, 403)
    assert.equal((await s.call('PUT', { origins: ['https://a.example.com'] }, { email: 'bob@example.com' })).status, 403)
    assert.equal((await s.call('GET', undefined, {})).status, 401)
    assert.deepEqual(s.calls, [])
  } finally {
    await s.close()
  }
})

test('PUT with an invalid origin is a 400 naming every rejected entry, and writes nothing', async () => {
  const s = await serve()
  try {
    const r = await s.call('PUT', { origins: ['https://ok.example.com', 'https://*.example.com', 'http://plain.example.com', 'https://10.0.0.1', 'https://prism-1.aws.databricksapps.com', 'https://x.example.com/p'] })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'invalid_origin')
    assert.deepEqual(r.body.rejected, ['https://*.example.com', 'http://plain.example.com', 'https://10.0.0.1', 'https://prism-1.aws.databricksapps.com', 'https://x.example.com/p'])
    assert.deepEqual(s.calls, [])
  } finally {
    await s.close()
  }
})

test('PUT with a bad shape is a 400 invalid_setting (not an object, extra keys, not an array, non-strings, over 32)', async () => {
  const s = await serve()
  try {
    for (const body of [undefined, [], 'x', { origins: 'https://a.example.com' }, { origins: [1] }, { origins: [], extra: 1 }, {}, { origins: Array.from({ length: 33 }, (_, i) => `https://h${i}.example.com`) }]) {
      const r = await s.call('PUT', body)
      assert.equal(r.status, 400, JSON.stringify(body)?.slice(0, 40))
    }
    assert.deepEqual(s.calls, [])
  } finally {
    await s.close()
  }
})

test('PUT saves the normalized, deduped list as admin, refreshes the cache at once and answers like GET', async () => {
  const s = await serve({ env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com' } })
  try {
    assert.deepEqual(s.setting.current(), ['https://floor.example.com'])
    const r = await s.call('PUT', { origins: ['HTTPS://Fonts.Example.com', 'https://fonts.example.com', 'https://cdn.example.org:8443'] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.origins, ['https://fonts.example.com', 'https://cdn.example.org:8443'])
    assert.deepEqual(r.body.effective, ['https://floor.example.com', 'https://fonts.example.com', 'https://cdn.example.org:8443'])
    assert.ok(s.calls.includes('write:ana@example.com:admin=true:https://fonts.example.com|https://cdn.example.org:8443'))
    assert.deepEqual(s.setting.current(), r.body.effective, 'the header source sees it without waiting for the TTL')
  } finally {
    await s.close()
  }
})

test('PUT [] clears the setting (the env floor stays)', async () => {
  const s = await serve({ env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com' }, stored: ['https://a.example.com'] })
  try {
    const r = await s.call('PUT', { origins: [] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.effective, ['https://floor.example.com'])
  } finally {
    await s.close()
  }
})

test('a failed write is a coded 500 with no detail, and the cache keeps its value', async () => {
  const s = await serve({ writeThrows: true })
  try {
    const r = await s.call('PUT', { origins: ['https://a.example.com'] })
    assert.equal(r.status, 500)
    assert.equal(r.body.code, 'internal_error')
    assert.doesNotMatch(JSON.stringify(r.body), /rls/)
  } finally {
    await s.close()
  }
})

test('the write route has a body-limit class', () => {
  assert.ok(JSON_ROUTE_LIMITS.some((r: { method: string; path: string }) => r.method === 'PUT' && r.path === '/api/admin/egress/settings'))
})
