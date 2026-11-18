// Colours for the miniature app drawn in the Preferences theme cards. The
// "System" card shows light and dark side by side, so it cannot use var():
// the tokens resolve only on :root[data-theme]. Instead the values are read
// from styles/tokens.css itself (imported ?raw by PersonalTab), so the
// preview can never drift from the real themes.

const NEUTRAL = '#808080'

// preview part -> token it mirrors
const PARTS = { bg: '--bg', rail: '--surface-2', line: '--border', bubble: '--bubble-user', accent: '--accent' }

function block(css, selectorRe) {
  const m = css.match(selectorRe)
  if (!m) return ''
  const start = css.indexOf('{', m.index)
  const end = css.indexOf('}', start)
  return start < 0 || end < 0 ? '' : css.slice(start + 1, end)
}

function read(body, name) {
  const m = body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`))
  return m ? m[1].toLowerCase() : null
}

/** { dark: {bg, rail, line, bubble, accent}, light: {…} } from tokens.css text. */
export function parseThemeTokens(css = '') {
  const dark = block(css, /:root(?:\s*,\s*:root\[data-theme='dark'\])?\s*\{/)
  const light = block(css, /:root\[data-theme='light'\]\s*\{/)
  const pick = (body, fallback) =>
    Object.fromEntries(Object.entries(PARTS).map(([k, token]) => [k, read(body, token) || fallback?.[k] || NEUTRAL]))
  const d = pick(dark)
  return { dark: d, light: pick(light) }
}
