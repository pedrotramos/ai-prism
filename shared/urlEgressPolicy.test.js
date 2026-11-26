// Egress policy: allowlist parsing, image-src classification, external-host listing.
//   node --test shared/urlEgressPolicy.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_EGRESS_POLICY, parseAllowedOrigins, classifyImageSrc, externalUrlHosts } from './urlEgressPolicy.js'

const APP = 'https://app.example-apps.test'
const policy = (...origins) => ({ allowedOrigins: origins.map((origin) => ({ origin })) })
const P = policy('https://cdn.good.com')
const cls = (src, pol = P) => classifyImageSrc(src, pol, APP)

test('EMPTY_EGRESS_POLICY has no allowed origins', () => {
  assert.deepEqual(EMPTY_EGRESS_POLICY, { allowedOrigins: [] })
})

// ---- classifyImageSrc ----------------------------------------------------------------------------------------------

test('classifyImageSrc: the app itself, relative paths, data and blob are not egress', () => {
  assert.deepEqual(cls('/api/assets/1'), { kind: 'relative' })
  assert.deepEqual(cls('img/logo.png'), { kind: 'relative' })
  assert.deepEqual(cls('./a.png?x=1'), { kind: 'relative' })
  assert.deepEqual(cls(`${APP}/x.png`), { kind: 'same-origin' })
  assert.deepEqual(cls('data:image/png;base64,AAAA'), { kind: 'data' })
  assert.deepEqual(cls('data:image/svg+xml;utf8,<svg/>'), { kind: 'data' })
  assert.deepEqual(cls('data:image/jpeg;base64,AAAA'), { kind: 'data' })
  assert.deepEqual(cls(`blob:${APP}/0b8f-1`), { kind: 'blob' })
})

test('classifyImageSrc: data: that is not a raster or svg image is blocked with no host', () => {
  for (const s of ['data:text/html,<script>1</script>', 'data:application/json,{}', 'data:,hello', 'data:image/x-evil;base64,AA'])
    assert.deepEqual(cls(s), { kind: 'blocked', host: null }, s)
})

test('classifyImageSrc: an exact allowed origin is allowed (any path and query)', () => {
  assert.deepEqual(cls('https://cdn.good.com/a/b.png?v=2'), { kind: 'allowed', host: 'cdn.good.com' })
  assert.deepEqual(cls('HTTPS://CDN.GOOD.COM/a.png'), { kind: 'allowed', host: 'cdn.good.com' })
  assert.deepEqual(cls('https://cdn.good.com:443/a.png'), { kind: 'allowed', host: 'cdn.good.com' })
})

test('classifyImageSrc: an arbitrary external host is blocked and named', () => {
  assert.deepEqual(cls('http://127.0.0.1:9999/?d=SECRET'), { kind: 'blocked', host: '127.0.0.1' })
  assert.deepEqual(cls('https://evil.com/p.png?d=SECRET', EMPTY_EGRESS_POLICY), { kind: 'blocked', host: 'evil.com' })
})

test('classifyImageSrc: VS Code bypass table (every case blocked)', () => {
  const blocked = {
    suffix: 'https://cdn.good.com.evil.com/a.png',
    prefix: 'https://evilcdn.good.com.evil.com/a.png',
    'other parent': 'https://good.com/a.png',
    subdomain: 'https://x.cdn.good.com/a.png',
    userinfo: 'https://cdn.good.com@evil.com/a.png',
    'userinfo reversed': 'https://evil.com@cdn.good.com/a.png',
    'userinfo + password': 'https://u:p@cdn.good.com/a.png',
    port: 'https://cdn.good.com:8443/a.png',
    'port 80': 'https://cdn.good.com:80/a.png',
    http: 'http://cdn.good.com/a.png',
    'trailing dot': 'https://cdn.good.com./a.png',
    'dot-dot host': 'https://cdn.good.com../a.png',
    '%2e in host': 'https://cdn%2egood.com/a.png',
    '%252e in host': 'https://cdn%252egood.com/a.png',
    '%2f in host': 'https://cdn.good.com%2f.evil.com/a.png',
    '%5c in host': 'https://cdn.good.com%5c.evil.com/a.png',
    'backslash host': 'https://evil.com\\@cdn.good.com/a.png',
    'allowed in query': 'https://evil.com/?u=https://cdn.good.com/a.png',
    'allowed in path': 'https://evil.com/https://cdn.good.com/a.png',
    'allowed in fragment': 'https://evil.com/#https://cdn.good.com',
    'protocol-relative': '//cdn.good.com/a.png',
    'protocol-relative evil': '//evil.com/a.png',
    'backslash protocol-relative': '/\\evil.com/a.png',
    'protocol-relative to app': `//${new URL(APP).host}/a.png`,
    file: 'file:///etc/passwd',
    ftp: 'ftp://cdn.good.com/a.png',
    javascript: 'javascript:alert(1)',
    ws: 'wss://cdn.good.com/a.png',
    'unknown scheme': 'foo://cdn.good.com/a.png',
  }
  for (const [name, src] of Object.entries(blocked)) assert.equal(cls(src).kind, 'blocked', `${name}: ${src}`)
})

test('classifyImageSrc: blocked reports the resolved host, or null when there is none', () => {
  assert.deepEqual(cls('https://cdn.good.com.evil.com/a.png'), { kind: 'blocked', host: 'cdn.good.com.evil.com' })
  assert.deepEqual(cls('//evil.com/a.png'), { kind: 'blocked', host: 'evil.com' })
  assert.deepEqual(cls('file:///etc/passwd'), { kind: 'blocked', host: null })
  assert.deepEqual(cls('javascript:alert(1)'), { kind: 'blocked', host: null })
})

test('classifyImageSrc: tabs, newlines and mixed case in the scheme do not smuggle a host', () => {
  assert.equal(cls('ht\ttps://evil.com/a.png').kind, 'blocked')
  assert.equal(cls('  https://evil.com/a.png  ').kind, 'blocked')
  assert.equal(cls('HtTpS://EVIL.com/a.png').kind, 'blocked')
  assert.equal(cls('https://evil.com\n/a.png').kind, 'blocked')
})

test('classifyImageSrc: junk input fails closed', () => {
  for (const s of [undefined, null, 42, {}, 'https://', 'https://[::1', 'http://%']) assert.notEqual(cls(s).kind, 'allowed')
  assert.equal(cls('https://').kind, 'blocked')
})

test('classifyImageSrc: an allowed origin with an explicit port allows that port only', () => {
  const p = policy('https://cdn.good.com:8443')
  assert.equal(classifyImageSrc('https://cdn.good.com:8443/a.png', p, APP).kind, 'allowed')
  assert.equal(classifyImageSrc('https://cdn.good.com/a.png', p, APP).kind, 'blocked')
})

// ---- parseAllowedOrigins -------------------------------------------------------------------------------------------

test('parseAllowedOrigins: space- or comma-separated string, or an array; lowercased and deduped in order', () => {
  const a = parseAllowedOrigins('https://A.good.com, https://b.good.com  https://a.good.com')
  assert.deepEqual(a.allowed, [{ origin: 'https://a.good.com' }, { origin: 'https://b.good.com' }])
  assert.deepEqual(a.rejected, [])
  assert.deepEqual(parseAllowedOrigins(['https://x.good.com', 'https://y.good.com:8443']).allowed, [
    { origin: 'https://x.good.com' },
    { origin: 'https://y.good.com:8443' },
  ])
  assert.deepEqual(parseAllowedOrigins(undefined), { allowed: [], rejected: [] })
  assert.deepEqual(parseAllowedOrigins(''), { allowed: [], rejected: [] })
})

test('parseAllowedOrigins: refuses wildcards, IPs, paths, queries, userinfo, http and junk', () => {
  const bad = [
    'https://*.good.com',
    '*',
    'https://*',
    'http://good.com',
    'https://127.0.0.1',
    'https://10.0.0.1:8443',
    'https://[::1]',
    'https://good.com/',
    'https://good.com/path',
    'https://good.com?x=1',
    'https://good.com#f',
    'https://user@good.com',
    'https://user:pw@good.com',
    'https://localhost',
    'https://com',
    'https://good.com.',
    'https://good..com',
    'https://-good.com',
    'good.com',
    "https://good.com'; script-src *",
    'https://good.com;',
    'https://go od.com',
    'ftp://good.com',
    'https://xn--%.com',
  ]
  const r = parseAllowedOrigins(bad.filter((s) => !/\s/.test(s)))
  assert.deepEqual(r.allowed, [])
  assert.equal(r.rejected.length, bad.filter((s) => !/\s/.test(s)).length)
  // a mixed list keeps the good ones and reports the rest
  const m = parseAllowedOrigins('https://ok.good.com https://*.evil.com http://nope.com')
  assert.deepEqual(m.allowed, [{ origin: 'https://ok.good.com' }])
  assert.deepEqual(m.rejected, ['https://*.evil.com', 'http://nope.com'])
})

test('parseAllowedOrigins: never the app, workspace or Databricks hosts', () => {
  const hosts = { appHost: 'prism-123.aws.databricksapps.com', workspaceHost: 'https://adb-1.2.azuredatabricks.net' }
  const raw = [
    'https://prism-123.aws.databricksapps.com',
    'https://adb-1.2.azuredatabricks.net',
    'https://other.databricksapps.com',
    'https://x.cloud.databricks.com',
    'https://databricks.com',
    'https://www.databricks.com',
    'https://x.gcp.databricks.com',
    'https://ok.good.com',
  ]
  const r = parseAllowedOrigins(raw, hosts)
  assert.deepEqual(r.allowed, [{ origin: 'https://ok.good.com' }])
  assert.equal(r.rejected.length, 7)
  // Databricks hosts are refused even without host hints
  assert.deepEqual(parseAllowedOrigins('https://x.cloud.databricks.com').allowed, [])
})

test('parseAllowedOrigins: caps at 32 entries; the rest is reported as rejected', () => {
  const raw = Array.from({ length: 40 }, (_, i) => `https://h${i}.good.com`)
  const r = parseAllowedOrigins(raw)
  assert.equal(r.allowed.length, 32)
  assert.equal(r.allowed[31].origin, 'https://h31.good.com')
  assert.deepEqual(r.rejected, raw.slice(32))
})

test('parseAllowedOrigins: no entry carries a pathPrefix in 2.0.0', () => {
  for (const e of parseAllowedOrigins('https://a.good.com').allowed) assert.equal('pathPrefix' in e, false)
})

test('parseAllowedOrigins: very long or non-string entries are rejected without throwing', () => {
  const r = parseAllowedOrigins(['https://' + 'a'.repeat(300) + '.com', 42, null, {}])
  assert.deepEqual(r.allowed, [])
  assert.equal(r.rejected.length >= 1, true)
})

// ---- externalUrlHosts ----------------------------------------------------------------------------------------------

test('externalUrlHosts markdown: inline images and links, hosts only', () => {
  const md = [
    '![x](http://Evil.com/p.png?d=SECRET "t")',
    '![](<https://img.evil2.com/a b.png>)',
    '[click](https://link.evil3.com/page?token=abc#frag)',
    '![local](/api/x.png) ![d](data:image/png;base64,AA) [rel](/docs) [app](https://app.example-apps.test/x)',
  ].join('\n')
  const r = externalUrlHosts(md, 'markdown', APP)
  assert.deepEqual(r.images.sort(), ['evil.com', 'img.evil2.com'])
  assert.deepEqual(r.links, ['link.evil3.com'])
  assert.equal(JSON.stringify(r).includes('SECRET'), false)
  assert.equal(JSON.stringify(r).includes('/'), false)
})

test('externalUrlHosts markdown: reference-style images and links; unused definitions do not count', () => {
  const md = ['![a][r1] ![r2] ![c][]', '[t][l1]', '', '[r1]: https://one.evil.com/x.png?d=S', '[R2]: <https://two.evil.com/y>', '[c]: https://three.evil.com/z', '[l1]: https://link.evil.com/q', '[unused]: https://unused.evil.com/u'].join('\n')
  const r = externalUrlHosts(md, 'markdown', APP)
  assert.deepEqual(r.images.sort(), ['one.evil.com', 'three.evil.com', 'two.evil.com'])
  assert.deepEqual(r.links, ['link.evil.com'])
})

test('externalUrlHosts markdown: an image inside a link, in a table, and a raw <img>', () => {
  const md = '[![a](https://img.evil.com/a.png)](https://go.evil.com/x)\n\n| a | b |\n|---|---|\n| ![](https://cell.evil.com/c.png?d=1) | x |\n\n<img src="https://raw.evil.com/r.png">'
  const r = externalUrlHosts(md, 'markdown', APP)
  assert.deepEqual(r.images.sort(), ['cell.evil.com', 'img.evil.com', 'raw.evil.com'])
  assert.deepEqual(r.links, ['go.evil.com'])
})

test('externalUrlHosts markdown: autolinks, bare URLs; code spans and fences are not rendered', () => {
  const md = '<https://auto.evil.com/x> and https://bare.evil.com/y?q=1.\n\n`![](https://code.evil.com/a)`\n\n```\n![](https://fence.evil.com/a)\n```'
  const r = externalUrlHosts(md, 'markdown', APP)
  assert.deepEqual(r.links.sort(), ['auto.evil.com', 'bare.evil.com'])
  assert.deepEqual(r.images, [])
})

test('externalUrlHosts markdown: protocol-relative and dedup', () => {
  const r = externalUrlHosts('![a](//p.evil.com/a) ![b](https://p.evil.com/b) ![c](https://P.EVIL.com:8443/c)', 'markdown', APP)
  assert.deepEqual(r.images, ['p.evil.com'])
})

test('externalUrlHosts html: src, srcset, href, ping, poster, url(), @import', () => {
  const html = `
    <div style="background:url('https://bg.evil.com/a.png?d=1')">
    <img src="https://img.evil.com/a.png" srcset="https://s1.evil.com/a.png 1x, https://s2.evil.com/b.png 2x">
    <a href="https://link.evil.com/x" ping="https://ping1.evil.com/p https://ping2.evil.com/q">go</a>
    <video poster='https://poster.evil.com/p.jpg' src=https://vid.evil.com/v.mp4></video>
    <style>@import "https://css1.evil.com/a.css"; @import url(https://css2.evil.com/b.css); .x{background:url(https://css3.evil.com/c.png)}</style>
    <svg><image xlink:href="https://svg.evil.com/i.png"/></svg>
    <img src="/api/local.png"><img src="data:image/png;base64,AAAA"><a href="#top">t</a><a href="https://app.example-apps.test/x">app</a>`
  const r = externalUrlHosts(html, 'html', APP)
  assert.deepEqual(r.images.sort(), ['bg.evil.com', 'css1.evil.com', 'css2.evil.com', 'css3.evil.com', 'img.evil.com', 'poster.evil.com', 's1.evil.com', 's2.evil.com', 'svg.evil.com', 'vid.evil.com'])
  assert.deepEqual(r.links.sort(), ['link.evil.com', 'ping1.evil.com', 'ping2.evil.com'])
})

test('externalUrlHosts html: entity-encoded and whitespace-split URLs are decoded like a browser would', () => {
  const r = externalUrlHosts('<img src="&#104;ttps://ent.evil.com/a.png"><img src="https&colon;//col.evil.com/a"><img src="ht&#9;tps://tab.evil.com/a">', 'html', APP)
  assert.deepEqual(r.images.sort(), ['col.evil.com', 'ent.evil.com', 'tab.evil.com'])
})

test('externalUrlHosts: empty, non-string and hostile input never throws', () => {
  assert.deepEqual(externalUrlHosts('', 'markdown', APP), { images: [], links: [] })
  assert.deepEqual(externalUrlHosts(undefined, 'html', APP), { images: [], links: [] })
  assert.deepEqual(externalUrlHosts('![](' + '('.repeat(5000), 'markdown', APP), { images: [], links: [] })
  const t0 = Date.now()
  externalUrlHosts('![' + '['.repeat(20000), 'markdown', APP)
  externalUrlHosts('<img src="' + 'a'.repeat(200000), 'html', APP)
  assert.ok(Date.now() - t0 < 2000, 'no catastrophic backtracking')
})
