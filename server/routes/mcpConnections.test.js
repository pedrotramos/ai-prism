// The user's MCP connect paths (W2-11c): connecting (catalog entry or typed
// by-name service) and re-checking a saved connection both run the credential
// admission, so a service that calls its backend with ONE shared credential is
// refused with a readable reason and never adopted. Identity, DB and the
// gateway probe are injected; no database, no workspace.
//
//   node --test server/routes/mcpConnections.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import registerMcpConnectionRoutes from './mcpConnections.js'
import { admitMcpConnection, resetMcpAdmissionCache } from '../externalMcp.js'

const USER = 'user@example.com'
const FAKE_TOKEN = 'fake-obo-token-not-a-secret'

function fakeAuth(req, res, next) {
  req.email = USER
  req.token = FAKE_TOKEN
  next()
}

// classes by service name; anything not listed makes the classifier throw
const CLASSES = {
  'acme.tools.shared_svc': 'shared',
  'acme.tools.per_user_svc': 'per_user',
}

async function serve() {
  resetMcpAdmissionCache()
  const calls = { adopt: [], status: [], probe: [] }
  const classify = async (name) => {
    if (!CLASSES[name]) throw new Error('metadata unreadable')
    return { credentialClass: CLASSES[name], credentialType: null }
  }
  const app = express()
  app.use(express.json())
  registerMcpConnectionRoutes(app, {
    auth: fakeAuth,
    ensureReady: async () => {},
    getHiddenMcpNames: async () => new Set(),
    admitMcpConnection: (token, email, name) => admitMcpConnection(token, email, name, { catalog: [], classify }),
    probeMcpConnection: async (token, name) => {
      calls.probe.push(name)
      return { status: 'connected' }
    },
    adoptUserMcpConnection: async (email, token, name, comment, status) => calls.adopt.push({ name, status }),
    setUserMcpStatus: async (email, token, name, status) => calls.status.push({ name, status }),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return { status: r.status, body: await r.json() }
  }
  return { post, calls, close: () => new Promise((r) => server.close(r)) }
}

test('POST /api/mcp/connections/:name refuses a shared-credential service and never adopts it', async () => {
  const s = await serve()
  try {
    const r = await s.post('/api/mcp/connections/acme.tools.shared_svc')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'mcp_shared_credential')
    assert.match(r.body.error, /compartilhada/)
    assert.doesNotMatch(JSON.stringify(r.body), /fake-obo-token/)
    assert.equal(s.calls.adopt.length, 0)
    assert.equal(s.calls.probe.length, 0)
  } finally {
    await s.close()
  }
})

test('POST /api/mcp/connections/:name still connects a per-user service', async () => {
  const s = await serve()
  try {
    const r = await s.post('/api/mcp/connections/acme.tools.per_user_svc')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(s.calls.adopt, [{ name: 'acme.tools.per_user_svc', status: 'connected' }])
  } finally {
    await s.close()
  }
})

test('POST /api/mcp/connections/:name fails closed when classification errors', async () => {
  const s = await serve()
  try {
    const r = await s.post('/api/mcp/connections/acme.tools.unknown_svc')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'mcp_credential_check_failed')
    assert.equal(s.calls.adopt.length, 0)
  } finally {
    await s.close()
  }
})

test('POST /api/mcp/connections/:name/probe refuses a saved shared-credential connection and marks it', async () => {
  const s = await serve()
  try {
    const r = await s.post('/api/mcp/connections/acme.tools.shared_svc/probe')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'mcp_shared_credential')
    assert.equal(s.calls.probe.length, 0)
    assert.deepEqual(s.calls.status, [{ name: 'acme.tools.shared_svc', status: 'forbidden' }])
  } finally {
    await s.close()
  }
})

test('POST /api/mcp/connections/:name/probe still probes a per-user service', async () => {
  const s = await serve()
  try {
    const r = await s.post('/api/mcp/connections/acme.tools.per_user_svc/probe')
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'connected')
    assert.deepEqual(s.calls.probe, ['acme.tools.per_user_svc'])
  } finally {
    await s.close()
  }
})
