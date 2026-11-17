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
//    and only data:image/*.

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
  transformTags: {
    // data: is allowed on <img> only as an image; anything else loses its src
    img: (tagName, attribs) => {
      const src = String(attribs.src || '').trim()
      if (/^data:/i.test(src) && !/^data:image\//i.test(src)) {
        const { src: _drop, ...rest } = attribs
        return { tagName, attribs: rest }
      }
      return { tagName, attribs }
    },
  },
}

export function sanitizeDsHtml(html) {
  if (typeof html !== 'string' || !html) return ''
  const out = sanitizeHtml(html, OPTIONS)
  // sanitize-html drops the doctype; without it the srcdoc renders in quirks mode
  return /^\s*<!doctype html/i.test(html) ? `<!doctype html>${out}` : out
}
