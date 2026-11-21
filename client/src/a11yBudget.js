// Static budgets for the accessibility / design-token sweep (W3-8). Pure
// functions over source text, so the test can feed them fixtures.
//
// Rules, one per budget:
//  - `outline-none`, or a focus-visible: utility that removes or hides the
//    indicator (outline-none/-0, ring-0, shadow-none, …-transparent), needs a
//    focus-visible: ring/outline/border/shadow on the same line that draws and
//    is not cancelled by another utility of the same kind. Without one, drop
//    `outline-none`: the global :focus-visible ring shows.
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

// Focus indicator rule. A same-line `focus-visible:` utility counts as a
// replacement only if it draws something: a ring/outline of width >= 1, a
// border, or a shadow. Per kind (outline, ring, border, shadow) a utility
// that removes it (outline-none/-0/-hidden, ring-0, border-0, shadow-none) or
// makes it invisible (…-transparent, …-[transparent], any colour at /0)
// cancels every positive utility of that kind on the line, whatever the order.
// `outline-offset-*` alone draws nothing.
// `!` is Tailwind's important modifier (leading after the variants, or trailing);
// it is stripped before classifying, so `focus-visible:!outline-transparent`
// cancels like `focus-visible:outline-transparent`.
const FV_TOKEN = /(?<![\w-])(?:[\w-]+:)*focus-visible:((?:[\w-]+:)*)(!?[\w./[\]#%()-]+!?)/g
const KINDS = {
  outline: {
    remove: /^outline-(?:none|0|hidden)$/,
    invisible: /^outline-(?!offset-)(?:transparent|\[transparent\]|.+\/0)$/,
    draws: /^outline(?:-[1-9]\d*|-dashed|-dotted|-double|-solid)?$/,
  },
  ring: {
    remove: /^ring-0$/,
    invisible: /^ring-(?!offset-)(?:transparent|\[transparent\]|.+\/0)$/,
    draws: /^ring(?:-[1-9]\d*)?$/,
  },
  border: {
    remove: /^border(?:-[xytblr])?-0$/,
    invisible: /^border(?:-[xytblr])?-(?:transparent|\[transparent\]|.+\/0)$/,
    draws: /^border(?:-[xytblr])?(?:-[1-9]\d*)?(?:-(?!0$|transparent$|\[transparent\]$|.+\/0$)[a-z][\w-]*)?$/,
  },
  shadow: {
    remove: /^shadow-none$/,
    invisible: /^shadow-(?:transparent|\[transparent\]|.+\/0)$/,
    draws: /^shadow(?:-(?!none$|transparent$|\[transparent\]$|.+\/0$)[\w-]+)?$/,
  },
}

export function outlineWithoutFocusVisible(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    let triggered = /(?<![\w-])outline-none(?![\w-])/.test(line)
    const drawn = new Set()
    const cancelled = new Set()
    for (const m of line.matchAll(FV_TOKEN)) {
      const util = m[2].replace(/^!|!$/g, '')
      for (const [kind, r] of Object.entries(KINDS)) {
        if (r.remove.test(util) || r.invisible.test(util)) {
          cancelled.add(kind)
          triggered = true
        } else if (r.draws.test(util)) drawn.add(kind)
      }
    }
    if (!triggered) return
    const effective = [...drawn].some((k) => !cancelled.has(k))
    if (!effective) hits.push(i + 1)
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
