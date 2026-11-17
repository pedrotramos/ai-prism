// Makes design-system HTML inert before it is sent to a browser as a thumbnail
// (extractFirstTemplateSlide in server/db.js). A design system comes from outside
// the app (agency bundle, Figma export, zip), and a global one is shown to every
// user, so any script in it would run in their browsers.
//
// Second layer only: the thumbnail iframe is always sandboxed (no scripts) in
// client/src/components/DeckTemplatesSettings.jsx. The parsing and serialization
// are done by sanitize-html (htmlparser2), a maintained library: browsers and
// sanitizers disagree on edge cases of HTML parsing (raw-text elements, svg/math
// foreign content), and a hand-written tokenizer is the wrong place to track
// them. This file only holds the allowlist, sized for slide HTML:
//  - structure, text, lists, tables, images, inline <svg> drawing and <style>
//    blocks (a slide's layout and type live in them);
//  - no script, event handler, iframe/object/embed, base, meta, form or
//    foreignObject;
//  - URLs: http, https, mailto and relative everywhere; data: only for <img>,
//    and only data:image/*; <use> only references a #fragment;
//  - CSS (<style> blocks, style attributes, SVG paint attributes) cannot fetch
//    from another host (stripRemoteCssUrls, below). Not a script defense (the
//    sandbox is), a privacy one: a stored global DS could otherwise make every
//    viewer's browser call a third party.

import sanitizeHtml from 'sanitize-html'

// htmlparser2 reports SVG element names with the spec's camelCase
// (linearGradient), attribute names in lower case (the browser re-cases them)
const SVG_TAGS = [
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath',
  'mask', 'pattern', 'symbol', 'use', 'marker', 'title', 'desc',
]

const ALLOWED_TAGS = [
  'html', 'head', 'body', 'style',
  'section', 'header', 'footer', 'main', 'article', 'aside', 'figure', 'figcaption',
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'mark', 'br', 'hr', 'a',
  'ul', 'ol', 'li',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img',
  ...SVG_TAGS,
]

// presentation attributes only: none of these can carry a script or a URL
const SVG_ATTRS = [
  'xmlns', 'xmlns:xlink', 'viewbox', 'preserveaspectratio', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'dx', 'dy', 'points', 'transform', 'opacity',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'clip-path',
  'clip-rule', 'mask', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'patternunits', 'patterntransform', 'clippathunits', 'markerwidth',
  'markerheight', 'refx', 'refy', 'orient', 'visibility', 'display', 'vector-effect', 'textlength',
]

const OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  // <style> is in sanitize-html's "vulnerable" list because its CSS is emitted
  // as is; it is needed for slide fidelity, the frame is sandboxed, and the
  // library still escapes `<` in a <style> under svg/math.
  allowVulnerableTags: true,
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-*', 'data-*', 'width', 'height', 'align', 'valign', ...SVG_ATTRS],
    a: ['href'],
    img: ['src', 'alt', 'loading'],
    use: ['href', 'xlink:href'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'type'],
    col: ['span'],
    colgroup: ['span'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'xlink:href'],
  allowProtocolRelative: false,
  // keep a style attribute as written (no CSS re-serialization)
  parseStyleAttributes: false,
  // '*' runs for every tag (sanitize-html uses it when no tag-specific entry exists)
  transformTags: { '*': (tagName, attribs) => ({ tagName, attribs: cleanAttribs(tagName, attribs) }) },
}

// ---- CSS resource URLs -------------------------------------------------------
//
// Conservative by construction, not a CSS tokenizer:
//  1. normalize: drop every /* … */ comment (an unterminated one runs to the
//     end; strings are not special-cased, which can only remove more), drop
//     NUL, and decode the escapes that spell an ASCII letter or `-` (\68, \74 ,
//     \l…), so an escaped `url`, `import` or scheme reads plainly. Any other
//     escape (\:, \32, \3c …) is left as written, so escaped selectors keep
//     their meaning;
//  2. the normalized text is what is checked AND what is emitted, so the
//     check cannot disagree with what the browser receives;
//  3. a url(…) is kept only when its argument is exactly one quoted string or
//     one unquoted token (no backslash, quote, parenthesis or whitespace
//     inside) whose value is a data: image/font URI, a relative path or a
//     #fragment;
//  4. anything else removes the whole declaration: the span between a `;`, `{`
//     or `}` before it and a `;` or `}` after it in which quotes and
//     parentheses balance (statementSpan); with no such span, everything from
//     the nearest boundary to the end: a remote url(), an ambiguous argument, and always
//     image-set(), -webkit-image-set(), image(), cross-fade(), element() and
//     src(). @import is always removed (to its `;`, same balancing).
// Matching is case-insensitive and finds the names anywhere (inside strings
// too), so it can only over-remove.

const CSS_URL_ATTRS = ['style', 'fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']
const FETCH_FN = /(?<![A-Za-z0-9_-])(-webkit-image-set|image-set|-webkit-cross-fade|cross-fade|image|element|url|src)\s*\(/gi
// no boundary check: `@import/**/url(` normalizes to `@importurl(`
const AT_IMPORT = /@import/gi
const ESCAPE = /\\([0-9a-fA-F]{1,6})(\r\n|[ \t\n\r\f])?|\\([^\n\r\f0-9a-fA-F])/g
const LOCAL_DATA = /^data:(?:image\/|font\/|application\/(?:x-)?font)/i

function normalizeCss(css) {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\0/g, '')
    .replace(ESCAPE, (m, hex, _ws, ch) => {
      const c = hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : ch
      return /^[A-Za-z-]$/.test(c) ? c : m
    })
}

function localUrlValue(v) {
  if (v === '' || v.startsWith('#') || LOCAL_DATA.test(v)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false // any other scheme
  return !/^[\\/]{2}/.test(v) // protocol-relative (`//host`, `/\host`)
}

// the url( argument starting at t[open]: { close } when it is exactly one local
// value, null when it is remote or ambiguous
function localUrlArg(t, open) {
  let k = open
  while (/\s/.test(t[k] || '')) k++
  let value
  if (t[k] === '"' || t[k] === "'") {
    const end = t.indexOf(t[k], k + 1)
    if (end < 0) return null
    value = t.slice(k + 1, end)
    if (/[\\\n\r\f]/.test(value)) return null
    k = end + 1
    while (/\s/.test(t[k] || '')) k++
    if (t[k] !== ')') return null
  } else {
    const end = t.indexOf(')', k)
    if (end < 0) return null
    value = t.slice(k, end).replace(/\s+$/, '')
    if (/["'()\\\s]/.test(value)) return null
    k = end
  }
  return localUrlValue(value) ? { close: k } : null
}

// prefix counts of ", ', ( and ) so "does t[a, b) balance?" is O(1)
function balancer(t) {
  const n = t.length
  const dq = new Uint32Array(n + 1), sq = new Uint32Array(n + 1), op = new Uint32Array(n + 1), cp = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const c = t[i]
    dq[i + 1] = dq[i] + (c === '"')
    sq[i + 1] = sq[i] + (c === "'")
    op[i + 1] = op[i] + (c === '(')
    cp[i + 1] = cp[i] + (c === ')')
  }
  return (a, b) => (dq[b] - dq[a]) % 2 === 0 && (sq[b] - sq[a]) % 2 === 0 && op[b] - op[a] === cp[b] - cp[a]
}

// The statement to drop around t[at]: [start, cut). Boundaries are `;`, `{` and
// `}`; the span must contain t[at] and balance its quotes and parentheses (a
// `;` inside data:…;base64 or inside a string is not a boundary). The nearest
// candidate starts are tried first (at most 64); with none balancing, the
// removal runs from the nearest boundary to the end of the text (fail closed).
// A `;` end is removed with the statement, a `}` end is kept.
const MAX_STARTS = 64
function statementSpan(t, at, stops, balanced) {
  const starts = []
  for (let j = at - 1; j >= 0 && starts.length < MAX_STARTS; j--) if (';{}'.includes(t[j])) starts.push(j + 1)
  if (starts.length < MAX_STARTS) starts.push(0)
  for (const st of starts) {
    for (let j = at; j < t.length; j++) {
      if ((t[j] === ';' || t[j] === '}') && stops.includes(t[j]) && balanced(st, j)) return [st, t[j] === ';' ? j + 1 : j]
    }
  }
  return [starts[0], t.length]
}

export function stripRemoteCssUrls(input) {
  if (typeof input !== 'string' || !input) return input
  let t = normalizeCss(input)
  // Each pass finds every offending statement in the current text, cuts them
  // all, and repeats on the result (a cut can join text into a new match).
  // Every pass with a cut removes at least one character, so this terminates.
  for (;;) {
    const balanced = balancer(t)
    const cuts = []
    for (const m of t.matchAll(AT_IMPORT)) {
      // the at-rule itself: from `@import` to its `;` (balanced), else to the end
      let cut = t.length
      for (let j = m.index; j < t.length; j++) {
        if (t[j] === ';' && balanced(m.index, j)) {
          cut = j + 1
          break
        }
      }
      cuts.push([m.index, cut])
    }
    FETCH_FN.lastIndex = 0
    for (let m; (m = FETCH_FN.exec(t)); ) {
      const ok = m[1].toLowerCase() === 'url' && localUrlArg(t, m.index + m[0].length)
      if (ok) {
        FETCH_FN.lastIndex = ok.close + 1
        continue
      }
      const span = statementSpan(t, m.index, ';}', balanced)
      cuts.push(span)
      FETCH_FN.lastIndex = Math.max(span[1], m.index + 1)
    }
    if (!cuts.length) return t
    cuts.sort((x, y) => x[0] - y[0])
    let out = ''
    let pos = 0
    for (const [st, end] of cuts) {
      if (st > pos) out += t.slice(pos, st)
      pos = Math.max(pos, end)
    }
    t = out + t.slice(pos)
  }
}

function cleanAttribs(tagName, attribs) {
  const a = { ...attribs }
  for (const k of CSS_URL_ATTRS) {
    if (typeof a[k] !== 'string') continue
    const clean = stripRemoteCssUrls(a[k])
    if (k !== 'style') {
      // a paint attribute is one value: anything removed means no paint
      if (clean !== a[k]) a[k] = 'none'
    } else if (clean.trim()) a[k] = clean
    else delete a[k]
  }
  // data: is allowed on <img> only as an image; anything else loses its src
  if (tagName === 'img') {
    const src = String(a.src || '').trim()
    if (/^data:/i.test(src) && !/^data:image\//i.test(src)) delete a.src
  }
  // <use> may only point inside this document (no external sprite fetch)
  if (tagName === 'use') {
    for (const k of ['href', 'xlink:href']) if (k in a && !String(a[k]).trim().startsWith('#')) delete a[k]
  }
  return a
}

const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi

export function sanitizeDsHtml(html) {
  if (typeof html !== 'string' || !html) return ''
  // the serialized output escapes `>` in attribute values, so a <style> block
  // there is exactly `<style …>css</style>`
  const out = sanitizeHtml(html, OPTIONS).replace(STYLE_BLOCK, (_, open, css, close) => open + stripRemoteCssUrls(css) + close)
  // sanitize-html drops the doctype; without it the srcdoc renders in quirks mode
  return /^\s*<!doctype html/i.test(html) ? `<!doctype html>${out}` : out
}
