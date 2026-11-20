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
