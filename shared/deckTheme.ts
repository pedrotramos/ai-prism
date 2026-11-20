// THE deck theme resolver — single source of truth for every derived color
// token, consumed by BOTH renderers (server/decks.js for pptx, client
// DeckSlidePreview.jsx for DOM). Until this module existed the blend/contrast
// math lived duplicated in both files ("keep in sync" comments); now a theme
// change is one edit. All color tokens are returned as '#RRGGBB' — the pptx
// side strips the '#'.

/** A design-system asset (icon or illustration) carried by a template. */
export interface DeckAsset {
  kind?: string
  label?: string
  [key: string]: unknown
}

/** Style mined from an imported .pptx template. */
export interface MinedStyle {
  headingColor?: string | null
  coverOverlayDataUrl?: string | null
  sectionPlateDataUrl?: string | null
  motif?: unknown
  titlePt?: number | null
}

/** The raw template a deck is themed from (every field optional). */
export interface DeckTemplate {
  primaryColor?: string | null
  secondaryColor?: string | null
  accentColor?: string | null
  backgroundColor?: string | null
  headingFont?: string | null
  bodyFont?: string | null
  minedStyle?: MinedStyle | null
  logoDataUrl?: string | null
  logoLightDataUrl?: string | null
  coverPlateDataUrl?: string | null
  iconAssets?: readonly DeckAsset[] | null
}

export const DEFAULT_TEMPLATE_THEME = {
  primaryColor: '#1A1A2E',
  secondaryColor: '#4A4E69',
  accentColor: '#E63946',
  backgroundColor: '#FFFFFF',
  headingFont: 'Georgia',
  bodyFont: 'Helvetica',
}

export function hexOr<F>(c: string | null | undefined, fallback: F): string | F {
  if (!c || !/^#?[0-9a-fA-F]{6}$/.test(c)) return fallback
  return c.startsWith('#') ? c.toUpperCase() : `#${c.toUpperCase()}`
}

// Perceived luminance (ITU-R BT.601), 0..1. Only a coarse light/dark signal
// (logo-variant picking, near-white detection, accent-vs-primary distance).
// It is NOT used to choose text ink: that goes through `contrastOn`, which
// compares real WCAG contrast.
export function luminance(hexColor: string): number {
  const c = hexColor.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

// WCAG 2.x relative luminance: sRGB channels linearized, weighted 0.2126 /
// 0.7152 / 0.0722. 0 = black, 1 = white. `#` optional, case-insensitive.
export function relativeLuminance(hexColor: string): number {
  const c = hexColor.replace('#', '')
  const lin = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4)
}

// WCAG 2.x contrast ratio between two colors, 1..21 (symmetric).
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const INK_LIGHT = '#FFFFFF'
const INK_DARK = '#1A1A1A'

// Text ink for a colored background: whichever of white / near-black has the
// higher real WCAG contrast ratio; an exact tie goes to the dark ink.
export function contrastOn(hexColor: string): string {
  return contrastRatio(hexColor, INK_LIGHT) > contrastRatio(hexColor, INK_DARK) ? INK_LIGHT : INK_DARK
}

// (Deliberately keeps the coarse `luminance` split rather than `contrastOn`: the
// two logo lockups are fixed art, so a mid-tone bg must keep today's pairing.)
// Picks the logo variant that reads against a given slide background. On a dark
// bg use the white/light lockup (logoDataUrl); on a light bg use the full-color
// one (logoLightDataUrl). Falls back to whichever variant exists, so a template
// with only one logo still renders it (better a slightly-off logo than none).
// `bgHex` may carry or omit the leading '#'. Returns a data URL or null.
export function pickLogoForBg(
  theme: { logoDataUrl?: string | null; logoLightDataUrl?: string | null } | null | undefined,
  bgHex?: string | null,
): string | null {
  if (!theme) return null
  const light = theme.logoDataUrl || null // white/light lockup → for dark bg
  const color = theme.logoLightDataUrl || null // full-color lockup → for light bg
  if (!light && !color) return null
  const bgIsDark = bgHex ? luminance(bgHex.startsWith('#') ? bgHex : `#${bgHex}`) < 0.55 : true
  if (bgIsDark) return light || color
  return color || light
}

// Linear blend between two hex colors (t=0 → a, t=1 → b) — the whole derived
// palette below (soft accents, hairlines, muted text) is computed this way
// from the template's 4 raw colors, so it generalizes to any template, rich
// or poor (gap analysis §4.1).
export function blend(a: string, b: string, t: number): string {
  const A = a.replace('#', '')
  const B = b.replace('#', '')
  const ch = (i: number) => Math.round(parseInt(A.slice(i, i + 2), 16) * (1 - t) + parseInt(B.slice(i, i + 2), 16) * t)
  return `#${[ch(0), ch(2), ch(4)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** The resolved theme: every derived color token plus fonts and brand assets. */
export type DeckTheme = ReturnType<typeof resolveDeckTheme>

export function resolveDeckTheme(template?: DeckTemplate | null) {
  const t: DeckTemplate = template || {}
  const mined: MinedStyle = t.minedStyle || {}
  const D = DEFAULT_TEMPLATE_THEME
  const primary = hexOr(t.primaryColor, D.primaryColor)
  const secondary = hexOr(t.secondaryColor, D.secondaryColor)
  const accent = hexOr(t.accentColor, D.accentColor)
  const background = hexOr(t.backgroundColor, D.backgroundColor)
  const onBackground = contrastOn(background)
  const onPrimary = contrastOn(primary)
  const lightBg = onBackground !== '#FFFFFF'
  // when accent === primary (the common 2-color client template), a divider
  // or kicker in "accent" must still read as an intentional highlight — the
  // math below never assumes accent is a distinct hue
  return {
    primary,
    secondary,
    accent,
    background,
    onPrimary,
    onAccent: contrastOn(accent),
    onBackground,
    // content headings: the template's own mined title ink when available,
    // else brand primary over a light background / near-white over a dark one
    heading: lightBg ? hexOr(mined.headingColor, primary) : blend('#FFFFFF', background, 0.05),
    bodyText: lightBg ? blend('#1A1A1A', background, 0.12) : blend('#FFFFFF', background, 0.12),
    muted: lightBg ? blend('#1A1A1A', background, 0.45) : blend('#FFFFFF', background, 0.4),
    faint: lightBg ? blend('#1A1A1A', background, 0.62) : blend('#FFFFFF', background, 0.55),
    hairline: lightBg ? blend('#000000', background, 0.88) : blend('#FFFFFF', background, 0.82),
    // derived semantic surfaces (gap analysis §4.1): a soft tint of the
    // accent for highlight panels, and a card surface slightly off the
    // background so cards read as objects without heavy borders
    accentSoft: blend(accent, background, 0.9),
    cardFill: lightBg
      ? luminance(background) > 0.97
        ? blend('#000000', background, 0.985)
        : '#FFFFFF'
      : blend('#FFFFFF', background, 0.93),
    deep: blend(primary, '#000000', 0.35),
    // muted counterpart of onPrimary for dark cover/section/closing slides
    onPrimaryMuted: blend(onPrimary, primary, 0.35),
    onPrimaryFaint: blend(onPrimary, primary, 0.55),
    // accent for text/rules placed ON the primary surface (kickers on dark
    // covers/dividers). When a 2-color template collapses accent === primary
    // (a common client case), the raw accent would be invisible dark-on-dark —
    // fall back to onPrimary so a kicker never disappears. Otherwise the real
    // brand accent, nudged toward onPrimary just enough to clear the surface.
    accentOnPrimary:
      Math.abs(luminance(accent) - luminance(primary)) < 0.22 ? onPrimary : blend(accent, onPrimary, 0.15),
    headingFont: t.headingFont || D.headingFont,
    bodyFont: t.bodyFont || D.bodyFont,
    // Two logo variants come out of DS ingestion: logoDataUrl is the light/
    // white lockup (for dark slides), logoLightDataUrl the full-color one (for
    // light slides). Exposing BOTH lets the renderer pick the one that actually
    // contrasts with a given slide's background — a white logo on the oat
    // content bg is invisible and reads as "no logo" (the benchmark symptom).
    logoDataUrl: t.logoDataUrl || null,
    logoLightDataUrl: t.logoLightDataUrl || null,
    // template's own full-bleed cover photo (mined from the imported .pptx) —
    // when present it carries the brand's real visual identity on covers/
    // dividers; plus the deeper mined identity: the cover's overlay layer,
    // a distinct section-divider plate, and the template's own vector motif.
    // No mined motif → no motif at all (never a stock/house decoration).
    coverPlate: t.coverPlateDataUrl || null,
    coverOverlay: mined.coverOverlayDataUrl || null,
    sectionPlate: mined.sectionPlateDataUrl || null,
    motif: mined.motif || null,
    // typographic personality: master title size normalized to this canvas,
    // 30pt ≈ neutral — scales headline sizes only, body density stays ours
    typeScale: Math.max(0.85, Math.min(1.15, (mined.titlePt || 27) / 27)),
    // design-system bundle illustrations (e.g. the nodal dot-network SVGs) —
    // the brand's REAL decorative art for covers/section dividers; when any
    // exist they replace the mined motif entirely
    illustrations: (t.iconAssets || []).filter((a) => a.kind === 'illustration'),
  }
}

// --- theme color tokens (element-canvas '@' references) ---------------------
// A persisted freeform element may reference a theme color as '@token'
// instead of a concrete '#RRGGBB'. Tokens resolve at PAINT time (both
// renderers), so a freeform slide that uses them keeps re-theming when the
// user switches design systems — the LLM generator always emits tokens,
// concrete hex only enters via the Studio's color pickers.
export const THEME_COLOR_TOKENS = [
  'primary', 'secondary', 'accent', 'background',
  'heading', 'bodyText', 'muted', 'faint', 'hairline',
  'accentSoft', 'cardFill', 'deep',
  'onPrimary', 'onAccent', 'onBackground', 'onPrimaryMuted', 'onPrimaryFaint', 'accentOnPrimary',
] as const

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number]

// '@accent' → theme.accent; concrete values pass through; unknown tokens
// resolve to `fallback` (undefined → the painter's own default kicks in).
export function resolveThemeColor<F = undefined>(
  theme: Readonly<Record<string, unknown>> | null | undefined,
  value: string | null | undefined,
  fallback?: F,
): string | F | undefined {
  if (typeof value !== 'string' || value[0] !== '@') return value ?? fallback
  const token = value.slice(1)
  const resolved = theme?.[token]
  return typeof resolved === 'string' ? resolved : fallback
}

// Deterministic illustration pick: covers use the lead colored piece, each
// section divider cycles through the rest so a long deck doesn't repeat the
// same art on every divider. Gray variants only when nothing colored exists.
export function pickDeckIllustration(
  theme: { illustrations?: readonly DeckAsset[] | null },
  seed = 0,
): DeckAsset | null | undefined {
  const all = theme.illustrations
  if (!all?.length) return null
  const colored = all.filter((a) => !/cinza|gray/i.test(a.label || ''))
  const pool = colored.length ? colored : all
  return pool[seed % pool.length]
}
