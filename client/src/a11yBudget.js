// Static budgets for the accessibility / design-token sweep (W3-8). Pure
// functions over source text, so the test can feed them fixtures.
//
// Rules, one per budget:
//  - `outline-none` needs a `focus-visible:` utility on the same line. (The
//    global :focus-visible ring in index.css already shows for keyboard users;
//    the rule stops a new `focus-visible:outline-none` or an outline-none
//    that someone later pairs with nothing.)
//  - no arbitrary z-index (`z-[75]`): use the scale in tokens.css.
//  - at most 6 distinct legacy font-size classes (text-xs … text-[Npx]); the
//    type scale is text-caption/label/body/title/heading/display.
//  - one-off style values (style props, hex, rgb/rgba, raw palette colours,
//    numeric arbitrary Tailwind values) stay under a budget unless tagged
//    `/* data */` (same line or the line above) or inside a
//    `/* data:start */ … /* data:end */` region. Tag only values that are
//    data (design-system swatches, DS-derived fills, the logo artwork).

export const ONE_OFF = {
  style: /style=\{/g,
  hex: /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g,
  rgb: /rgba?\(/g,
  palette:
    /\b(bg|text|border|ring|from|to|fill|stroke)-(red|green|blue|amber|yellow|emerald|sky|violet|purple|orange|rose|slate|gray|zinc|neutral|white|black)(-[0-9]+)?(\/[0-9]+)?\b/g,
  arbitrary:
    /\b[a-z0-9:-]*(text|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|top|left|right|bottom|rounded|leading|tracking|inset)-\[-?[0-9.]+(px|rem|em|%|vh|vw|ch)\]/g,
}
const TAG = /\/\*\s*data(?!:)(?:\s[^*]*)?\*\/|\/\*\s*data:\s[^*]*\*\//
const START = /\/\*\s*data:start\b[^*]*\*\//
const END = /\/\*\s*data:end\b[^*]*\*\//
const FONT_SIZE = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl|\[-?[0-9.]+(?:px|rem|em|%|vh|vw|ch)\])(?![\w\]-])/g
const Z_ARBITRARY = /(?<![\w-])z-\[[^\]]+\]/g

const count = (line, re) => (line.match(re) || []).length

export function outlineWithoutFocusVisible(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (/\boutline-none\b/.test(line) && !/\bfocus-visible:/.test(line)) hits.push(i + 1)
  })
  return hits
}

export function arbitraryZIndex(text) {
  return text.split('\n').reduce((n, l) => n + count(l, Z_ARBITRARY), 0)
}

export function fontSizeClasses(text) {
  return [...text.matchAll(FONT_SIZE)].map((m) => m[1])
}

export function untaggedOneOffs(text) {
  const lines = text.split('\n')
  let inRegion = false
  let n = 0
  lines.forEach((line, i) => {
    if (START.test(line)) inRegion = true
    const tagged = inRegion || TAG.test(line) || (i > 0 && TAG.test(lines[i - 1]))
    if (END.test(line)) inRegion = false
    if (tagged) return
    for (const re of Object.values(ONE_OFF)) n += count(line, re)
  })
  return n
}
