import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sanitizeDsHtml, cssScanWork } from './sanitizeDsHtml.ts'
import { extractFirstTemplateSlide } from './db.ts'

// Anything that would run script once the HTML is parsed: an event-handler
// attribute (after whitespace, a slash or a closing quote), a <script> start tag,
// or a script-bearing URL scheme in an attribute.
function assertInert(out: string) {
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
// a remote stylesheet). The CSS is normalized first (comments and NUL removed,
// escapes that spell letters decoded) and what is checked is what is emitted:
// a url() survives only if its argument is exactly a data: image/font URI, a
// relative path or a #fragment; anything else, or anything ambiguous, removes
// the whole declaration. @import and image-set()/src()/… are always removed.
const css = (body: string) => sanitizeDsHtml(`<style>${body}</style>`)
const wrap = (body: string) => `<style>${body}</style>`

test('<style>: @import is always removed, in any spelling, with comments around it', () => {
  assert.equal(css('@import url("https://fonts.example/css2?family=X:wght@400;700");.a{color:red}'), wrap('.a{color:red}'))
  assert.equal(css('@IMPORT "https://x.example/a.css" screen;.a{color:red}'), wrap('.a{color:red}'))
  assert.equal(css('@\\69mport "https://x.example/a.css";.a{}'), wrap('.a{}'))
  assert.equal(css('/* x */@import/**/url(https://x.example/a.css);.a{}'), wrap('.a{}'))
  assert.equal(css('@import /* x */ "a.css";.a{}'), wrap('.a{}'))
})

test('<style>: a remote url() removes its whole declaration', () => {
  assert.equal(css('.a{color:red;background:url(https://t.example/p.png) no-repeat}'), wrap('.a{color:red;}'))
  assert.equal(css(".a{background:url('//t.example/p.png');color:red}"), wrap('.a{color:red}'))
  assert.equal(css('.a{background:URL(HTTPS://T.EXAMPLE/P.PNG)}'), wrap('.a{}'))
})

test('<style>: comments inside url() do not hide the scheme', () => {
  assert.equal(css('.a{background:url("https://t.example/p.png"/**/)}'), wrap('.a{}'))
  assert.equal(css('.a{background:url(/**/https://t.example/p.png)}'), wrap('.a{}'))
  assert.equal(css(".a{background:url( 'https://t.example/p.png' /* x */ )}"), wrap('.a{}'))
})

test('<style>: a comment splitting a function name does not form one', () => {
  // the browser reads `U RL(…)` here, not url(): nothing fetches, nothing removed
  assert.equal(css('.a{x:U/**/RL(y)}'), wrap('.a{x:U RL(y)}'))
})

test('<style>: escaped characters in the function name or the scheme are decoded first', () => {
  assert.equal(css('.a{background:url(\\68ttp://t.example/p.png)}'), wrap('.a{}'))
  assert.equal(css('.a{background:url("h\\74tp://t.example/p.png")}'), wrap('.a{}'))
  assert.equal(css('.a{background:U\\72L(https://t.example/p.png)}'), wrap('.a{}'))
  // an escape left in the argument (here `\:`) is ambiguous: removed
  assert.equal(css('.a{background:url(https\\://t.example/p.png)}'), wrap('.a{}'))
})

test('<style>: whitespace and newlines before the argument, and every quote form', () => {
  assert.equal(css('.a{background:url(\n  https://t.example/p.png\n)}'), wrap('.a{}'))
  assert.equal(css(".a{background:url('https://t.example/p.png')}"), wrap('.a{}'))
  assert.equal(css('.a{background:url("https://t.example/p.png")}'), wrap('.a{}'))
  assert.equal(css('.a{background:url(\n "../a.png" \n)}'), wrap('.a{background:url(\n "../a.png" \n)}'))
})

test('<style>: ambiguous url() arguments (stray quote, unbalanced parenthesis) are removed', () => {
  // unterminated string: the removal runs to the end, never leaves the URL behind
  assert.equal(css('.a{color:red;background:url("../a.png)}.b{color:blue}'), wrap('.a{color:red;'))
  assert.equal(css('.a{color:red;background:url(../a.png'), wrap('.a{color:red;'))
  assert.equal(css(".a{background:url(a'b.png)}.b{color:blue}"), wrap('.a{'))
})

test('<style>: image-set(), -webkit-image-set() and src() are always removed', () => {
  assert.equal(css('.a{background:image-set("a.png" 1x);color:red}'), wrap('.a{color:red}'))
  assert.equal(css('.a{background:-webkit-image-set(url(a.png) 1x)}'), wrap('.a{}'))
  assert.equal(css('.a{background:src("a.png")}'), wrap('.a{}'))
})

test('<style>: data: images/fonts, relative paths and fragments stay', () => {
  const kept =
    '@font-face{font-family:X;src:local("X"),url(data:font/woff2;base64,AAAA) format("woff2")}' +
    '.a{background:url("../assets/bg.png")}.b{fill:url(#grad)}.c{background:Url(Data:image/png;base64,AA)}' +
    ".d{background:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>')}"
  assert.equal(css(kept), wrap(kept))
  // a data: URI of another type is not an image or a font
  assert.equal(css('.a{background:url(data:text/html,x)}'), wrap('.a{}'))
})

test('<style>: an @font-face src list with one remote entry loses the whole src', () => {
  assert.equal(
    css('@font-face{font-family:X;src:local("X"),url(data:font/woff2;base64,AAAA) format("woff2"),url(https://f.example/x.woff2) format("woff2")}'),
    wrap('@font-face{font-family:X;}')
  )
})

test('<style>: conservative by construction, a URL that only looks like one inside a string is removed too', () => {
  assert.equal(css('.c{content:"url(https://t.example/x)"}'), wrap('.c{}'))
})

test('style attributes and SVG paint attributes lose remote url() targets', () => {
  assert.equal(
    sanitizeDsHtml('<div style="background-image:url(https://t.example/p.png);color:red">x</div>'),
    '<div style="color:red">x</div>'
  )
  assert.equal(sanitizeDsHtml('<div style="background:url(\'https://t.example/p.png\'/**/)">x</div>'), '<div>x</div>')
  assert.equal(
    sanitizeDsHtml('<svg><rect fill="url(https://t.example/s.svg#g)" stroke="url(#g)" mask="url(http://t.example/m)"></rect></svg>'),
    '<svg><rect fill="none" stroke="url(#g)" mask="none"></rect></svg>'
  )
  assert.equal(sanitizeDsHtml('<svg><rect fill="url(\'https://t.example/s.svg#g\'/**/)"></rect></svg>'), '<svg><rect fill="none"></rect></svg>')
})

test('<use> may only reference a fragment of the same document (href and xlink:href)', () => {
  assert.equal(sanitizeDsHtml('<svg><use href="https://t.example/s.svg#a"></use><use href="#a"></use></svg>'), '<svg><use></use><use href="#a"></use></svg>')
  assert.equal(sanitizeDsHtml('<svg><use xlink:href="sprite.svg#a"></use></svg>'), '<svg><use></use></svg>')
  assert.equal(sanitizeDsHtml('<svg><use xlink:href="//t.example/s.svg#a"></use><use href="  https://t.example/s.svg#a"></use></svg>'), '<svg><use></use><use></use></svg>')
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

test('<style>: many offending declarations are each dropped with bounded work', () => {
  const body = Array.from({ length: 2000 }, (_, i) => `.a${i}{background:url(https://t.example/${i}.png);color:red}`).join('')
  assert.ok(cssScanWork(body) <= 8 * body.length, 'more than 8 reads per character')
  const out = css(body)
  assert.doesNotMatch(out, /url\(/)
  assert.match(out, /^<style>\.a0\{color:red\}\.a1\{color:red\}/)
})

test('<style>: comment-like text inside a string literal is kept; comments outside strings go', () => {
  assert.equal(css('.a{content:"/* not a comment */";color:red}'), wrap('.a{content:"/* not a comment */";color:red}'))
  assert.equal(css(".a{content:'a/*b';color:red}"), wrap(".a{content:'a/*b';color:red}"))
  assert.equal(css('.a{content:"a"/* real */;color:red}'), wrap('.a{content:"a" ;color:red}'))
  // a comment is a token boundary, so it becomes one space, not nothing
  assert.equal(css('.a{color:red/**/!important}'), wrap('.a{color:red !important}'))
})

// Malformed input must not make the CSS pass quadratic: a stored card can be up
// to 2.6 MB and is sanitized while templates are listed. Linearity is asserted
// on WORK, not wall time: cssScanWork counts every character the pass reads,
// look-ahead included (see newMeter in sanitizeDsHtml.ts), so the numbers are
// the same on every machine and under any load. The guard test below keeps
// builtin scans from slipping past the meter. A wall-clock ceiling stays only
// as a backstop for gross regressions; it sits more than 10x above the slowest
// 2 MB run seen with every CPU core busy. Each case runs in a child process
// with a hard timeout, so a quadratic regression fails instead of hanging.
const SANITIZER = new URL('./sanitizeDsHtml.ts', import.meta.url).href
const MALFORMED = {
  'many @import, no semicolon': '@import "a.css" ',
  'many url( without )': '.a{background:url(',
  'repeated /* without */': '/* ',
  'long runs of backslashes': '\\\\\\\\\\\\\\\\.a{x:url(\\\\',
  'many unterminated url(" strings': '.a{background:url("x ',
  'many remote url() declarations': '.a{background:url(https://t.example/p.png);color:red}',
  'many image-set() inside strings': '.a{content:"image-set(a)";b:c}',
  'many local url() declarations (kept)': '.a{background:url(../a.png);fill:url(#g)}',
}
const SMALL = 512 * 1024
const LARGE = 4 * SMALL // 2 MB
// linear: 4x the input reads 4x the characters; quadratic would read 16x
const MAX_GROWTH = 5
// characters read per input character (all cases measure 1.0-3.5 today)
const MAX_READS_PER_CHAR = 8
const WALL_CEILING_MS = 5000

function measureCase(unit: string) {
  const code = `
    const { cssScanWork } = await import(${JSON.stringify(SANITIZER)})
    const unit = ${JSON.stringify(unit)}
    const make = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
    const small = make(${SMALL}), large = make(${LARGE})
    cssScanWork(make(64 * 1024)) // warm-up
    const readsSmall = cssScanWork(small)
    // the timed run is the 2 MB measurement itself (same code path as stripRemoteCssUrls)
    const t0 = performance.now()
    const readsLarge = cssScanWork(large)
    process.stdout.write(JSON.stringify({ readsSmall, readsLarge, ms: performance.now() - t0 }))
  `
  // spawnSync blocks this process, so the child's own timeout is what bounds a
  // stuck case; it stays well under --test-timeout for the whole file
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 8000, encoding: 'utf8' })
  assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, undefined, `timed out or failed to run: ${(r.error as NodeJS.ErrnoException | undefined)?.code}`)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

// The read meter only sees what reports to it. A JS loop in the pass is metered
// by convention; a string or regex BUILTIN that scans (indexOf, includes, a
// regex…) is where a quadratic can hide unmetered (V8 runs those at memchr
// speed, so a rescan per match still looks fast at 2 MB). This pins the
// builtin calls of the CSS pass: each one below is metered or reads a bounded
// amount. A new one fails here until its reads are added to the meter.
const CSS_PASS_BUILTINS = { exec: 1, indexOf: 1, join: 1, slice: 6, startsWith: 1, test: 4, toLowerCase: 2 }
const SCANNING_BUILTINS =
  /\.(indexOf|lastIndexOf|includes|search|match|matchAll|split|replace|replaceAll|exec|test|slice|substring|substr|toLowerCase|toUpperCase|join|startsWith|endsWith|repeat|trim|trimStart|trimEnd|padStart|padEnd|normalize|localeCompare|find|findIndex|findLast|findLastIndex|filter|map|some|every|reduce|forEach|flat|flatMap|concat)\(/g

test('<style>: every scanning builtin in the CSS pass is accounted for in the read meter', () => {
  const src = readFileSync(new URL('./sanitizeDsHtml.ts', import.meta.url), 'utf8')
  const start = src.indexOf('// ---- CSS resource URLs')
  const end = src.indexOf('function cleanAttribs')
  assert.ok(start >= 0 && end > start, 'CSS pass section not found in sanitizeDsHtml.ts')
  const found: Record<string, number> = {}
  for (const m of src.slice(start, end).matchAll(SCANNING_BUILTINS)) found[m[1]!] = (found[m[1]!] || 0) + 1
  assert.deepEqual(
    found,
    CSS_PASS_BUILTINS,
    'the CSS pass gained or lost a scanning builtin call: count the characters it reads in the meter (newMeter in sanitizeDsHtml.ts), then update CSS_PASS_BUILTINS'
  )
})

for (const [name, unit] of Object.entries(MALFORMED)) {
  test(`<style>: linear on ~2 MB of malformed CSS (${name})`, () => {
    const { readsSmall, readsLarge, ms } = measureCase(unit)
    assert.ok(
      readsLarge <= MAX_READS_PER_CHAR * LARGE,
      `${readsLarge} reads for ${LARGE} chars (> ${MAX_READS_PER_CHAR} per char)`
    )
    assert.ok(
      readsLarge <= MAX_GROWTH * readsSmall,
      `4x the input read ${(readsLarge / readsSmall).toFixed(2)}x the characters (${readsSmall} -> ${readsLarge})`
    )
    assert.ok(ms < WALL_CEILING_MS, `2 MB took ${ms.toFixed(0)} ms`)
  })
}
