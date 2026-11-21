#!/usr/bin/env node
// One-off style audit of client/src/**/*.{jsx,tsx}: counts the visual values that
// bypass the design tokens. Same regexes as the UX baseline's token-audit.sh
// (evidence of 2026-11-17: 69 + 112 + 23 + 108 + 226 = 538), ported to Node
// so the counts do not depend on BSD vs GNU grep.
//
//   node client/e2e/token-audit.mjs            # JSON with the counts
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The five kinds whose sum is the "one-off styles" regression bar.
export const ONE_OFF_PATTERNS = {
  style_props_any: /style=\{/g,
  hex_literals_jsx: /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g,
  rgba_jsx: /rgba?\(/g,
  tw_raw_palette_colors:
    /\b(bg|text|border|ring|from|to|fill|stroke)-(red|green|blue|amber|yellow|emerald|sky|violet|purple|orange|rose|slate|gray|zinc|neutral|white|black)(-[0-9]+)?(\/[0-9]+)?\b/g,
  tw_arbitrary_px_rem:
    /\b[a-z0-9:-]*(text|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|top|left|right|bottom|rounded|leading|tracking|inset)-\[-?[0-9.]+(px|rem|em|%|vh|vw|ch)\]/g,
}

// Context counters (reported, not gated).
const CONTEXT_PATTERNS = {
  outline_none: /outline-none/g,
  focus_visible_classes: /focus-visible:[^ "`]+/g,
  tw_arbitrary_values: /\b[a-z0-9:-]+-\[[^\] ]+\]/g,
  tw_arbitrary_var_tokens: /\b[a-z0-9:-]+-\[var\(--[^\] ]+\]/g,
}

function jsxFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...jsxFiles(p))
    else if (/\.(jsx|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

// grep -o counts non-overlapping matches per LINE; matching line by line keeps
// the same semantics for patterns that could otherwise span a newline.
function count(text, re) {
  let n = 0
  for (const line of text.split('\n')) n += (line.match(re) || []).length
  return n
}

export function auditTokens(srcDir) {
  const files = jsxFiles(srcDir)
  const texts = files.map((f) => readFileSync(f, 'utf8'))
  const byKind = {}
  for (const [k, re] of Object.entries(ONE_OFF_PATTERNS)) byKind[k] = texts.reduce((a, t) => a + count(t, re), 0)
  const context = {}
  for (const [k, re] of Object.entries(CONTEXT_PATTERNS)) context[k] = texts.reduce((a, t) => a + count(t, re), 0)
  return { files: files.length, oneOff: { total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind }, context }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  process.stdout.write(JSON.stringify(auditTokens(src), null, 2) + '\n')
}
