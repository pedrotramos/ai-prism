// SSRF follow-up hardening (see .megabrain/parity-ux/review/ssrf-web-fetch-check.md,
// "Remaining gaps"):
//   1. web.js: the pinned DNS lookup must answer asynchronously, so a connect()
//      that fails synchronously (EHOSTUNREACH/ENETUNREACH) rejects the request
//      instead of emitting an unhandled 'error' that exits the process.
//   2. a2aGuard.js blockedAddressReason: 6to4, SIIT, Teredo and NAT64 local-use.
//   3. externalMcp.js / routes/mcpConnections.js: the connection name is a single
//      path segment under /ai-gateway/mcp-services/, never a path or query.
// No test opens a real socket: the socket layer is stubbed or http.request is spied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import express from 'express'
import * as web from './web.js'
import { blockedAddressReason } from './a2aGuard.js'
import * as externalMcp from './externalMcp.js'
import registerMcpConnectionRoutes from './routes/mcpConnections.js'

// ---- 1. pinned lookup / synchronous connect failure ------------------------------

test('pinnedLookup answers on a later tick, never inside the call', async () => {
  const lookup = web.pinnedLookup({ address: '93.184.215.14', family: 4 })
  const calls = []
  lookup('example.test', { all: false }, (...args) => calls.push(args))
  assert.equal(calls.length, 0, 'callback ran synchronously')
  await new Promise((r) => process.nextTick(r))
  assert.deepEqual(calls, [[null, '93.184.215.14', 4]])
})

test('pinnedLookup returns the pinned address as a list when asked for all', async () => {
  const lookup = web.pinnedLookup({ address: '2606:4700:4700::1111', family: 6 })
  const got = await new Promise((resolve) => lookup('example.test', { all: true }, (...args) => resolve(args)))
  assert.deepEqual(got, [null, [{ address: '2606:4700:4700::1111', family: 6 }]])
})

test('pinnedLookup accepts the (hostname, callback) form', async () => {
  const lookup = web.pinnedLookup({ address: '93.184.215.14', family: 4 })
  const got = await new Promise((resolve) => lookup('example.test', (...args) => resolve(args)))
  assert.deepEqual(got, [null, '93.184.215.14', 4])
})

// Runs in a child process because the bug is the process dying: an unhandled
// 'error' event would kill the test runner itself. The child stubs
// net.Socket#connect to behave like Node's internalConnect when the kernel
// refuses the connect() call synchronously: it calls the socket's lookup and,
// in the lookup callback, destroys the socket with EHOSTUNREACH. No real
// connection is ever attempted.
const SYNC_CONNECT_FAILURE_CHILD = `
import net from 'node:net'
const { safeGet } = await import(process.env.WEB_JS_URL)
let stubbedConnects = 0
net.Socket.prototype.connect = function (...args) {
  stubbedConnects++
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  this.connecting = true
  options.lookup(options.host, { family: options.family || 0, all: false }, (err) => {
    if (err) return this.destroy(err)
    this.destroy(Object.assign(new Error('connect EHOSTUNREACH (stubbed)'), { code: 'EHOSTUNREACH', syscall: 'connect' }))
  })
  return this
}
for (const url of ['http://8.8.8.8/', 'http://[2606:4700:4700::1111]/', 'https://1.1.1.1/']) {
  try {
    await safeGet(url, { timeoutMs: 2000 })
    console.log(JSON.stringify({ url, outcome: 'resolved' }))
  } catch (e) {
    console.log(JSON.stringify({ url, outcome: 'rejected', code: e.code || null }))
  }
}
console.log(JSON.stringify({ stubbedConnects }))
`

test('a synchronous connect failure rejects safeGet instead of crashing the process', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', SYNC_CONNECT_FAILURE_CHILD], {
    env: { ...process.env, WEB_JS_URL: new URL('./web.js', import.meta.url).href },
    encoding: 'utf8',
    timeout: 4000,
  })
  assert.equal(child.status, 0, `child exited ${child.status} (signal ${child.signal}):\n${child.stderr}`)
  const lines = child.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [
    { url: 'http://8.8.8.8/', outcome: 'rejected', code: 'EHOSTUNREACH' },
    { url: 'http://[2606:4700:4700::1111]/', outcome: 'rejected', code: 'EHOSTUNREACH' },
    { url: 'https://1.1.1.1/', outcome: 'rejected', code: 'EHOSTUNREACH' },
    { stubbedConnects: 3 },
  ])
})

// ---- 2. tunnelling / translation prefixes ----------------------------------------

const ADDRESS_TABLE = [
  // 6to4 2002::/16 — embedded IPv4 in words 1..2, classified like ::ffff:
  ['2002:7f00:1::', 'loopback via 6to4'],
  ['2002:a9fe:a9fe::1', 'reserved 169.254.0.0/16 via 6to4'],
  ['2002:0a00:0001:ffff::1', 'reserved 10.0.0.0/8 via 6to4'],
  ['2002:c0a8:0101::', 'reserved 192.168.0.0/16 via 6to4'],
  ['2002:0000:0000::1', 'reserved 0.0.0.0/8 via 6to4'],
  ['2002:0808:0808::1', null], // 6to4 of a public IPv4 (8.8.8.8)
  // SIIT ::ffff:0:0/96 — embedded IPv4 in the last 32 bits
  ['::ffff:0:7f00:1', 'loopback via ::ffff:0:0/96'],
  ['::ffff:0:127.0.0.1', 'loopback via ::ffff:0:0/96'],
  ['::ffff:0:a9fe:a9fe', 'reserved 169.254.0.0/16 via ::ffff:0:0/96'],
  ['0:0:0:0:ffff:0:ac10:1', 'reserved 172.16.0.0/12 via ::ffff:0:0/96'],
  ['::ffff:0:808:808', null], // SIIT of a public IPv4
  // Teredo 2001::/32 — the client address is obfuscated; the whole prefix is refused
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved Teredo 2001::/32'],
  ['2001::1', 'reserved Teredo 2001::/32'],
  ['2001:0:7f00:1::', 'reserved Teredo 2001::/32'],
  // NAT64 local-use 64:ff9b:1::/48 (RFC 8215) — the IPv4 position depends on the prefix length
  ['64:ff9b:1::7f00:1', 'reserved NAT64 local-use 64:ff9b:1::/48'],
  ['64:ff9b:1:ffff:ffff::1', 'reserved NAT64 local-use 64:ff9b:1::/48'],
  // neighbours that must keep their current classification
  ['64:ff9b::7f00:1', 'reserved NAT64 64:ff9b::/96'],
  ['::ffff:7f00:1', 'loopback via ::ffff'],
  ['2001:db8::1', 'documentation'],
  ['2001:4860:4860::8888', null], // Google DNS: 2001:4860::/32, not Teredo
  ['2003::1', null],
  ['64:ff9b:2::1', null], // outside the local-use /48
]

for (const [ip, expected] of ADDRESS_TABLE) {
  test(`blockedAddressReason(${ip}) → ${expected === null ? 'public' : expected}`, () => {
    assert.equal(blockedAddressReason(ip), expected)
  })
}

test('6to4 and SIIT honour allowLoopback / allowPrivate like the ::ffff form', () => {
  assert.equal(blockedAddressReason('2002:7f00:1::', { allowLoopback: true }), null)
  assert.equal(blockedAddressReason('::ffff:0:a00:1', { allowPrivate: true }), null)
  // the options never open Teredo or NAT64 local-use
  assert.equal(blockedAddressReason('2001::1', { allowLoopback: true, allowPrivate: true }), 'reserved Teredo 2001::/32')
  assert.equal(
    blockedAddressReason('64:ff9b:1::a00:1', { allowLoopback: true, allowPrivate: true }),
    'reserved NAT64 local-use 64:ff9b:1::/48'
  )
})

test('safeGet refuses the tunnelled forms before opening any socket', async (t) => {
  const spy = t.mock.method(http, 'request', () => {
    throw new Error('http.request must not be called')
  })
  for (const url of [
    'http://[2002:7f00:1::]/',
    'http://[2002:a9fe:a9fe::1]/latest/meta-data/',
    'http://[::ffff:0:7f00:1]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
    'http://[64:ff9b:1::7f00:1]/',
  ]) {
    await assert.rejects(() => web.safeGet(url), /privado/, url)
  }
  assert.equal(spy.mock.callCount(), 0)
})

// ---- 3. MCP connection names -----------------------------------------------------

const HOST = 'https://ws.test.invalid'
const PREFIX = '/ai-gateway/mcp-services/'

function withHost(fn) {
  const prev = process.env.DATABRICKS_HOST
  process.env.DATABRICKS_HOST = HOST
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.DATABRICKS_HOST
    else process.env.DATABRICKS_HOST = prev
  }
}

test('externalMcpUrl leaves valid three-part names unchanged (dots stay literal)', () => {
  withHost(() => {
    assert.equal(externalMcp.externalMcpUrl('system.ai.slack'), `${HOST}${PREFIX}system.ai.slack`)
    assert.equal(externalMcp.externalMcpUrl('main.agents.mcp-google-stitch'), `${HOST}${PREFIX}main.agents.mcp-google-stitch`)
    assert.equal(externalMcp.externalMcpUrl('my_cat.my_schema.firecrawl_mcp'), `${HOST}${PREFIX}my_cat.my_schema.firecrawl_mcp`)
  })
})

test('externalMcpUrl percent-encodes path and query characters in the name', () => {
  withHost(() => {
    assert.equal(externalMcp.externalMcpUrl('a/../b?x=1#f'), `${HOST}${PREFIX}a%2F..%2Fb%3Fx%3D1%23f`)
    const u = new URL(externalMcp.externalMcpUrl('../../api/2.0/secrets/list?scope=x'))
    assert.equal(u.origin, HOST)
    assert.equal(u.search, '')
    assert.equal(u.pathname, `${PREFIX}..%2F..%2Fapi%2F2.0%2Fsecrets%2Flist%3Fscope%3Dx`)
  })
})

test('externalMcpUrl never lets a dot-segment name climb out of mcp-services/', () => {
  withHost(() => {
    for (const name of ['.', '..']) {
      const u = new URL(externalMcp.externalMcpUrl(name))
      assert.ok(u.pathname.startsWith(PREFIX) && u.pathname.length > PREFIX.length, `${name} → ${u.pathname}`)
    }
  })
})

test('isValidMcpConnectionName accepts catalog, published and legacy names', () => {
  const curated = externalMcp.buildMcpCatalog([]).map((e) => e.connectionName)
  assert.ok(curated.length >= 10)
  for (const name of [...curated, 'main.agents.mcp-google-stitch', 'my_cat.my_schema.firecrawl_mcp', 'ah-github']) {
    assert.equal(externalMcp.isValidMcpConnectionName(name), true, name)
  }
})

test('isValidMcpConnectionName rejects path, query and encoded characters', () => {
  for (const name of [
    '', '.', '..', 'a/b', 'a\\b', 'a?x', 'a#x', 'a%2Fb', 'a b', 'a\nb', 'a\u0000b', '../x', 'x'.repeat(256), undefined, null, 42,
  ]) {
    assert.equal(externalMcp.isValidMcpConnectionName(name), false, JSON.stringify(name))
  }
})

// A bare Express app with just the MCP routes. The name check runs before
// auth, so a bad name is a 400 even without identity, and a good name gets
// past it to auth (401 here: the Apps runtime marker disables dev identity).
async function withMcpApp(fn) {
  const saved = { ...process.env }
  process.env.DATABRICKS_APP_NAME = 'webhardening-test'
  delete process.env.LOCAL_DEV_MODE
  delete process.env.LOCAL_DEV_IDENTITY
  const app = express()
  app.use(express.json())
  registerMcpConnectionRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  // raw paths: fetch() would normalise %2E%2E before sending
  const send = (method, path) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    await fn(send)
  } finally {
    await new Promise((r) => server.close(r))
    process.env = saved
  }
}

test('MCP connection routes answer 400 for names with path or query characters', async () => {
  await withMcpApp(async (send) => {
    for (const [method, path] of [
      ['POST', '/api/mcp/connections/a%2Fb'],
      ['POST', '/api/mcp/connections/a%3Fscope%3Dx'],
      ['POST', '/api/mcp/connections/a%23f'],
      ['POST', '/api/mcp/connections/%2E%2E'],
      ['POST', '/api/mcp/connections/a%252Fb'],
      ['POST', '/api/mcp/connections/a%5Cb/probe'],
      ['POST', '/api/mcp/connections/%2E%2E/probe'],
      ['DELETE', '/api/mcp/connections/a%2F..%2Fb'],
      ['DELETE', '/api/mcp/connections/%2E'],
    ]) {
      const r = await send(method, path)
      assert.equal(r.status, 400, `${method} ${path} → ${r.status} ${r.body}`)
      assert.deepEqual(JSON.parse(r.body), { error: 'invalid_connection_name' })
    }
  })
})

test('MCP connection routes let valid names through to auth', async () => {
  await withMcpApp(async (send) => {
    for (const [method, path] of [
      ['POST', '/api/mcp/connections/system.ai.slack'],
      ['POST', '/api/mcp/connections/main.agents.mcp-google-stitch/probe'],
      ['DELETE', '/api/mcp/connections/ah-github'],
    ]) {
      const r = await send(method, path)
      assert.equal(r.status, 401, `${method} ${path} → ${r.status} ${r.body}`)
    }
  })
})

