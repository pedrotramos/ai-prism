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
// Conservative by construction, in two linear passes (the index never moves
// backwards, nothing is rescanned):
//  1. normalize: replace /* … */ comments OUTSIDE strings with one space (inside a string they
//     are text; an unterminated comment drops the rest), drop NUL, and decode
//     the escapes that spell an ASCII letter or `-` (\68, \74 , \l…) so an
//     escaped `url`, `import` or scheme reads plainly. Any other escape (\:,
//     \32, \3c …) is kept as written, so escaped selectors keep their meaning;
//  2. scan the normalized text once, tracking strings and parenthesis depth.
//     Top-level `;`, `{` and `}` (outside strings and parentheses) are the
//     statement boundaries. A url(…) is kept only when its argument is exactly
//     one quoted string or one unquoted token (no backslash, quote,
//     parenthesis or inner whitespace) whose value is a data: image/font URI,
//     a relative path or a #fragment. Anything else — a remote or ambiguous
//     url(), and always @import, image-set(), -webkit-image-set(), image(),
//     cross-fade(), -webkit-cross-fade(), element() and src() — drops the
//     statement it is in: the output rolls back to the last top-level
//     boundary and the input is skipped once, up to the next top-level `;`
//     (dropped) or the `}` closing the enclosing block (kept); a `{` opened
//     while skipping is skipped with its whole block. No boundary ahead (an
//     unclosed parenthesis or string, say) drops the rest of the text.
// The normalized text is both what is checked and what is emitted. Names are
// matched case-insensitively and inside strings too, so this can only remove
// more than needed (e.g. `content:"url(https://…)"`).

const CSS_URL_ATTRS = ['style', 'fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']
const FETCH_NAMES = new Set(['url', 'src', 'image', 'image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade', 'element'])
const ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(\r\n|[ \t\n\r\f])?|([^\n\r\f0-9a-fA-F]))/y
const LOCAL_DATA = /^data:(?:image\/|font\/|application\/(?:x-)?font)/i
const isIdent = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_'
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'

// pass 1
function normalizeCss(css) {
  let out = ''
  let quote = null
  const n = css.length
  for (let i = 0; i < n; ) {
    const c = css[i]
    if (c === '\0') {
      i++
    } else if (c === '\\') {
      ESCAPE.lastIndex = i
      const m = ESCAPE.exec(css)
      if (!m) {
        // backslash + newline (a line continuation inside a string) or at the end
        out += css.slice(i, i + 2)
        i += 2
        continue
      }
      const ch = m[1] ? String.fromCodePoint(Math.min(parseInt(m[1], 16) || 0xfffd, 0x10ffff)) : m[3]
      out += /^[A-Za-z-]$/.test(ch) ? ch : m[0]
      i += m[0].length
    } else if (quote) {
      if (c === quote || c === '\n') quote = null // a newline ends a bad string
      out += c
      i++
    } else if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end < 0) break
      // a comment separates tokens (`U/**/RL(` is not `URL(`): keep one space
      out += ' '
      i = end + 2
    } else {
      out += c
      i++
    }
  }
  return out
}

function localUrlValue(v) {
  if (v === '' || v.startsWith('#') || LOCAL_DATA.test(v)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false // any other scheme
  return !/^[\\/]{2}/.test(v) // protocol-relative (`//host`, `/\host`)
}

// The url( argument at t[open]: the index of its `)` when it is exactly one
// local value, -1 otherwise. Stops at the first character that settles it, so
// the cost is bounded by the argument itself.
function localUrlArg(t, open) {
  const n = t.length
  let k = open
  while (k < n && isWs(t[k])) k++
  let start = k
  let end
  if (t[k] === '"' || t[k] === "'") {
    const q = t[k]
    start = ++k
    while (k < n && t[k] !== q) {
      if (t[k] === '\\' || t[k] === '\n' || t[k] === '\r' || t[k] === '\f') return -1
      k++
    }
    if (k >= n) return -1
    end = k++
    while (k < n && isWs(t[k])) k++
  } else {
    while (k < n && t[k] !== ')' && !isWs(t[k])) {
      if (t[k] === '"' || t[k] === "'" || t[k] === '(' || t[k] === '\\') return -1
      k++
    }
    end = k
    while (k < n && isWs(t[k])) k++
  }
  if (t[k] !== ')') return -1
  return localUrlValue(t.slice(start, end)) ? k : -1
}

// pass 2
export function stripRemoteCssUrls(input) {
  if (typeof input !== 'string' || !input) return input
  const t = normalizeCss(input)
  const n = t.length
  // output pieces; a rollback truncates the array (no string copy), so the
  // whole pass stays linear however many statements are dropped
  const out = []
  let stmt = 0 // out.length right after the last top-level boundary
  let quote = null
  let depth = 0 // parentheses
  let skip = false
  let skipBraces = 0 // blocks opened while skipping
  for (let i = 0; i < n; ) {
    const c = t[i]
    // strings and escapes: same tracking in both modes
    if (c === '\\') {
      if (!skip) out.push(t.slice(i, i + 2))
      i += 2
      continue
    }
    if (quote) {
      if (c === quote || c === '\n') quote = null
      else if (!skip && (c === 'u' || c === 'U' || c === 's' || c === 'S' || c === 'i' || c === 'I' || c === 'c' || c === 'C' || c === 'e' || c === 'E' || c === '-') && !isIdent(t[i - 1] || '')) {
        // names inside strings are checked too (conservative)
        const r = checkName(t, i)
        if (r === 'bad') {
          out.length = stmt
          skip = true
          continue
        }
      }
      if (!skip) out.push(c)
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      if (!skip) out.push(c)
      i++
      continue
    }
    if (skip) {
      if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (depth === 0 && c === '{') skipBraces++
      else if (depth === 0 && c === '}') {
        if (skipBraces > 0) {
          if (--skipBraces === 0) {
            skip = false
            stmt = out.length
          }
        } else {
          skip = false
          out.push(c)
          stmt = out.length
        }
      } else if (depth === 0 && skipBraces === 0 && c === ';') {
        skip = false
        stmt = out.length
      }
      i++
      continue
    }
    if (c === '(') {
      depth++
    } else if (c === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      out.push(c)
      stmt = out.length
      i++
      continue
    } else if (c === '@' && t.slice(i + 1, i + 7).toLowerCase() === 'import') {
      out.length = stmt
      skip = true
      i++
      continue
    } else if ((isIdent(c) || c === '-') && !isIdent(t[i - 1] || '')) {
      const r = checkName(t, i)
      if (r === 'bad') {
        out.length = stmt
        skip = true
        continue
      }
      if (r !== null) {
        // a local url(…): emit it whole, its inside needs no tracking
        out.push(t.slice(i, r + 1))
        i = r + 1
        continue
      }
    }
    out.push(c)
    i++
  }
  return out.join('')
}

// At an identifier start: 'bad' for a fetching function that is not a local
// url(…), the index of the closing `)` of a local url(…), null otherwise.
function checkName(t, i) {
  let j = i
  while (j < t.length && isIdent(t[j]) && j - i < 20) j++
  if (j - i >= 20 && isIdent(t[j] || '')) return null // longer than any fetching name
  const name = t.slice(i, j).toLowerCase()
  if (!FETCH_NAMES.has(name)) return null
  let k = j
  while (k < t.length && isWs(t[k])) k++
  if (t[k] !== '(') return null
  if (name !== 'url') return 'bad'
  const close = localUrlArg(t, k + 1)
  return close < 0 ? 'bad' : close
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
