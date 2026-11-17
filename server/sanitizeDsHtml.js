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
//    from another host: @import rules are removed and url()/image-set()/…
//    targets other than data:, a relative path or a #fragment become `none`
//    (stripRemoteCssUrls). Not a script defense (the sandbox is), a privacy
//    one: a stored global DS could otherwise make every viewer's browser call
//    a third party.

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

// functions whose argument is fetched as a URL, and image functions that take
// URL strings directly (image-set("a.png" 1x))
const URL_FUNCS = new Set(['url', 'src'])
const IMAGE_FUNCS = new Set(['image-set', '-webkit-image-set', 'image', 'cross-fade', '-webkit-cross-fade', 'element'])
const CSS_URL_ATTRS = ['style', 'fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']

// a URL the frame may load: empty, a #fragment, data:, or a relative path
// (no scheme, not protocol-relative; `/\host` counts as protocol-relative)
function localUrl(raw) {
  const t = raw.replace(/[\t\n\r\f]/g, '').trim()
  if (!t || t.startsWith('#') || /^data:/i.test(t)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false
  return !/^[\\/]{2}/.test(t)
}

const isIdentChar = (c) => /[A-Za-z0-9_-]/.test(c) || c > '\x7f' || c === '\\'

// reads a CSS identifier at css[i] (escapes decoded) -> { raw, name, end }
function readIdent(css, i) {
  let name = ''
  let j = i
  while (j < css.length && isIdentChar(css[j])) {
    if (css[j] === '\\') {
      const hex = /^[0-9a-fA-F]{1,6}[ \t\n\r\f]?/.exec(css.slice(j + 1, j + 8))
      if (hex) {
        name += String.fromCodePoint(Math.min(parseInt(hex[0], 16) || 0xfffd, 0x10ffff))
        j += 1 + hex[0].length
      } else {
        name += css[j + 1] || ''
        j += 2
      }
    } else {
      name += css[j++]
    }
  }
  return { raw: css.slice(i, j), name: name.toLowerCase(), end: j }
}

// end index (exclusive) of the string starting at css[i]
function stringEnd(css, i) {
  const q = css[i]
  let j = i + 1
  while (j < css.length && css[j] !== q && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1
  return Math.min(j + 1, css.length)
}

// index of the `)` closing the group opened just before `i`, or -1
function closeParen(css, i) {
  let depth = 1
  for (let j = i; j < css.length; j++) {
    const c = css[j]
    if (c === '"' || c === "'") j = stringEnd(css, j) - 1
    else if (c === '\\') j++
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return -1
}

const unquote = (s) => {
  const t = s.trim()
  const inner = /^(["']).*\1$/s.test(t) ? t.slice(1, -1) : t
  return inner.replace(/\\([0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^0-9a-fA-F\n])/g, (_, e) =>
    /^[0-9a-fA-F]/.test(e) ? String.fromCodePoint(Math.min(parseInt(e, 16) || 0xfffd, 0x10ffff)) : e
  )
}

// every string literal inside an image function must be a local URL too
function stringsLocal(arg) {
  for (let j = 0; j < arg.length; j++) {
    if (arg[j] === '"' || arg[j] === "'") {
      const e = stringEnd(arg, j)
      if (!localUrl(unquote(arg.slice(j, e)))) return false
      j = e - 1
    }
  }
  return true
}

export function stripRemoteCssUrls(css) {
  if (typeof css !== 'string' || !css) return css
  let out = ''
  let i = 0
  const n = css.length
  while (i < n) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      out += css.slice(i, stop)
      i = stop
    } else if (c === '"' || c === "'") {
      const e = stringEnd(css, i)
      out += css.slice(i, e)
      i = e
    } else if (c === '@' && i + 1 < n && isIdentChar(css[i + 1])) {
      const id = readIdent(css, i + 1)
      if (id.name !== 'import') {
        out += '@' + id.raw
        i = id.end
        continue
      }
      // drop the whole @import statement: up to `;` outside strings/parens
      let j = id.end
      while (j < n && css[j] !== ';') {
        if (css[j] === '"' || css[j] === "'") j = stringEnd(css, j)
        else if (css[j] === '(') j = closeParen(css, j + 1) < 0 ? n : closeParen(css, j + 1) + 1
        else j++
      }
      i = j + 1
    } else if (isIdentChar(c) && !/[0-9]/.test(c)) {
      const id = readIdent(css, i)
      if (css[id.end] !== '(') {
        out += id.raw
        i = id.end
        continue
      }
      const close = closeParen(css, id.end + 1)
      if (close < 0) {
        out += 'none'
        break
      }
      const arg = css.slice(id.end + 1, close)
      if (URL_FUNCS.has(id.name)) out += localUrl(unquote(arg)) ? css.slice(i, close + 1) : 'none'
      else if (IMAGE_FUNCS.has(id.name)) {
        const inner = stripRemoteCssUrls(arg)
        out += inner === arg && stringsLocal(arg) ? css.slice(i, close + 1) : 'none'
      } else out += id.raw + '(' + stripRemoteCssUrls(arg) + ')'
      i = close + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

function cleanAttribs(tagName, attribs) {
  const a = { ...attribs }
  for (const k of CSS_URL_ATTRS) if (typeof a[k] === 'string') a[k] = stripRemoteCssUrls(a[k])
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
