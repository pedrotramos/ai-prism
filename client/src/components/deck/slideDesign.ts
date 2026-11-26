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

export interface SlideRootDesign {
  /** the root's inline `background` (CSS text), '' when none */
  background: string
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

const px = (v: string | undefined) => {
  const n = parseFloat(v || '')
  return Number.isFinite(n) ? n : 0
}

/** Reads the slide root's inline background and padding out of the slide's HTML string. */
export function readSlideRoot(html: string | null | undefined): SlideRootDesign {
  const empty: SlideRootDesign = { background: '', margins: { top: 0, right: 0, bottom: 0, left: 0 } }
  if (!html) return empty
  const root = new DOMParser().parseFromString(html, 'text/html').querySelector('section')
  if (!root) return empty
  const s = root.style
  return {
    background: s.background || s.backgroundColor || '',
    margins: { top: px(s.paddingTop), right: px(s.paddingRight), bottom: px(s.paddingBottom), left: px(s.paddingLeft) },
  }
}

/** The one `padding` shorthand the edit op writes for a margins change. */
export function marginsToPadding(m: SlideMargins): string {
  return `${m.top}px ${m.right}px ${m.bottom}px ${m.left}px`
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
