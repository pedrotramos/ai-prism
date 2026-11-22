// W4-5: the MCP Apps routes (/api/mcp-apps/..., /api/admin/mcp-apps/settings). Identity is mocked and the data layer is an
// in-memory fake that follows the contract of server/db/mcpApps.ts (a row is readable by its owner and by a member of the
// session's project, anyone else gets "not found"); the MCP service is the in-process fixture server. No Postgres and no
// workspace: the database rules are proven in server/mcpApps.rls.test.ts.
//
//   AC1  off by default (setting absent, or the env kill-switch): every route 404, and nothing reaches the service
//   AC3  a View tools/call to a model-only tool, an unlisted tool or another service -> 403 with a code
//   AC4  the view route sends exactly the section 2.4 header set; no Sec-Fetch-Dest: iframe -> 400
//   AC6  View calls use the admission helpers: shared / unverified refused, per_user without consent is a tool result
//   AC8  user B gets 404 on A's view and context; a project member can read them
//   Review focus: the HTML is never in the context answer; error answers carry codes; every write route has a body-limit class.
//
//   node --test server/routes/mcpApps.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'

import { authed } from './authed.ts'
import registerMcpAppsRoutes from './mcpApps.ts'
import type { UiToolCall } from '../db/mcpApps.ts'
import { buildViewCsp, MCP_APP_MIME } from '../mcpApps.ts'
import { callMcpTool, listMcpServer } from '../mcpClient.ts'
import { JSON_ROUTE_LIMITS } from '../middleware/security.ts'
import { setLogWriter } from '../log.ts'
import { startMcpAppServer, APP_URI } from '../../tests/helpers/mcpAppServer.mjs'

const A = 'ana@example.com'
const B = 'bruno@example.com'
const MEMBER = 'carla@example.com'
const HTML = '<!doctype html><html><body><main>view body</main></body></html>'
const CSP = { connectDomains: ['https://api.example.com'], resourceDomains: [], frameDomains: [], baseUriDomains: [] }

const record = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  uri: APP_URI,
  serviceName: 'main.apps.chart',
  toolName: 'show_chart',
  html: HTML,
  csp: CSP,
  prefersBorder: true,
  sha256: 'abc',
  fetchedAt: '2026-11-22T10:00:00.000Z',
  structuredContent: { points: [1, 2, 3] },
  ...over,
})

function makeDb() {
  const rows = new Map<string, { owner: string; members: string[]; row: UiToolCall }>()
  const calls: string[] = []
  const db = {
    calls,
    rows,
    enabled: true,
    seed(id: string, owner: string, ui: ReturnType<typeof record> | null = record(), members: string[] = []) {
      rows.set(id, { owner, members, row: { id, sessionId: '7', callId: 'call_1', toolName: 'mcp_chart__show_chart', args: { series: 'a' }, result: 'chart ready', status: 'ok', ui } as UiToolCall })
    },
    async readMcpAppsSetting(email: string) {
      calls.push(`read:${email}`)
      return db.enabled
    },
    async writeMcpAppsSetting(email: string, _t: string | null, enabled: boolean) {
      calls.push(`write:${email}:${enabled}`)
      db.enabled = enabled
    },
    async getUiToolCall(email: string, _t: string | null, id: string) {
      calls.push(`get:${email}:${id}`)
      const r = rows.get(id)
      if (!r || !r.row.ui) return null
      return r.owner === email || r.members.includes(email) ? r.row : null
    },
  }
  return db
}

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email'] as string
  if (!email) return res.status(401).json({ error: 'no identity' })
  authed(req).email = email
  authed(req).token = 'fake-obo-token-not-a-secret'
  next()
}
const fakeAdmin = (req: Request, res: Response, next: NextFunction) => (req.headers['x-test-admin'] === '1' ? next() : res.status(403).json({ error: 'admin only' }))

interface PortOpts {
  admission?: { ok: boolean; credentialClass?: string; code?: string }
  policy?: Record<string, boolean>
  hidden?: string[]
  callThrows?: Error
}

async function serve(over: { env?: Record<string, string | undefined>; db?: ReturnType<typeof makeDb>; fx?: Awaited<ReturnType<typeof startMcpAppServer>>; port?: PortOpts; rate?: number } = {}) {
  const db = over.db || makeDb()
  const port = over.port || {}
  const env = over.env || {}
  const calls: string[] = []
  const app = express()
  app.use(express.json())
  registerMcpAppsRoutes(app, {
    auth: fakeAuth,
    requireAdmin: fakeAdmin,
    env,
    db,
    hosts: () => ({ appHost: 'prism-1.aws.databricksapps.com', workspaceHost: 'adb-1.1.azuredatabricks.net' }),
    ratePerMin: over.rate,
    service: {
      url: (name: string) => (over.fx ? over.fx.url : `http://127.0.0.1:1/${name}`),
      admit: async () => port.admission || { ok: true, credentialClass: 'per_user' },
      toolPolicy: async () => port.policy || {},
      hiddenServices: async () => new Set(port.hidden || []),
      listTools: async (url: string, token: string, key: string) => {
        calls.push(`list:${key}`)
        return (await listMcpServer(url, token, { ui: true })).tools
      },
      callTool: async (url: string, token: string, name: string, args: Record<string, unknown>, opts: { timeoutMs: number }) => {
        calls.push(`call:${name}`)
        if (port.callThrows) throw port.callThrows
        return callMcpTool(url, token, name, args, { timeoutMs: opts.timeoutMs, throwOnError: true })
      },
    },
  } as Parameters<typeof registerMcpAppsRoutes>[1])
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, p: string, email: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(email ? { 'x-test-email': email } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, headers: res.headers, text, body: json }
  }
  return { db, calls, call, close: () => new Promise((r) => server.close(r)) }
}
const IFRAME = { 'sec-fetch-dest': 'iframe' }

// ---- AC1 -------------------------------------------------------------------------------------------------------

test('AC1 off by default: with the setting off every route answers 404 and the service is never reached', async () => {
  const db = makeDb()
  db.enabled = false
  db.seed('11', A)
  const s = await serve({ db })
  try {
    for (const [m, p, b] of [
      ['GET', '/api/mcp-apps/view/11'],
      ['GET', '/api/mcp-apps/11/context'],
      ['POST', '/api/mcp-apps/11/tools/call', { name: 'refresh_data', arguments: {} }],
    ] as Array<[string, string, unknown?]>) {
      const r = await s.call(m, p, A, b, IFRAME)
      assert.equal(r.status, 404, `${m} ${p}`)
      assert.equal(r.body.code, 'mcp_apps_disabled')
    }
    assert.deepEqual(s.calls, [])
    assert.equal(db.calls.some((c) => c.startsWith('get:')), false, 'no row is read while the feature is off')
    const status = await s.call('GET', '/api/mcp-apps/status', A)
    assert.deepEqual(status.body, { enabled: false })
  } finally {
    await s.close()
  }
})

test('AC1 the env kill-switch MCP_APPS_DISABLED=1 wins over an admin who turned it on', async () => {
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db, env: { MCP_APPS_DISABLED: '1' } })
  try {
    assert.equal((await s.call('GET', '/api/mcp-apps/view/11', A, undefined, IFRAME)).status, 404)
    assert.deepEqual((await s.call('GET', '/api/mcp-apps/status', A)).body, { enabled: false })
  } finally {
    await s.close()
  }
})

// ---- AC4 -------------------------------------------------------------------------------------------------------

test('AC4 the view route sends the section 2.4 header set, the CSP replaces the global one, and the body is the stored HTML untouched', async () => {
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db })
  try {
    const r = await s.call('GET', '/api/mcp-apps/view/11', A, undefined, IFRAME)
    assert.equal(r.status, 200)
    assert.equal(r.text, HTML)
    const h = r.headers
    assert.equal(h.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(h.get('content-security-policy'), buildViewCsp(CSP, { appHost: 'prism-1.aws.databricksapps.com', workspaceHost: 'adb-1.1.azuredatabricks.net' }))
    assert.match(h.get('content-security-policy')!, /^sandbox allow-scripts allow-forms;/)
    assert.equal(h.get('cache-control'), 'no-store')
    assert.equal(h.get('referrer-policy'), 'no-referrer')
    assert.equal(h.get('cross-origin-resource-policy'), 'same-origin')
    assert.equal(h.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(h.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    assert.equal(h.get('content-security-policy-report-only'), null, 'the report-only app policy is not sent for a View')
  } finally {
    await s.close()
  }
})

test('AC4 a request without Sec-Fetch-Dest: iframe is a 400, a navigation or a script fetch never gets the HTML', async () => {
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db })
  try {
    for (const headers of [{}, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'script' }] as Record<string, string>[]) {
      const r = await s.call('GET', '/api/mcp-apps/view/11', A, undefined, headers)
      assert.equal(r.status, 400, JSON.stringify(headers))
      assert.equal(r.body.code, 'bad_fetch_dest')
      assert.equal(r.text.includes('view body'), false)
    }
  } finally {
    await s.close()
  }
})

// ---- AC8 -------------------------------------------------------------------------------------------------------

test('AC8 user B gets 404 on A\'s view and context, identical to an id that does not exist; a project member can read both', async () => {
  const db = makeDb()
  db.seed('11', A, record(), [MEMBER])
  const s = await serve({ db })
  try {
    for (const p of ['/api/mcp-apps/view/11', '/api/mcp-apps/11/context']) {
      const theirs = await s.call('GET', p, B, undefined, IFRAME)
      const missing = await s.call('GET', p.replace('11', '98765'), B, undefined, IFRAME)
      assert.equal(theirs.status, 404, p)
      assert.equal(theirs.body.code, 'not_found')
      assert.deepEqual(theirs.body, missing.body)
      const mine = await s.call('GET', p, A, undefined, IFRAME)
      assert.equal(mine.status, 200, p)
      const member = await s.call('GET', p, MEMBER, undefined, IFRAME)
      assert.equal(member.status, 200, p)
    }
    const post = await s.call('POST', '/api/mcp-apps/11/tools/call', B, { name: 'refresh_data', arguments: {} })
    assert.equal(post.status, 404)
    assert.deepEqual(s.calls, [], 'B reached no service')
  } finally {
    await s.close()
  }
})

test('a row with no UI resource is a 404, and a non-numeric id never reaches the database', async () => {
  const db = makeDb()
  db.seed('12', A, null)
  const s = await serve({ db })
  try {
    assert.equal((await s.call('GET', '/api/mcp-apps/view/12', A, undefined, IFRAME)).status, 404)
    const r = await s.call('GET', '/api/mcp-apps/context/../x', A)
    assert.ok(r.status === 404)
    const bad = await s.call('GET', '/api/mcp-apps/view/abc', A, undefined, IFRAME)
    assert.equal(bad.status, 404)
    assert.equal(db.calls.some((c) => c.includes('abc')), false)
  } finally {
    await s.close()
  }
})

// ---- context ---------------------------------------------------------------------------------------------------

test('the context answers the tool input, result, service, tool name and csp, and never the HTML', async () => {
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db })
  try {
    const r = await s.call('GET', '/api/mcp-apps/11/context', A)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, {
      toolInput: { series: 'a' },
      toolResult: { content: [{ type: 'text', text: 'chart ready' }], structuredContent: { points: [1, 2, 3] } },
      serviceName: 'main.apps.chart',
      toolName: 'show_chart',
      csp: CSP,
    })
    assert.equal(r.text.includes('view body'), false)
    assert.equal(r.headers.get('cache-control'), 'no-store')
  } finally {
    await s.close()
  }
})

// ---- tools/call (AC3, AC6) -------------------------------------------------------------------------------------

test('AC3 a View may call an app-visible tool of the same service, with the user\'s token, and the call is not persisted', async () => {
  const fx = await startMcpAppServer()
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db, fx })
  try {
    const r = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: { range: '7d' } })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.body.content, [{ type: 'text', text: 'refreshed' }])
    assert.deepEqual(fx.calls, [{ name: 'refresh_data', args: { range: '7d' } }])
    assert.equal(db.calls.some((c) => c.startsWith('write')), false)
    // a tool visible to both model and app is allowed too
    const both = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'show_chart', arguments: {} })
    assert.equal(both.status, 200)
  } finally {
    await s.close()
    await fx.close()
  }
})

test('AC3 a model-only tool, an unlisted tool and another service are 403 with a code, and nothing is called', async () => {
  const fx = await startMcpAppServer()
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db, fx })
  try {
    const modelOnly = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'model_only', arguments: {} })
    assert.equal(modelOnly.status, 403)
    assert.equal(modelOnly.body.code, 'tool_not_app_visible')
    const plain = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'plain', arguments: {} })
    assert.equal(plain.status, 403, 'a tool with no UI meta is not callable from a View')
    assert.equal(plain.body.code, 'tool_not_app_visible')
    const unlisted = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'delete_everything', arguments: {} })
    assert.equal(unlisted.status, 403)
    assert.equal(unlisted.body.code, 'tool_not_found')
    const other = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {}, serviceName: 'main.other.service' })
    assert.equal(other.status, 403)
    assert.equal(other.body.code, 'wrong_service')
    assert.deepEqual(fx.calls, [])
  } finally {
    await s.close()
    await fx.close()
  }
})

test('the call body is validated: a name, an object of arguments, at most 64 KiB', async () => {
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db })
  try {
    for (const body of [{}, { name: 5 }, { name: '' }, { name: 'x'.repeat(300) }, { name: 'a', arguments: 'str' }, { name: 'a', arguments: [] }, { name: 'a', arguments: { big: 'x'.repeat(70_000) } }]) {
      const r = await s.call('POST', '/api/mcp-apps/11/tools/call', A, body)
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60))
      assert.equal(r.body.code, 'bad_request')
    }
    assert.deepEqual(s.calls, [])
  } finally {
    await s.close()
  }
})

test('AC6 the credential-class rules apply to a View call: shared and unverified are refused with the admission code', async () => {
  const fx = await startMcpAppServer()
  const db = makeDb()
  db.seed('11', A)
  try {
    for (const admission of [
      { ok: false, credentialClass: 'shared', code: 'shared_credential' },
      { ok: false, credentialClass: 'unverified', code: 'credential_unverified' },
      { ok: false, code: 'credential_unchecked' },
    ]) {
      const s = await serve({ db, fx, port: { admission } })
      try {
        const r = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
        assert.equal(r.status, 403)
        assert.equal(r.body.code, admission.code)
        assert.deepEqual(s.calls.filter((c) => c.startsWith('call:')), [])
      } finally {
        await s.close()
      }
    }
    assert.deepEqual(fx.calls, [])
  } finally {
    await fx.close()
  }
})

test('AC6 per_user without consent: the gateway\'s login error comes back as a tool error result, not a crash', async () => {
  const fx = await startMcpAppServer()
  const db = makeDb()
  db.seed('11', A)
  const s = await serve({ db, fx, port: { admission: { ok: true, credentialClass: 'per_user' }, callThrows: Object.assign(new Error('UNAUTHENTICATED: visit https://login.example.com/consent'), { code: 401 }) } })
  try {
    const r = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
    assert.equal(r.status, 200)
    assert.equal(r.body.isError, true)
    assert.match(r.body.content[0].text, /login\.example\.com\/consent/)
  } finally {
    await s.close()
    await fx.close()
  }
})

test('the org tool policy and a hidden service apply to a View call as to a model call', async () => {
  const fx = await startMcpAppServer()
  const db = makeDb()
  db.seed('11', A)
  try {
    const off = await serve({ db, fx, port: { policy: { 'mcp-external': false } } })
    const hidden = await serve({ db, fx, port: { hidden: ['main.apps.chart'] } })
    try {
      const a = await off.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
      assert.equal(a.status, 403)
      assert.equal(a.body.code, 'tool_group_disabled')
      const b = await hidden.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
      assert.equal(b.status, 403)
      assert.equal(b.body.code, 'service_hidden')
    } finally {
      await off.close()
      await hidden.close()
    }
    assert.deepEqual(fx.calls, [])
  } finally {
    await fx.close()
  }
})

test('a View call is rate limited per user: past the limit 429, another user is unaffected', async () => {
  const fx = await startMcpAppServer()
  const db = makeDb()
  db.seed('11', A, record(), [B])
  const s = await serve({ db, fx, rate: 3 })
  try {
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })).status)
    assert.deepEqual(codes, [200, 200, 200, 429, 429])
    assert.equal((await s.call('POST', '/api/mcp-apps/11/tools/call', B, { name: 'refresh_data', arguments: {} })).status, 200)
  } finally {
    await s.close()
    await fx.close()
  }
})

test('a timeout from the service is a 504 timeout; any other failure is a 502 whose text is only logged', async () => {
  const { McpToolError } = await import('../mcpClient.ts')
  const db = makeDb()
  db.seed('11', A)
  const fx = await startMcpAppServer()
  const slow = await serve({ db, fx, port: { callThrows: new McpToolError('timeout', 'MCP tool call exceeded 20000ms') } })
  const boom = await serve({ db, fx, port: { callThrows: new Error('secret internal detail') } })
  try {
    const a = await slow.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
    assert.equal(a.status, 504)
    assert.equal(a.body.code, 'timeout')
    const b = await boom.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
    assert.equal(b.status, 502)
    assert.equal(b.body.code, 'upstream_error')
    assert.equal(b.text.includes('secret internal detail'), false)
  } finally {
    await slow.close()
    await boom.close()
    await fx.close()
  }
})

test('a View call logs an upstream error code without the upstream message', async () => {
  const db = makeDb()
  db.seed('11', A)
  const fx = await startMcpAppServer()
  const marker = 'UPSTREAM_DETAIL_SENTINEL_91c2'
  const s = await serve({ db, fx, port: { callThrows: Object.assign(new Error(marker), { code: 'upstream_failure' }) } })
  const logs: string[] = []
  const previousWriter = setLogWriter((line) => logs.push(line))
  try {
    const r = await s.call('POST', '/api/mcp-apps/11/tools/call', A, { name: 'refresh_data', arguments: {} })
    assert.equal(r.status, 502)
    assert.equal(r.body.code, 'upstream_error')
    assert.equal(logs.join('\n').includes(marker), false, 'only the stable error code should be logged')
    assert.ok(logs.some((l) => l.includes('upstream_failure')), 'the code itself is logged')
  } finally {
    setLogWriter(previousWriter)
    await s.close()
    await fx.close()
  }
})

test('no log line of a failing route (list, call, data layer) carries the error message', async () => {
  const marker = 'SECRET_TEXT_5d7e'
  const db = makeDb()
  db.seed('11', A)
  db.getUiToolCall = async () => {
    throw new Error(marker)
  }
  const s = await serve({ db })
  const logs: string[] = []
  const previousWriter = setLogWriter((line) => logs.push(line))
  try {
    assert.equal((await s.call('GET', '/api/mcp-apps/11/context', A)).status, 500)
    assert.equal(logs.join('\n').includes(marker), false)
    assert.ok(logs.length > 0, 'the failure is still logged, as a code')
  } finally {
    setLogWriter(previousWriter)
    await s.close()
  }
})

test('a stored record whose policy is over the cap is refused with csp_too_long, on the view and the context', async () => {
  const LONGS = Array.from({ length: 32 }, (_, i) => `https://${'a'.repeat(60)}.${'b'.repeat(60)}.h${i}.example.com`)
  const db = makeDb()
  db.seed('11', A, record({ csp: { connectDomains: LONGS, resourceDomains: LONGS, frameDomains: LONGS, baseUriDomains: LONGS } }))
  const s = await serve({ db })
  try {
    const view = await s.call('GET', '/api/mcp-apps/view/11', A, undefined, IFRAME)
    assert.equal(view.status, 422)
    assert.equal(view.body.code, 'csp_too_long')
    assert.equal(view.text.includes('view body'), false)
    assert.equal(view.headers.get('content-security-policy'), null)
    const ctx = await s.call('GET', '/api/mcp-apps/11/context', A)
    assert.equal(ctx.status, 422)
    assert.equal(ctx.body.code, 'csp_too_long')
  } finally {
    await s.close()
  }
})

// ---- admin settings --------------------------------------------------------------------------------------------

test('admin settings: admin only, off by default, a PUT writes through the db layer (which audits), a non-boolean is 400', async () => {
  const db = makeDb()
  db.enabled = false
  const s = await serve({ db })
  try {
    assert.equal((await s.call('GET', '/api/admin/mcp-apps/settings', A)).status, 403)
    assert.equal((await s.call('PUT', '/api/admin/mcp-apps/settings', A, { enabled: true })).status, 403)
    const get = await s.call('GET', '/api/admin/mcp-apps/settings', A, undefined, { 'x-test-admin': '1' })
    assert.deepEqual(get.body, { enabled: false, envDisabled: false })
    const bad = await s.call('PUT', '/api/admin/mcp-apps/settings', A, { enabled: 'yes' }, { 'x-test-admin': '1' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'invalid_setting')
    const put = await s.call('PUT', '/api/admin/mcp-apps/settings', A, { enabled: true }, { 'x-test-admin': '1' })
    assert.equal(put.status, 200)
    assert.deepEqual(put.body, { enabled: true, envDisabled: false })
    assert.ok(db.calls.includes(`write:${A}:true`))
    assert.deepEqual((await s.call('GET', '/api/mcp-apps/status', B)).body, { enabled: true })
  } finally {
    await s.close()
  }
})

test('admin settings report the kill-switch', async () => {
  const s = await serve({ env: { MCP_APPS_DISABLED: '1' } })
  try {
    const get = await s.call('GET', '/api/admin/mcp-apps/settings', A, undefined, { 'x-test-admin': '1' })
    assert.deepEqual(get.body, { enabled: true, envDisabled: true })
  } finally {
    await s.close()
  }
})

// ---- body limits -----------------------------------------------------------------------------------------------

test('every write route of the feature has a body-limit class', () => {
  const have = new Set(JSON_ROUTE_LIMITS.map((r: { method: string; path: string }) => `${r.method} ${r.path}`))
  for (const k of ['POST /api/mcp-apps/:toolCallId/tools/call', 'PUT /api/admin/mcp-apps/settings']) assert.ok(have.has(k), `${k} has a class`)
})

test('the MIME constant the route and the capability share', () => {
  assert.equal(MCP_APP_MIME, 'text/html;profile=mcp-app')
})
