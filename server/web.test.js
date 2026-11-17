import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToReadableText, safeGet } from './web.js'

test('extrai texto e remove conteúdo não legível', () => {
  const page = htmlToReadableText('<title>A &amp; B</title><nav>menu</nav><main><h1>Título</h1><p>Texto <a href="/fonte">fonte</a>.</p></main><script>segredo()</script>')
  assert.equal(page.title, 'A & B')
  assert.match(page.text, /Título/)
  assert.match(page.text, /fonte \(\/fonte\)/)
  assert.doesNotMatch(page.text, /menu|segredo/)
})

test('bloqueia protocolos e destinos privados', async () => {
  await assert.rejects(() => safeGet('file:///etc/passwd'), /HTTP\/HTTPS/)
  await assert.rejects(() => safeGet('http://127.0.0.1/'), /privado/)
  await assert.rejects(() => safeGet('http://[::1]/'), /privado/)
})

// ---- SSRF regression: web_fetch (fetchWebPage → safeGet) --------------------
// Customer report: WHATWG `new URL()` rewrites `[::ffff:127.0.0.1]` to the hex
// form `[::ffff:7f00:1]`; a dotted-only mapped-IPv4 check (v1.2.0–v1.4.0) let it
// through. Every case below runs against a throwaway server on 127.0.0.1 that
// returns a marker, and asserts the guard rejects BEFORE any request is opened
// (http.request never called, server never hit). No external network.
import http from 'node:http'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { fetchWebPage } from './web.js'

const MARKER = 'SSRF-MARKER-web-fetch'

async function withMarkerServer(fn) {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(MARKER)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(server.address().port, () => hits)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const PRIVATE_LITERALS = [
  (p) => `http://127.0.0.1:${p}/`,
  (p) => `http://[::ffff:127.0.0.1]:${p}/`, // URL → [::ffff:7f00:1] (the reported bypass)
  (p) => `http://[::ffff:7f00:1]:${p}/`,
  (p) => `http://[0:0:0:0:0:ffff:7f00:1]:${p}/`,
  () => 'http://[::ffff:a9fe:a9fe]/', // 169.254.169.254, cloud metadata
  () => 'http://[::ffff:169.254.169.254]/',
  (p) => `http://[::127.0.0.1]:${p}/`, // IPv4-compatible → [::7f00:1]
  (p) => `http://[64:ff9b::7f00:1]:${p}/`, // NAT64
  (p) => `http://[::1]:${p}/`,
  (p) => `http://2130706433:${p}/`, // decimal → 127.0.0.1
  (p) => `http://0x7f.1:${p}/`, // hex/short → 127.0.0.1
  (p) => `http://0177.0.0.1:${p}/`, // octal → 127.0.0.1
  (p) => `http://localhost:${p}/`,
]

for (const make of PRIVATE_LITERALS) {
  const label = make(0).replace(':0/', ':PORT/')
  test(`web_fetch bloqueia ${label} antes de conectar`, async (t) => {
    await withMarkerServer(async (port, hits) => {
      const request = t.mock.method(http, 'request')
      const url = make(port)
      await assert.rejects(() => fetchWebPage(url), /privado|local não permitido/)
      await assert.rejects(() => safeGet(url), /privado|local não permitido/)
      assert.equal(request.mock.callCount(), 0, 'no socket may be opened')
      assert.equal(hits(), 0, 'internal service must not be reached')
    })
  })
}

test('web_fetch bloqueia hostname que resolve para IPv4 mapeado em IPv6', async (t) => {
  await withMarkerServer(async (port, hits) => {
    const request = t.mock.method(http, 'request')
    for (const answers of [
      [{ address: '::ffff:127.0.0.1', family: 6 }],
      [{ address: '::ffff:7f00:1', family: 6 }],
      [{ address: '::ffff:a9fe:a9fe', family: 6 }],
      [{ address: '93.184.215.14', family: 4 }, { address: '::ffff:7f00:1', family: 6 }], // any private answer
    ]) {
      t.mock.method(dns, 'lookup', async () => answers)
      await assert.rejects(() => fetchWebPage(`http://mapped.example.test:${port}/`), /resolve para endereço privado/)
    }
    assert.equal(request.mock.callCount(), 0)
    assert.equal(hits(), 0)
  })
})

test('web_fetch não segue redirect de host público para alvo privado', async (t) => {
  await withMarkerServer(async (port, hits) => {
    // First hop: a public-looking host. DNS and the HTTP exchange are stubbed so
    // nothing leaves the machine; the stub answers 302 to the mapped loopback.
    t.mock.method(dns, 'lookup', async () => [{ address: '93.184.215.14', family: 4 }])
    const targets = [
      `http://[::ffff:7f00:1]:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      `http://127.0.0.1:${port}/`,
    ]
    for (const location of targets) {
      const request = t.mock.method(http, 'request', (opts, onResponse) => {
        assert.equal(opts.hostname, 'public.example.test')
        const req = new EventEmitter()
        req.setTimeout = () => req
        req.destroy = () => {}
        req.end = () => {
          const res = new EventEmitter()
          res.statusCode = 302
          res.headers = { location }
          onResponse(res)
          res.emit('end')
        }
        return req
      })
      await assert.rejects(() => fetchWebPage('http://public.example.test/start'), /privado/)
      assert.equal(request.mock.callCount(), 1, `only the public hop may be requested (${location})`)
      request.mock.restore()
    }
    assert.equal(hits(), 0)
  })
})
