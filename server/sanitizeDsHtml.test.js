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
  assert.equal(sanitizeDsHtml('<img src=x onerror="alert(1)">'), '<img src="x">')
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
  assert.equal(sanitizeDsHtml('<img title="a>b" onerror=alert(1) src=x>'), '<img title="a>b" src="x">')
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
  assert.equal(sanitizeDsHtml('<form><button formaction="javascript:alert(1)">b</button></form>'), '<form><button>b</button></form>')
})

test('embedding elements and srcdoc are removed', () => {
  assertInert(sanitizeDsHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe><object data=x></object><embed src=x><base href="https://evil.example/">'))
  assert.equal(sanitizeDsHtml('<iframe srcdoc="x"></iframe><p>ok</p>'), '<p>ok</p>')
})

test('comments and processing instructions are dropped', () => {
  assert.equal(sanitizeDsHtml('<p>a</p><!-- <img src=x onerror=alert(1)> --><?php x ?><p>b</p>'), '<p>a</p><p>b</p>')
})

test('benign DS markup keeps its styles, classes, data: images and text', () => {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>.slide{color:var(--fg)}</style></head>' +
    '<body><section><div class="slide" style="background:#fff" data-x=\'1\'><img src="data:image/svg+xml;utf8,<svg></svg>" alt="logo"><p>Olá &amp; até</p></div></section></body></html>'
  assert.equal(
    sanitizeDsHtml(html),
    '<!doctype html><html><head><meta charset="utf-8"><style>.slide{color:var(--fg)}</style></head>' +
      '<body><section><div class="slide" style="background:#fff" data-x="1"><img src="data:image/svg+xml;utf8,<svg></svg>" alt="logo"><p>Olá &amp; até</p></div></section></body></html>'
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
