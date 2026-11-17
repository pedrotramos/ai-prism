import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDsHtml } from './sanitizeDsHtml.js'
import { extractFirstTemplateSlide } from './db.js'

// Anything that would run script once the HTML is parsed: an event-handler
// attribute (after whitespace, a slash or a closing quote), a <script> start tag,
// or a script-bearing URL scheme in an attribute.
function assertInert(out) {
  assert.doesNotMatch(out, /[\s/"']on[a-z0-9_:-]*\s*=/i, `event handler left in: ${out}`)
  assert.doesNotMatch(out, /<script/i, `script tag left in: ${out}`)
  assert.doesNotMatch(out, /javascript:|vbscript:/i, `script URL left in: ${out}`)
}

test('an <img onerror> handler is dropped and the element kept', () => {
  assert.equal(sanitizeDsHtml('<img src=x onerror="alert(1)">'), '<img src="x" />')
})

test('handlers after a slash, a closing quote or in upper case are dropped', () => {
  for (const payload of [
    '<svg/onload=alert(1)>',
    '<img src="x"onerror=alert(1)>',
    "<img src='x' ONERROR='alert(1)'>",
    '<body onload\n=\nalert(1)>',
    '<div onpointerenter=alert(1) class="slide">x</div>',
  ]) {
    assertInert(sanitizeDsHtml(payload))
  }
})

test('a script with a spaced or upper-case end tag is removed with its body', () => {
  assert.equal(sanitizeDsHtml('<p>a</p><script>alert(1)</script ><p>b</p>'), '<p>a</p><p>b</p>')
  assert.equal(sanitizeDsHtml('<p>a</p><SCRIPT type="module">alert(1)</SCRIPT\n>b'), '<p>a</p>b')
  assert.equal(sanitizeDsHtml('<p>a</p><script>never closed'), '<p>a</p>')
})

test('a handler hidden behind a ">" inside a quoted attribute value is still dropped', () => {
  assert.equal(sanitizeDsHtml('<img title="a>b" onerror=alert(1) src=x>'), '<img title="a&gt;b" src="x" />')
})

test('a tag inside an svg <style> (parsed as markup there) is sanitized too', () => {
  assertInert(sanitizeDsHtml('<svg><style><img src=x onerror=alert(1)></style></svg>'))
})

test('javascript: and vbscript: URLs are dropped, including entity-encoded ones', () => {
  assert.equal(sanitizeDsHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeDsHtml('<a href=" JaVaScRiPt:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeDsHtml('<a href="java&#115;cript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeDsHtml('<a href="javascript&colon;alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeDsHtml('<a href="java\tscript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeDsHtml('<svg><a xlink:href="vbscript:x">y</a></svg>'), '<svg><a>y</a></svg>')
  // form controls are not on the allowlist at all: only their text survives
  assert.equal(sanitizeDsHtml('<form><button formaction="javascript:alert(1)">b</button></form>'), 'b')
  assert.equal(sanitizeDsHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), '<img />')
  assert.equal(sanitizeDsHtml('<a href="data:image/png;base64,AAAA">x</a>'), '<a>x</a>')
})

test('embedding elements and srcdoc are removed', () => {
  assertInert(sanitizeDsHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe><object data=x></object><embed src=x><base href="https://evil.example/">'))
  assert.equal(sanitizeDsHtml('<iframe srcdoc="x"></iframe><p>ok</p>'), '<p>ok</p>')
})

test('comments and processing instructions are dropped', () => {
  assert.equal(sanitizeDsHtml('<p>a</p><!-- <img src=x onerror=alert(1)> --><?php x ?><p>b</p>'), '<p>a</p><p>b</p>')
})

test('benign DS markup keeps its doctype, styles, classes, data: images and text', () => {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>.slide{color:var(--fg)}</style></head>' +
    '<body><section><div class="slide" style="background:#fff" data-x=\'1\'><img src="data:image/svg+xml;utf8,<svg></svg>" alt="logo"><p>Olá &amp; até</p></div></section></body></html>'
  assert.equal(
    sanitizeDsHtml(html),
    // <meta> is not on the allowlist (a srcdoc needs no charset); `<` inside an
    // attribute value is re-escaped, which parses back to the same value
    '<!doctype html><html><head><style>.slide{color:var(--fg)}</style></head>' +
      '<body><section><div class="slide" style="background:#fff" data-x="1"><img src="data:image/svg+xml;utf8,&lt;svg&gt;&lt;/svg&gt;" alt="logo" /><p>Olá &amp; até</p></div></section></body></html>'
  )
})

test('SVG drawing survives: camelCase elements kept, attribute names lower-cased (the browser re-cases them)', () => {
  assert.equal(
    sanitizeDsHtml('<svg viewBox="0 0 1 1"><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient><rect fill="url(#g)"/></svg>'),
    '<svg viewbox="0 0 1 1"><linearGradient id="g" gradientunits="userSpaceOnUse"><stop offset="0" stop-color="#fff"></stop></linearGradient><rect fill="url(#g)"></rect></svg>'
  )
})

test('the DS thumbnail extractor returns an inert first slide (crafted DS card from the audit)', () => {
  const card =
    '<style>.slide{color:red}</style><div class="slide"><img src=x onerror="fetch(\'/api/sessions\').then(r=>r.text()).then(t=>parent.document.title=t.length)">' +
    '<svg onload="alert(1)"></svg><a href="javascript:alert(1)">go</a><script>alert(1)</script ><p>Título</p></div>'
  const out = extractFirstTemplateSlide(card)
  assert.match(out, /<p>Título<\/p>/)
  assertInert(out)
})

// CSS can make the sandboxed thumbnail fetch remote resources (a tracking pixel,
// a remote stylesheet). Only data: URIs and relative paths/fragments survive.
test('<style>: @import rules are removed, in any spelling', () => {
  assert.equal(
    sanitizeDsHtml('<style>@import url("https://fonts.example/css2?family=X");.a{color:red}</style>'),
    '<style>.a{color:red}</style>'
  )
  assert.equal(sanitizeDsHtml('<style>@IMPORT "https://x.example/a.css" screen;.a{color:red}</style>'), '<style>.a{color:red}</style>')
  assert.equal(sanitizeDsHtml('<style>@\\69mport "https://x.example/a.css";.a{}</style>'), '<style>.a{}</style>')
  assert.equal(sanitizeDsHtml('<style>@import url("a;b.css");.a{}</style>'), '<style>.a{}</style>')
})

test('<style>: remote url() targets become none; data:, relative and fragments stay', () => {
  assert.equal(
    sanitizeDsHtml('<style>.a{background:url(https://t.example/p.png) no-repeat}.b{background:url(\'//t.example/p.png\')}</style>'),
    '<style>.a{background:none no-repeat}.b{background:none}</style>'
  )
  assert.equal(sanitizeDsHtml('<style>.a{background:U\\72L(https://t.example/p.png)}</style>'), '<style>.a{background:none}</style>')
  assert.equal(
    sanitizeDsHtml('<style>.a{background:image-set("https://t.example/a.png" 1x)}</style>'),
    '<style>.a{background:none}</style>'
  )
  const kept =
    '<style>@font-face{font-family:X;src:url(data:font/woff2;base64,AAAA) format("woff2")}' +
    '.a{background:url("../assets/bg.png")}.b{fill:url(#grad)}.c{content:"url(https://t.example/x)"}</style>'
  assert.equal(sanitizeDsHtml(kept), kept)
  assert.equal(
    sanitizeDsHtml('<style>@font-face{font-family:X;src:url(https://f.example/x.woff2) format("woff2"),url(data:font/woff2;base64,AAAA)}</style>'),
    '<style>@font-face{font-family:X;src:none format("woff2"),url(data:font/woff2;base64,AAAA)}</style>'
  )
})

test('style attributes and SVG paint attributes lose remote url() targets', () => {
  assert.equal(
    sanitizeDsHtml('<div style="background-image:url(https://t.example/p.png);color:red">x</div>'),
    '<div style="background-image:none;color:red">x</div>'
  )
  assert.equal(
    sanitizeDsHtml('<svg><rect fill="url(https://t.example/s.svg#g)" stroke="url(#g)" mask="url(http://t.example/m)"></rect></svg>'),
    '<svg><rect fill="none" stroke="url(#g)" mask="none"></rect></svg>'
  )
})

test('<use> may only reference a fragment of the same document', () => {
  assert.equal(sanitizeDsHtml('<svg><use href="https://t.example/s.svg#a"></use><use href="#a"></use></svg>'), '<svg><use></use><use href="#a"></use></svg>')
  assert.equal(sanitizeDsHtml('<svg><use xlink:href="sprite.svg#a"></use></svg>'), '<svg><use></use></svg>')
})

test('srcdoc is dropped from a tag that survives', () => {
  assert.equal(sanitizeDsHtml('<div srcdoc="<p>x</p>" class="a">y</div>'), '<div class="a">y</div>')
})

test('URL attributes: only allow-listed ones survive, never with a script scheme', () => {
  const js = 'javascript:alert(1)'
  assert.equal(sanitizeDsHtml(`<a href="${js}">x</a>`), '<a>x</a>')
  assert.equal(sanitizeDsHtml('<a href="https://t.example/">x</a>'), '<a href="https://t.example/">x</a>')
  assert.equal(sanitizeDsHtml(`<img src="${js}">`), '<img />')
  assert.equal(sanitizeDsHtml(`<svg><use xlink:href="${js}"></use></svg>`), '<svg><use></use></svg>')
  // action, formaction, poster, background, cite and srcset are not on the allowlist at all
  assert.equal(
    sanitizeDsHtml(`<div action="${js}" formaction="${js}" poster="${js}" background="${js}">x</div>`),
    '<div>x</div>'
  )
  assert.equal(sanitizeDsHtml('<table background="https://t.example/bg.png"><tr><td>x</td></tr></table>'), '<table><tr><td>x</td></tr></table>')
  assert.equal(sanitizeDsHtml(`<a href="https://t.example/" cite="${js}">x</a>`), '<a href="https://t.example/">x</a>')
  assert.equal(sanitizeDsHtml(`<img src="a.png" srcset="${js} 1x, https://t.example/b.png 2x">`), '<img src="a.png" />')
})

test('frame, frameset and applet are removed (text content only)', () => {
  assert.equal(sanitizeDsHtml('<frameset><frame src="javascript:alert(1)"></frameset><applet code="x">y</applet><p>ok</p>'), 'y<p>ok</p>')
})

test('MathML is not allowed; a <style> inside it keeps no markup', () => {
  const out = sanitizeDsHtml('<math><mi xlink:href="javascript:alert(1)">x</mi><mtext><style><img src=x onerror=alert(1)></style></mtext></math>')
  assert.doesNotMatch(out, /<math|<mi|<img|javascript:/i)
  // the <style> survives at top level as raw CSS text with `<` CSS-escaped
  assert.equal(out, 'x<style>\\3c img src=x onerror=alert(1)></style>')
})

test('svg foreignObject is removed and what was inside it is sanitized', () => {
  const out = sanitizeDsHtml('<svg><foreignObject><img src=x onerror=alert(1)><iframe srcdoc="x"></iframe></foreignObject></svg>')
  assert.equal(out, '<svg><img src="x" /></svg>')
  assertInert(out)
})
