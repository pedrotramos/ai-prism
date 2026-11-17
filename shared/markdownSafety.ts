// Raw HTML and script-bearing URLs out of markdown that one user (or a model)
// writes and another opens (2.3.0 security review): a project document can be
// edited by any member and is rendered with innerHTML by the WYSIWYG editor.
// Applied on every document write (server/blocks.js sanitizeDocument) and again
// in the browser before marked renders it (client/src/lib/safeMarkdown.js,
// which then runs DOMPurify over the HTML).
//
//  - Every `<` that would open a tag, a comment, a declaration or a processing
//    instruction becomes `&lt;`, so the markup shows as text. Kept as they are:
//    a few attribute-less formatting tags (SAFE_TAG: nothing to execute and no
//    attribute to carry a handler) and http(s)/mailto autolinks.
//  - A link or image destination (inline, or a reference definition) whose
//    scheme isn't http(s), mailto or tel, or a raster data: image, becomes `#`.
//
// Code blocks and code spans are NOT skipped: deciding where marked sees code
// means re-implementing its parser, and any disagreement (a fence it closes
// where we don't) would leave raw HTML that it renders. The price is cosmetic:
// a `<tag` inside code shows as `&lt;tag`. Idempotent; pure (no DOM), for
// both sides.

const SAFE_TAG = /<\/?(?:br|b|i|em|strong|u|s|del|ins|sub|sup|mark|kbd|small)\s*\/?>/iy
const SAFE_AUTOLINK = /<(?:https?:\/\/|mailto:)[^\s<>"'`\\]*>/iy
const TAG_START = /<(?=[A-Za-z/!?])/g
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

// a backslash run of odd length before `at` escapes the character at `at`
// (markdown then shows it as text)
function escapedAt(text: string, at: number): boolean {
  let n = 0
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) n++
  return n % 2 === 1
}

function escapeTags(text: string): string {
  return text.replace(TAG_START, (lt: string, at: number) => {
    if (escapedAt(text, at)) return lt
    for (const re of [SAFE_TAG, SAFE_AUTOLINK]) {
      re.lastIndex = at
      if (re.test(text)) return lt
    }
    return '&lt;'
  })
}

// Is the destination safe, judged as a browser would read its scheme:
// entities decoded, backslash escapes, whitespace and control characters
// dropped (URL parsers ignore tabs and newlines), lowercased?
export function safeLinkDestination(dest: unknown): boolean {
  const decoded = String(dest)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&colon;?/gi, ':')
    .replace(/&(?:tab|newline|nbsp);?/gi, '')
  const flat = decoded.replace(/[\\\s\u0000-\u001f\u007f-\u009f]+/g, '').toLowerCase()
  const m = flat.match(/^([a-z][a-z0-9+.-]*):/)
  const scheme = m?.[1]
  if (scheme === undefined || SAFE_SCHEMES.has(scheme)) return true
  return scheme === 'data' && /^data:image\/(?:png|jpe?g|gif|webp)[;,]/.test(flat)
}

const cleanDest = (dest: string): string => (safeLinkDestination(dest) ? dest : '#')

function neutralizeLinks(text: string): string {
  return (
    text
      // [text](<dest>) and [text](dest …), the destination maybe on the next line
      .replace(/(\]\(\s*<)([^>\n]*)(?=>)/g, (_: string, pre: string, dest: string) => pre + cleanDest(dest))
      // (a bare destination may hold balanced parentheses and backslash escapes)
      .replace(/(\]\(\s*)((?!<)(?:\\.|\([^\s()]*\)|[^\s()])+)/g, (_: string, pre: string, dest: string) => pre + cleanDest(dest))
      // [id]: dest   (reference definitions)
      .replace(/^( {0,3}\[[^\]\n]*\]:[ \t]*(?:\n[ \t]*)?<?)([^\s>]+)/gm, (_: string, pre: string, dest: string) => pre + cleanDest(dest))
  )
}

/** `markdown` with raw HTML escaped and unsafe link destinations replaced (see above). */
export function stripUnsafeMarkdownHtml(markdown: unknown): string {
  if (typeof markdown !== 'string') return ''
  return escapeTags(neutralizeLinks(markdown))
}
