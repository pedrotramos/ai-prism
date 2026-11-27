// /api/me carries the effective external asset origins (md-exfil T2), so the client renderer and the CSP agree; the
// identity-degrade path still answers (and carries the list: origins are not secret).
//
//   node --test server/routes/admins.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'

import { authed } from './authed.ts'
import registerAdminRoutes from './admins.ts'

const fakeAuth = (req: Request, _res: Response, next: NextFunction) => {
  authed(req).email = 'ana@example.com'
  authed(req).token = 't'
  next()
}

async function me(deps: Record<string, unknown>) {
  const app = express()
  registerAdminRoutes(app, { auth: fakeAuth, ...deps } as any)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me`)
    return { status: r.status, body: await r.json() }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('/api/me includes externalAssetOrigins (the effective list)', async () => {
  const r = await me({ ensureReady: async () => {}, isAdmin: async () => true, origins: () => ['https://fonts.example.com'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.externalAssetOrigins, ['https://fonts.example.com'])
  assert.equal(r.body.isAdmin, true)
})

test('/api/me still answers when the identity check fails, with the origins', async () => {
  const r = await me({
    ensureReady: async () => {
      throw new Error('db down')
    },
    origins: () => ['https://fonts.example.com'],
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.email, 'ana@example.com')
  assert.deepEqual(r.body.externalAssetOrigins, ['https://fonts.example.com'])
})

test('/api/me answers even when the origins source throws (empty list, fail closed)', async () => {
  const r = await me({
    ensureReady: async () => {},
    isAdmin: async () => false,
    origins: () => {
      throw new Error('boom')
    },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.externalAssetOrigins, [])
})
