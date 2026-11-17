// Makes design-system HTML inert before it is stored or sent to a browser as a
// thumbnail (extractFirstTemplateSlide in server/db.js). A design system is
// customer-supplied (agency bundle, Figma export, zip) and a global one is shown
// to every user, so any script in it would run in their browsers.
//
// A tiny HTML tokenizer, not a regex pass: regexes miss a handler that follows a
// quoted value containing ">" (`<img title="a>b" onerror=…>`), a slash
// (`<svg/onload=…>`) or a spaced end tag (`</script >`). Every tag is rebuilt
// from its parsed name and attributes, so the output only contains what was
// understood:
//  - removed with their content: <script>; removed as tags: iframe, frame,
//    frameset, object, embed, applet, base; comments, <? … ?> and <![…]> go too;
//  - removed attributes: every on* handler, srcdoc, and any URL attribute whose
//    value (after decoding character references and dropping control/space
//    characters) starts with javascript:, vbscript: or data:text/html;
//  - nothing is treated as raw text (not even <style>): inside <svg> a <style>
//    child is parsed as markup, so its "text" is sanitized like everything else.
// The thumbnail iframe is sandboxed as well (DeckTemplatesSettings.jsx); this is
// the second layer. Pure function, no DOM.

const WS = /[\t\n\f\r ]/
const DROP_WITH_CONTENT = new Set(['script'])
const DROP_TAG = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base'])
const DROP_ATTR = new Set(['srcdoc'])
const URL_ATTRS = new Set([
  'href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background',
  'codebase', 'cite', 'longdesc', 'dynsrc', 'lowsrc', 'ping', 'srcset', 'manifest',
])
const BAD_SCHEME = /^(?:javascript|vbscript|data:text\/html)/

function decodeRefs(v) {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&(colon|tab|newline);?/gi, (_, n) => ({ colon: ':', tab: '\t', newline: '\n' })[n.toLowerCase()])
}

function unsafeUrl(value) {
  // browsers ignore ASCII whitespace and control characters inside the scheme
  const v = decodeRefs(value).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()
  return BAD_SCHEME.test(v)
}

// Parses the tag that starts at html[at] === '<' (followed by a letter or '/').
// Returns { name (lower case), raw (as written), closing, attrs: [[raw name,
// value|null]], selfClosing, end } or
// null when the tag never ends (the rest of the input is then dropped).
function readTag(html, at) {
  const n = html.length
  let j = at + 1
  const closing = html[j] === '/'
  if (closing) j++
  let name = ''
  while (j < n && !WS.test(html[j]) && html[j] !== '/' && html[j] !== '>') name += html[j++]
  const attrs = []
  let selfClosing = false
  while (j < n) {
    const c = html[j]
    if (WS.test(c)) { j++; continue }
    if (c === '>') return { name: name.toLowerCase(), raw: name, closing, attrs, selfClosing, end: j + 1 }
    if (c === '/') { selfClosing = html[j + 1] === '>'; j++; continue }
    selfClosing = false
    // attribute name: the first character may be '=' (spec), then up to ws / '/' / '>' / '='
    let an = html[j++]
    while (j < n && !WS.test(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') an += html[j++]
    let k = j
    while (k < n && WS.test(html[k])) k++
    let value = null
    if (html[k] === '=') {
      k++
      while (k < n && WS.test(html[k])) k++
      const q = html[k]
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, k + 1)
        if (close < 0) return null
        value = html.slice(k + 1, close)
        k = close + 1
      } else {
        let v = ''
        while (k < n && !WS.test(html[k]) && html[k] !== '>') v += html[k++]
        value = v
      }
      j = k
    }
    attrs.push([an, value])
  }
  return null
}

function keepAttr(rawName, value) {
  // the parser lower-cases attribute names (SVG camelCase is restored after), so
  // checks use lower case while the output keeps the original spelling
  const name = rawName.toLowerCase()
  if (name.startsWith('on')) return false
  if (DROP_ATTR.has(name)) return false
  if (value != null && URL_ATTRS.has(name) && unsafeUrl(value)) return false
  return true
}

const escAttr = (v) => v.replace(/"/g, '&quot;')

export function sanitizeDsHtml(html) {
  if (typeof html !== 'string' || !html) return ''
  const n = html.length
  let out = ''
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)
    i = lt
    const next = html[i + 1] || ''
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      if (end < 0) break
      i = end + 3
      continue
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', i)
      if (end < 0) break
      if (/^<!doctype[\s>]/i.test(html.slice(i, i + 10))) out += '<!doctype html>'
      i = end + 1
      continue
    }
    const isTag = /[a-zA-Z]/.test(next) || (next === '/' && /[a-zA-Z]/.test(html[i + 2] || ''))
    if (!isTag) {
      if (next === '/') {
        // `</ …>` and `</>` are bogus comments / ignored by the parser
        const end = html.indexOf('>', i)
        if (end < 0) break
        i = end + 1
        continue
      }
      out += '<'
      i++
      continue
    }
    const tag = readTag(html, i)
    if (!tag) break
    i = tag.end
    if (DROP_WITH_CONTENT.has(tag.name)) {
      if (tag.closing) continue
      // the element ends at `</script` followed by whitespace, '/' or '>' (any case)
      const re = /<\/script[\t\n\f\r />]/gi
      re.lastIndex = i
      const m = re.exec(html)
      if (!m) break
      const gt = html.indexOf('>', m.index)
      if (gt < 0) break
      i = gt + 1
      continue
    }
    if (DROP_TAG.has(tag.name)) continue
    if (tag.closing) {
      out += `</${tag.raw}>`
      continue
    }
    let rebuilt = `<${tag.raw}`
    for (const [an, av] of tag.attrs) {
      if (!keepAttr(an, av)) continue
      rebuilt += av == null ? ` ${an}` : ` ${an}="${escAttr(av)}"`
    }
    out += rebuilt + (tag.selfClosing ? '/>' : '>')
  }
  return out
}
