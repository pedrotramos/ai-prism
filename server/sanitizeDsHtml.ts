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
import { classifyImageSrc, EMPTY_EGRESS_POLICY, externalUrlHosts } from '../shared/urlEgressPolicy.ts'
import { logEgress } from './egressLog.ts'

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

const OPTIONS: Parameters<typeof sanitizeHtml>[1] = {
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
  transformTags: { '*': (tagName: string, attribs: Attribs) => ({ tagName, attribs: cleanAttribs(tagName, attribs) }) },
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
const isIdent = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_'
const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'

// Work meter. Every scan below adds the characters it READS to `meter.reads`,
// including look-ahead it does not consume (the `*/` search, the url( argument
// probe, the name and whitespace probes, copies of a kept url(…)). The index of
// each pass only moves forward, so a linear pass reads O(input) characters in
// total; a look-ahead that rescans the rest of the input per match (the bug
// fixed in #58) shows up as O(input²) reads. The meter runs on every call, so
// what the tests measure (cssScanWork) is the production path.
interface Meter {
  reads: number
}
type Attribs = Record<string, string>
const newMeter = (): Meter => ({ reads: 0 })

// pass 1
function normalizeCss(css: string, meter: Meter): string {
  let out = ''
  let quote: string | null = null
  let reads = 0
  const n = css.length
  for (let i = 0; i < n; ) {
    const c = css[i]!
    if (c === '\0') {
      reads++
      i++
    } else if (c === '\\') {
      ESCAPE.lastIndex = i
      const m = ESCAPE.exec(css)
      if (!m) {
        // backslash + newline (a line continuation inside a string) or at the end
        reads += 2
        out += css.slice(i, i + 2)
        i += 2
        continue
      }
      // the sticky regex reads the match plus at most one character after it
      reads += m[0].length + 1
      const ch = m[1] ? String.fromCodePoint(Math.min(parseInt(m[1], 16) || 0xfffd, 0x10ffff)) : m[3]!
      out += /^[A-Za-z-]$/.test(ch) ? ch : m[0]
      i += m[0].length
    } else if (quote) {
      if (c === quote || c === '\n') quote = null // a newline ends a bad string
      reads++
      out += c
      i++
    } else if (c === '"' || c === "'") {
      quote = c
      reads++
      out += c
      i++
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      // indexOf reads up to the match, or to the end of the input
      reads += (end < 0 ? n : end + 2) - i
      if (end < 0) break
      // a comment separates tokens (`U/**/RL(` is not `URL(`): keep one space
      out += ' '
      i = end + 2
    } else {
      reads++
      out += c
      i++
    }
  }
  meter.reads += reads
  return out
}

function localUrlValue(v: string): boolean {
  if (v === '' || v.startsWith('#') || LOCAL_DATA.test(v)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false // any other scheme
  return !/^[\\/]{2}/.test(v) // protocol-relative (`//host`, `/\host`)
}

// The url( argument at t[open]: the index of its `)` when it is exactly one
// local value, -1 otherwise. Stops at the first character that settles it, so
// the cost is bounded by the argument itself.
function localUrlArg(t: string, open: number, meter: Meter): number {
  const n = t.length
  let k = open
  // reads are counted once the probe settles (every return below)
  const read = (r: number): number => ((meter.reads += Math.min(k, n - 1) - open + 1), r)
  while (k < n && isWs(t[k])) k++
  let start = k
  let end
  if (t[k] === '"' || t[k] === "'") {
    const q = t[k]
    start = ++k
    while (k < n && t[k] !== q) {
      if (t[k] === '\\' || t[k] === '\n' || t[k] === '\r' || t[k] === '\f') return read(-1)
      k++
    }
    if (k >= n) return read(-1)
    end = k++
    while (k < n && isWs(t[k])) k++
  } else {
    while (k < n && t[k] !== ')' && !isWs(t[k])) {
      if (t[k] === '"' || t[k] === "'" || t[k] === '(' || t[k] === '\\') return read(-1)
      k++
    }
    end = k
    while (k < n && isWs(t[k])) k++
  }
  if (t[k] !== ')') return read(-1)
  // the value is read again by the slice and the scheme checks
  meter.reads += end - start
  return read(localUrlValue(t.slice(start, end)) ? k : -1)
}

// pass 2
export function stripRemoteCssUrls(input: string): string {
  return scanCss(input, newMeter())
}

// For tests: the characters the CSS pass reads for `input` (see newMeter).
export function cssScanWork(input: string): number {
  const meter = newMeter()
  scanCss(input, meter)
  return meter.reads
}

function scanCss(input: string, meter: Meter): string {
  if (typeof input !== 'string' || !input) return input
  const t = normalizeCss(input, meter)
  const n = t.length
  let reads = 0
  // output pieces; a rollback truncates the array (no string copy), so the
  // whole pass stays linear however many statements are dropped
  const out: string[] = []
  let stmt = 0 // out.length right after the last top-level boundary
  let quote: string | null = null
  let depth = 0 // parentheses
  let skip = false
  let skipBraces = 0 // blocks opened while skipping
  for (let i = 0; i < n; ) {
    const c = t[i]!
    reads++
    // strings and escapes: same tracking in both modes
    if (c === '\\') {
      reads++
      if (!skip) out.push(t.slice(i, i + 2))
      i += 2
      continue
    }
    if (quote) {
      if (c === quote || c === '\n') quote = null
      else if (!skip && (c === 'u' || c === 'U' || c === 's' || c === 'S' || c === 'i' || c === 'I' || c === 'c' || c === 'C' || c === 'e' || c === 'E' || c === '-') && !isIdent(t[i - 1] || '')) {
        // names inside strings are checked too (conservative)
        const r = checkName(t, i, meter)
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
    } else if (c === '@' && ((reads += 6), t.slice(i + 1, i + 7).toLowerCase() === 'import')) {
      out.length = stmt
      skip = true
      i++
      continue
    } else if ((isIdent(c) || c === '-') && !isIdent(t[i - 1] || '')) {
      const r = checkName(t, i, meter)
      if (r === 'bad') {
        out.length = stmt
        skip = true
        continue
      }
      if (r !== null) {
        // a local url(…): emit it whole, its inside needs no tracking
        reads += r + 1 - i
        out.push(t.slice(i, r + 1))
        i = r + 1
        continue
      }
    }
    out.push(c)
    i++
  }
  meter.reads += reads
  return out.join('')
}

// At an identifier start: 'bad' for a fetching function that is not a local
// url(…), the index of the closing `)` of a local url(…), null otherwise.
function checkName(t: string, i: number, meter: Meter): 'bad' | number | null {
  let j = i
  while (j < t.length && isIdent(t[j]!) && j - i < 20) j++
  meter.reads += j - i + 1
  if (j - i >= 20 && isIdent(t[j] || '')) return null // longer than any fetching name
  const name = t.slice(i, j).toLowerCase()
  if (!FETCH_NAMES.has(name)) return null
  let k = j
  while (k < t.length && isWs(t[k])) k++
  meter.reads += k - j + 1
  if (t[k] !== '(') return null
  if (name !== 'url') return 'bad'
  const close = localUrlArg(t, k + 1, meter)
  return close < 0 ? 'bad' : close
}

function cleanAttribs(tagName: string, attribs: Attribs): Attribs {
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

export function sanitizeDsHtml(html: unknown): string {
  if (typeof html !== 'string' || !html) return ''
  // the serialized output escapes `>` in attribute values, so a <style> block
  // there is exactly `<style …>css</style>`
  const out = sanitizeHtml(html, OPTIONS).replace(STYLE_BLOCK, (_: string, open: string, css: string, close: string) => open + stripRemoteCssUrls(css) + close)
  // sanitize-html drops the doctype; without it the srcdoc renders in quirks mode
  return /^\s*<!doctype html/i.test(html) ? `<!doctype html>${out}` : out
}

// ---- deck slide HTML (sanitizeHtmlDeck, server/blocks.ts) -----------------------------------------------------------
//
// A slide is model-written (or tool-influenced) markup that the app renders in a sandboxed frame. The frame cannot run
// script, but an image, a stylesheet or a CSS url() still makes the browser call a host the page names, with whatever
// the model put in the URL: a no-click leak. So the slide is cleaned when it is written AND when it is read (old rows).
//
// Unlike the DS thumbnail above this is a blocklist: slides use a wide vocabulary (inline SVG, filters, tables, custom
// elements) and an allowlist would change how decks look. What is removed:
//  - elements: script, iframe, frame(set), object, embed, applet, form, base, link, meta (refresh), and SVG <set> /
//    <animate> that retarget an href;
//  - attributes: on*, ping, formaction, srcdoc, background; javascript:/vbscript:/data:/file: on links;
//  - any src, srcset, poster, data or href-on-media that is not a data: image or a relative path;
//  - CSS: url(), @import, image-set() … that are not data:/relative/#fragment (stripRemoteCssUrls).
// Kept: inline styles, <style>, inline SVG (<image href="data:…">), data: images, data-ds-asset-id / data-ds-logo,
// http(s)/mailto/tel/#fragment links (they need a click).

const DECK_APP_ORIGIN = 'https://app.invalid' // never the real origin: every absolute URL is "external" for the server
const DECK_DROP_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'link', 'meta', 'portal', 'fencedframe', 'noembed', 'isindex'])
const DECK_DROP_ATTRS = new Set(['ping', 'formaction', 'srcdoc', 'background', 'dynsrc', 'lowsrc', 'manifest', 'action'])
const DECK_MEDIA_URL_ATTRS = new Set(['src', 'poster', 'data'])
// eslint-disable-next-line no-control-regex
const URL_NOISE = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]+/g

/** The host of a URL-ish value (null when it has none or is not http(s)/protocol-relative). */
function hostOfUrl(v: string): string | null {
  try {
    const u = new URL(v.replace(URL_NOISE, ''), DECK_APP_ORIGIN)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname && u.origin !== DECK_APP_ORIGIN ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/** A data: image or a relative path (what a persisted slide may load); everything else needs the network. */
export function isLocalMediaUrl(v: string): boolean {
  const k = classifyImageSrc(v, EMPTY_EGRESS_POLICY, DECK_APP_ORIGIN).kind
  return k === 'data' || k === 'relative'
}

/** `href` of a link: script-bearing and document-replacing schemes are refused, http(s)/mailto/tel/#/relative are kept. */
export function isSafeLinkHref(v: string): boolean {
  const s = v.replace(URL_NOISE, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase()
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
}

type DeckRemoved = { image: string[]; css: string[]; url: string[]; handler: number }

function cleanDeckAttribs(tag: string, attribs: Attribs, removed: DeckRemoved): Attribs {
  const css = (v: string) => {
    const hosts = externalUrlHosts(v, 'html', DECK_APP_ORIGIN)
    removed.css.push(...hosts.images, ...hosts.links)
  }
  const a: Attribs = {}
  for (const [k, v0] of Object.entries(attribs)) {
    const v = typeof v0 === 'string' ? v0 : ''
    if (/^on/i.test(k)) {
      removed.handler++
      continue
    }
    if (DECK_DROP_ATTRS.has(k)) {
      const h = hostOfUrl(v)
      if (h) removed.url.push(h)
      continue
    }
    if (DECK_MEDIA_URL_ATTRS.has(k)) {
      if (v && !isLocalMediaUrl(v)) {
        const h = hostOfUrl(v)
        if (h) removed.image.push(h)
        continue
      }
    } else if (k === 'srcset') {
      const single = v.trim().replace(/\s+[\d.]+[wx]$/i, '')
      if (single && !/\s/.test(single) && isLocalMediaUrl(single)) {
        a[k] = v
      } else {
        for (const m of v.matchAll(/(?:https?:)?\/\/[^\s,]+/gi)) {
          const h = hostOfUrl(m[0])
          if (h) removed.image.push(h)
        }
      }
      continue
    } else if (k === 'href' || k === 'xlink:href') {
      if (tag === 'a' || tag === 'area') {
        if (!isSafeLinkHref(v)) {
          removed.handler++
          continue
        }
      } else if (v && !v.trim().startsWith('#') && !isLocalMediaUrl(v)) {
        // <image>, <use>, <feImage>, <video>… : a reference that fetches, not one that navigates
        const h = hostOfUrl(v)
        if (h) removed.image.push(h)
        continue
      }
    } else if (CSS_URL_ATTRS.includes(k) && v) {
      const clean = stripRemoteCssUrls(v)
      if (clean !== v) css(v)
    }
    a[k] = v
  }
  const before = JSON.stringify(a)
  const clean = cleanAttribs(tag, a)
  if (JSON.stringify(clean) !== before) {
    for (const k of Object.keys(a)) if (!(k in clean) || clean[k] !== a[k]) if (CSS_URL_ATTRS.includes(k) && a[k]) css(a[k])
  }
  return clean
}

const DECK_ATTR_SEEN = ['src', 'href', 'data', 'action', 'content', 'xlink:href']

export function sanitizeDeckSlideHtml(html: string): string {
  if (typeof html !== 'string' || !html) return ''
  const removed: DeckRemoved = { image: [], css: [], url: [], handler: 0 }
  // `false` (allow all) is valid for sanitize-html but missing from its typings
  const opts: Parameters<typeof sanitizeHtml>[1] & Record<string, unknown> = {
    allowedTags: false as unknown as string[],
    allowedAttributes: false as unknown as Record<string, string[]>,
    allowVulnerableTags: true,
    allowProtocolRelative: true,
    // URL schemes are judged by cleanDeckAttribs (data: images, #fragments and relative paths stay)
    allowedSchemesAppliedToAttributes: [],
    allowedEmptyAttributes: ['alt', 'src', 'title'],
    parseStyleAttributes: false,
    exclusiveFilter: (frame: { tag: string; attribs?: Record<string, string> }) => {
      const tag = frame.tag.toLowerCase()
      const drop = DECK_DROP_TAGS.has(tag) || ((tag === 'set' || tag === 'animate') && /href/i.test(String(frame.attribs?.attributename || '')))
      if (drop) {
        for (const k of DECK_ATTR_SEEN) {
          const h = typeof frame.attribs?.[k] === 'string' ? hostOfUrl(frame.attribs[k]!.replace(/^\s*\d*\s*;\s*url=/i, '')) : null
          if (h) removed.url.push(h)
        }
      }
      return drop
    },
    transformTags: { '*': (tagName: string, attribs: Attribs) => ({ tagName, attribs: cleanDeckAttribs(tagName.toLowerCase(), attribs, removed) }) },
  }
  const out = sanitizeHtml(html, opts).replace(STYLE_BLOCK, (_: string, open: string, css: string, close: string) => {
    const clean = stripRemoteCssUrls(css)
    if (clean !== css) {
      const hosts = externalUrlHosts(css, 'html', DECK_APP_ORIGIN)
      removed.css.push(...hosts.images, ...hosts.links)
    }
    return open + clean + close
  })
  if (removed.image.length) logEgress({ surface: 'deck', kind: 'image', hosts: removed.image })
  if (removed.css.length) logEgress({ surface: 'deck', kind: 'css', hosts: removed.css })
  if (removed.url.length) logEgress({ surface: 'deck', kind: 'url', hosts: removed.url })
  // sanitize-html drops the doctype; without it a full document renders in quirks mode
  return /^(?:\s|<!--(?:(?!-->)[\s\S])*-->)*<!doctype html/i.test(html) ? `<!doctype html>${out}` : out
}
