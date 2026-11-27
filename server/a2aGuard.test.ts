import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  A2aError,
  a2aConfig,
  blockedAddressReason,
  checkUrl,
  createGuardedFetch,
  guardedLookup,
  isDatabricksUrl,
  isLoopbackHost,
  isStrictHostPattern,
  parsePattern,
  redactSecrets,
  urlMatchesPattern,
} from './a2aGuard.ts'

const PUBLIC = a2aConfig({})
const LOCAL = a2aConfig({ A2A_ALLOW_INSECURE_LOCAL: '1' })

type Resolver = NonNullable<Parameters<typeof guardedLookup>[1]>

const blocked = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof A2aError && e.code === 'blocked_url')

test('checkUrl: https only, no credentials, no metadata hosts', () => {
  assert.equal(checkUrl('https://api.example.com/v1').hostname, 'api.example.com')
  blocked(() => checkUrl('http://api.example.com/'))
  blocked(() => checkUrl('ftp://api.example.com/'))
  blocked(() => checkUrl('https://user:pass@api.example.com/'))
  blocked(() => checkUrl('https://metadata.google.internal/'))
  blocked(() => checkUrl('https://service.internal/'))
  blocked(() => checkUrl('not a url'))
})

test('checkUrl: literal private, link-local (metadata 169.254.169.254) and loopback addresses are refused', () => {
  blocked(() => checkUrl('https://169.254.169.254/latest/meta-data/', PUBLIC))
  blocked(() => checkUrl('https://10.0.0.5/', PUBLIC))
  blocked(() => checkUrl('https://192.168.1.1/', PUBLIC))
  blocked(() => checkUrl('https://172.16.0.1/', PUBLIC))
  blocked(() => checkUrl('https://100.64.0.1/', PUBLIC)) // CGNAT
  blocked(() => checkUrl('https://[fd00::1]/', PUBLIC)) // ULA
  blocked(() => checkUrl('https://[fe80::1]/', PUBLIC)) // link-local
  blocked(() => checkUrl('https://[::ffff:169.254.169.254]/', PUBLIC)) // mapped metadata
  blocked(() => checkUrl('https://127.0.0.1/', PUBLIC))
  blocked(() => checkUrl('https://localhost/', PUBLIC))
})

test('checkUrl: plain http is allowed only for loopback, and only with the insecure-local flag', () => {
  assert.equal(checkUrl('http://127.0.0.1:9/', LOCAL).protocol, 'http:')
  blocked(() => checkUrl('http://127.0.0.1:9/', PUBLIC))
  blocked(() => checkUrl('http://api.example.com/', LOCAL))
})

test('checkUrl: a public literal address is accepted', () => {
  assert.equal(checkUrl('https://93.184.216.34/x', PUBLIC).hostname, '93.184.216.34')
})

test('blockedAddressReason covers the reserved IPv4 and IPv6 ranges', () => {
  assert.equal(blockedAddressReason('8.8.8.8'), null)
  assert.equal(blockedAddressReason('2606:4700:4700::1111'), null)
  assert.match(blockedAddressReason('10.1.2.3') as string, /reserved/)
  assert.equal(blockedAddressReason('10.1.2.3', { allowPrivate: true }), null)
  assert.equal(blockedAddressReason('127.0.0.1'), 'loopback')
  assert.equal(blockedAddressReason('127.0.0.1', { allowLoopback: true }), null)
  assert.equal(blockedAddressReason('255.255.255.255'), 'broadcast')
  assert.equal(blockedAddressReason('::'), 'unspecified')
  assert.equal(blockedAddressReason('::1'), 'loopback')
  assert.equal(blockedAddressReason('fc00::1'), 'unique-local')
  assert.equal(blockedAddressReason('fe80::1'), 'link-local')
  assert.equal(blockedAddressReason('ff02::1'), 'multicast')
  assert.equal(blockedAddressReason('2001:db8::1'), 'documentation')
  assert.equal(blockedAddressReason('not-an-ip'), 'not an IP address')
  assert.match(blockedAddressReason('::ffff:10.0.0.1') as string, /via ::ffff/)
})

test('guardedLookup refuses a hostname whose answers mix public and private addresses', async () => {
  const resolver: Resolver = (_host, _opts, cb) =>
    cb(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ])
  const lookup = guardedLookup(PUBLIC, resolver)
  await new Promise<void>((resolve) =>
    lookup('api.example.com', {}, (err) => {
      assert.ok(err instanceof A2aError)
      assert.equal(err.code, 'blocked_url')
      resolve()
    })
  )
})

test('guardedLookup returns the public answers when every address is public', async () => {
  const resolver: Resolver = (_host, _opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }])
  const lookup = guardedLookup(PUBLIC, resolver)
  await new Promise<void>((resolve, reject) =>
    lookup('api.example.com', { all: true }, (err, list) => {
      if (err) return reject(err)
      assert.deepEqual(list, [{ address: '93.184.216.34', family: 4 }])
      resolve()
    })
  )
})

test('isLoopbackHost recognizes localhost names and loopback literals only', () => {
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('dev.localhost'), true)
  assert.equal(isLoopbackHost('127.5.5.5'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost('example.com'), false)
})

test('host patterns: strict syntax, subdomain wildcard, port and path prefix', () => {
  assert.equal(isStrictHostPattern('*.example.com'), true)
  assert.equal(isStrictHostPattern('example.com:8443/agents'), true)
  assert.equal(isStrictHostPattern('https://example.com'), false)
  assert.equal(isStrictHostPattern('user@example.com'), false)
  assert.equal(isStrictHostPattern('example.com/../x'), false)

  const wild = parsePattern('*.example.com')
  assert.equal(urlMatchesPattern(new URL('https://a.b.example.com/x'), wild), true)
  assert.equal(urlMatchesPattern(new URL('https://example.org/x'), wild), false)

  const prefixed = parsePattern('api.example.com/agents')
  assert.equal(urlMatchesPattern(new URL('https://api.example.com/agents/card'), prefixed), true)
  assert.equal(urlMatchesPattern(new URL('https://api.example.com/agentsx'), prefixed), false)
  assert.equal(urlMatchesPattern(new URL('https://u:p@api.example.com/agents'), prefixed), false)
})

test('redactSecrets removes bearer tokens and the given secrets', () => {
  const out = redactSecrets('Authorization: Bearer abcdefghijkl and key=SECRET-VALUE', ['SECRET-VALUE'])
  assert.doesNotMatch(out, /abcdefghijkl/)
  assert.doesNotMatch(out, /SECRET-VALUE/)
})

test('createGuardedFetch: https-only for remote hosts, no redirects, bounded body', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const { port } = server.address() as import('node:net').AddressInfo
  const guarded = createGuardedFetch({ requireToken: false, allowUrl: () => true, cfg: LOCAL })

  const ok = await guarded(`http://127.0.0.1:${port}/ok`, { headers: { accept: 'application/json' } })
  assert.equal(ok.status ?? 200, 200)

  await assert.rejects(guarded(`http://127.0.0.1:${port}/redirect`, {}), (e: unknown) => e instanceof A2aError)
})

test('createGuardedFetch refuses a URL the caller did not allow, before any connection', async () => {
  const guarded = createGuardedFetch({ requireToken: false, allowUrl: () => false, cfg: PUBLIC })
  await assert.rejects(guarded('https://93.184.216.34/'), (e: { code?: string }) => e.code === 'blocked_url')
})

test('A2aError keeps main\'s own-key order (name, code, extras): `code` is not a class field', () => {
  assert.deepEqual(Object.keys(new A2aError('blocked_url', 'x')), ['name', 'code'])
  assert.deepEqual(Object.keys(new A2aError('timeout', 'x', { status: 504 })), ['name', 'code', 'status'])
})

// ---- the host allowlist: workspace hosts, public (no credential) hosts, and what it never accepts ------------------

test('A2A_ALLOWED_HOSTS: databricks: entries are workspace-eligible, plain entries are public hosts, malformed ones are ignored', () => {
  const cfg = a2aConfig({ A2A_ALLOWED_HOSTS: 'databricks:*.apps.example.net, agents.example.org, *.public.example.com/a2a, not a host!, ' })
  assert.deepEqual(cfg.databricksPatterns.map((p) => p.text), ['*.apps.example.net'])
  assert.deepEqual(cfg.publicPatterns.map((p) => p.text), ['agents.example.org', '*.public.example.com/a2a'])
  assert.deepEqual(cfg.ignoredAllowlist, ['not a host!'])
  const none = a2aConfig({})
  assert.deepEqual([none.databricksPatterns, none.publicPatterns, none.ignoredAllowlist], [[], [], []], 'an empty allowlist allows nothing')
  const pattern = cfg.publicPatterns[1] as NonNullable<ReturnType<typeof parsePattern>>
  assert.equal(urlMatchesPattern('https://x.public.example.com/a2a/card', pattern), true)
  assert.equal(urlMatchesPattern('https://x.public.example.com/other', pattern), false, 'a path prefix pins the path')
  assert.equal(urlMatchesPattern('https://public.example.com.evil.net/a2a', pattern), false)
})

test('the workspace\'s own Apps domain is a Databricks host without any allowlist entry (app-to-app), and a lookalike is not', () => {
  const cfg = a2aConfig({ DATABRICKS_HOST: 'https://adb-123.4.azuredatabricks.net' })
  assert.equal(isDatabricksUrl('https://adb-123.4.azuredatabricks.net/api/2.0/x', cfg), true)
  assert.equal(isDatabricksUrl('https://adb-123.4.azuredatabricks.net.evil.net/', cfg), false)
  assert.equal(isDatabricksUrl('https://elsewhere.example.com/', cfg), false)

  // Databricks Apps: only this workspace's own Apps (its id is in the host), and only once the workspace is known
  const own = a2aConfig({ DATABRICKS_WORKSPACE_ID: '1234567890' })
  assert.equal(isDatabricksUrl('https://agent-1234567890.0.azure.databricksapps.com/a2a', own), true)
  assert.equal(isDatabricksUrl('https://agent-9999999999.0.azure.databricksapps.com/a2a', own), false, 'another workspace\'s App never gets the user token')
  assert.equal(isDatabricksUrl('https://agent-1234567890.0.azure.databricksapps.com/a2a', a2aConfig({})), false, 'without a workspace id no Apps host qualifies')
  assert.equal(isDatabricksUrl('https://agent-1234567890.0.azure.databricksapps.com/a2a', a2aConfig({ A2A_ALLOWED_HOSTS: 'databricks:*.databricksapps.com' })), true, 'an explicit databricks: entry is the opt-in')
})

// ---- the optional gateway header ---------------------------------------------------------------------------------------

async function recordingServer(t: import('node:test').TestContext, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const seen: http.IncomingHttpHeaders[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(status, headers)
    res.end(status === 200 ? '{"ok":true}' : 'Forbidden')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` }
}

test('frontDoor: the ID token travels in the named header only when one is configured, to the allowed hosts only', async (t) => {
  const { seen, base } = await recordingServer(t)
  const withHeader = createGuardedFetch({ token: 'access-1', allowUrl: () => true, frontDoor: { idToken: 'id-1', header: 'X-Gateway-Id-Token' }, cfg: LOCAL })
  await withHeader(`${base}/a`, {})
  assert.equal(seen[0]?.authorization, 'Bearer access-1')
  assert.equal(seen[0]?.['x-gateway-id-token'], 'Bearer id-1')

  // an ID token without a header name is never sent anywhere
  const noHeader = createGuardedFetch({ token: 'access-1', allowUrl: () => true, frontDoor: { idToken: 'id-1' }, cfg: LOCAL })
  await noHeader(`${base}/b`, {})
  assert.equal(seen[1]?.authorization, 'Bearer access-1')
  assert.equal(Object.keys(seen[1] || {}).some((k) => k.startsWith('x-gateway')), false)
  assert.equal(JSON.stringify(seen[1]).includes('id-1'), false)
})

test('frontDoor: a 403 without a JSON body or a bearer challenge is the gateway refusing, recorded in the state', async (t) => {
  const refused = await recordingServer(t, 403, { 'content-type': 'text/html' })
  const state: { frontDoor?: boolean; authStatus?: number } = {}
  const guarded = createGuardedFetch({ token: 'access-1', allowUrl: () => true, frontDoor: { idToken: 'id-1', header: 'X-Gateway-Id-Token' }, cfg: LOCAL, state })
  await guarded(`${refused.base}/a`, {}).catch(() => {})
  assert.equal(state.frontDoor, true)
  assert.equal(state.authStatus, 403)

  const agent403 = await recordingServer(t, 403, { 'content-type': 'application/json' })
  const state2: { frontDoor?: boolean } = {}
  const g2 = createGuardedFetch({ token: 'access-1', allowUrl: () => true, frontDoor: { idToken: 'id-1', header: 'X-Gateway-Id-Token' }, cfg: LOCAL, state: state2 })
  await g2(`${agent403.base}/a`, {}).catch(() => {})
  assert.equal(state2.frontDoor, false, 'the agent\'s own JSON 403 is not the gateway')
})

test('route: the credential is chosen per destination, and a destination nothing covers sends nothing', async (t) => {
  const { seen, base } = await recordingServer(t)
  const guarded = createGuardedFetch({
    allowUrl: () => true,
    cfg: LOCAL,
    route: (url) => {
      if (url.pathname.startsWith('/id')) return { token: 'the-id-token', frontDoorIdToken: null }
      throw new A2aError('blocked_url', 'no destination covers this URL')
    },
  })
  await guarded(`${base}/id/card`, {})
  assert.equal(seen[0]?.authorization, 'Bearer the-id-token')
  await assert.rejects(guarded(`${base}/other`, {}), (e: { code?: string }) => e.code === 'blocked_url')
  assert.equal(seen.length, 1, 'refused before any request')
})
