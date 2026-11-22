import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:net'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import { authed } from './authed.ts'
import registerAdminAgentRoutes from './adminAgents.ts'

test('an admin middleware database failure returns only a stable error code', async () => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => probe.once('listening', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()))

  const previous = {
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGSSLMODE: process.env.PGSSLMODE,
    PGUSER: process.env.PGUSER,
    PGPASSWORD: process.env.PGPASSWORD,
    PGDATABASE: process.env.PGDATABASE,
  }
  process.env.PGHOST = '127.0.0.1'
  process.env.PGPORT = String(port)
  process.env.PGSSLMODE = 'disable'
  process.env.PGUSER = 'ai_prism_app'
  process.env.PGPASSWORD = 'test-only-placeholder'
  process.env.PGDATABASE = 'ai_prism'

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    authed(req).email = 'admin@example.com'
    authed(req).token = 'test-only-placeholder'
    next()
  }
  const app = express()
  app.use(express.json())
  // Keep the production requireAdmin and data layer; only the upstream identity is test supplied.
  registerAdminAgentRoutes(app, { auth, env: { AGENTS_ENABLED: '1' } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/agents/1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedHash: 'a'.repeat(64) }),
    })
    const body = await response.json()
    assert.equal(response.status, 500)
    assert.deepEqual(body, { error: 'internal_error', code: 'internal_error' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
