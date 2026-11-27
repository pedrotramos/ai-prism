// Slide-level Design panel model (deck editor, nothing selected): the swatches a
// DS offers as a slide background, and the slide root's inline margins. Pure, so
// it is unit-tested without a browser. Nothing here names a particular DS: every
// colour comes from the ACTIVE template's tokens.

export interface DsColorSource {
  primaryColor?: string | null
  secondaryColor?: string | null
  accentColor?: string | null
  backgroundColor?: string | null
  palette?: Array<{ varName?: string; name?: string; value?: unknown } | null> | null
}

export interface Swatch {
  /** the colour written to the slide root (a concrete literal, so export resolves it without the DS stylesheet) */
  value: string
  /** accessible name: the DS token name when it has one, else the colour */
  label: string
}

export interface SlideMargins {
  top: number
  right: number
  bottom: number
  left: number
}

export type MarginSide = keyof SlideMargins

export interface SlideRootDesign {
  /** the root's inline `background` (CSS text), '' when none */
  background: string
  /** per-side inline padding exactly as authored ('3rem', '10%', 'calc(…)'), '' when the side has none */
  css: Record<MarginSide, string>
  /** the same sides as px, approximate (rem/em = 16 px; % and calc() = 0): only the editor grid uses it */
  margins: SlideMargins
}

const COLOR_LITERAL = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i
const MAX_SWATCHES = 12

export function dsBackgroundSwatches(template: DsColorSource | null | undefined): Swatch[] {
  if (!template) return []
  const out: Swatch[] = []
  const seen = new Set<string>()
  const add = (raw: unknown, label: string) => {
    if (typeof raw !== 'string') return
    const value = raw.trim()
    if (!COLOR_LITERAL.test(value)) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ value, label: label || value })
  }
  // brand fields first (what the DS names), then every colour token it declares
  add(template.backgroundColor, 'background')
  add(template.primaryColor, 'primary')
  add(template.secondaryColor, 'secondary')
  add(template.accentColor, 'accent')
  for (const tok of template.palette || []) {
    if (tok) add(tok.value, (tok.name || tok.varName || '').replace(/^--/, ''))
  }
  return out.slice(0, MAX_SWATCHES)
}

const LENGTH = /^(\d*\.?\d+)(px|rem|em|%|pt|ch|vw|vh|vmin|vmax)$/i
const FUNC = /^(calc|min|max|clamp)\(/i

/** Approximate px of an authored length, for the editor grid only. */
function approxPx(v: string | undefined): number {
  const m = LENGTH.exec((v || '').trim())
  if (!m) return 0
  const n = parseFloat(m[1]!)
  const unit = m[2]!.toLowerCase()
  return unit === 'px' ? n : unit === 'rem' || unit === 'em' ? n * 16 : 0
}

/** A typed margin as a CSS length: a bare number is px; a length with a unit, or calc()/min()/max()/clamp(), is kept as typed; anything else is null. */
export function normalizeLength(raw: string): string | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (/^\d*\.?\d+$/.test(v)) return `${v}px`
  if (LENGTH.test(v)) return v
  if (FUNC.test(v) && v.endsWith(')')) {
    let depth = 0
    for (const ch of v) {
      if (ch === '(') depth++
      else if (ch === ')' && --depth < 0) return null
    }
    return depth === 0 ? v : null
  }
  return null
}

const SIDE_PROP = { top: 'paddingTop', right: 'paddingRight', bottom: 'paddingBottom', left: 'paddingLeft' } as const

/** The style patch for editing ONE margin: only that side's longhand, so the other three keep their exact CSS (units, %, calc()). */
export function marginPatch(side: MarginSide, raw: string): Record<string, string> | null {
  const v = normalizeLength(raw)
  return v ? { [SIDE_PROP[side]]: v } : null
}

/** Reads the slide root's inline background and padding out of the slide's HTML string. */
export function readSlideRoot(html: string | null | undefined): SlideRootDesign {
  const empty: SlideRootDesign = { background: '', css: { top: '', right: '', bottom: '', left: '' }, margins: { top: 0, right: 0, bottom: 0, left: 0 } }
  if (!html) return empty
  const root = new DOMParser().parseFromString(html, 'text/html').querySelector('section')
  if (!root) return empty
  const s = root.style
  const css = { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft }
  return {
    background: s.background || s.backgroundColor || '',
    css,
    margins: { top: approxPx(css.top), right: approxPx(css.right), bottom: approxPx(css.bottom), left: approxPx(css.left) },
  }
}

/** Normalises a CSS colour so `#0B2026` and `rgb(11, 32, 38)` compare equal. */
export function sameColor(a: string, b: string): boolean {
  if (!a || !b) return false
  const norm = (v: string) => {
    const el = document.createElement('i')
    el.style.color = v
    return el.style.color
  }
  const na = norm(a)
  return !!na && na === norm(b)
}

export interface GridColumn {
  x: number
  w: number
}

/** Column rectangles (stage px) for the editor-only grid overlay, inside the slide margins. */
export function gridColumns(stageW: number, margins: Pick<SlideMargins, 'left' | 'right'>, columns: number, gutter: number): GridColumn[] {
  const n = Math.max(1, Math.min(24, Math.floor(columns) || 1))
  const g = Math.max(0, gutter || 0)
  const inner = stageW - margins.left - margins.right
  const w = (inner - g * (n - 1)) / n
  if (!(w > 0)) return []
  return Array.from({ length: n }, (_, i) => ({ x: margins.left + i * (w + g), w }))
}
