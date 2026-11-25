// Pure helpers behind the admin Models table and the Design system tabs.
// Everything here derives from data the API already returns: no new server
// field, no sample data.

export type PriceSource = 'negotiated' | 'list' | 'none'

interface PriceFields {
  priceIn?: number | null
  priceOut?: number | null
  inferredPriceIn?: number | null
  inferredPriceOut?: number | null
}

/**
 * Where a model's price comes from. A typed override is the organisation's own
 * (negotiated) price; otherwise the curated list price that ships with the app;
 * otherwise nothing is known (an image model, or an endpoint without a price).
 */
export function priceSourceOf(ep: PriceFields): PriceSource {
  if (ep.priceIn != null || ep.priceOut != null) return 'negotiated'
  if (ep.inferredPriceIn != null || ep.inferredPriceOut != null) return 'list'
  return 'none'
}

export const isHex = (v: string | null | undefined): boolean => /^#[0-9a-fA-F]{6}$/.test(v || '')

interface ChartSource {
  primaryColor?: string
  secondaryColor?: string
  accentColor?: string
  backgroundColor?: string
  palette?: { varName?: string; name?: string; value?: string }[]
}

const CHART_TOKEN = /chart|series|categor|data-?\d|viz/i
const MAX_CHART_COLORS = 8

/**
 * The colours a design system gives charts: palette tokens whose name says
 * chart / series come first (in file order), then the brand's primary,
 * secondary and accent. Invalid values and case-insensitive duplicates are
 * dropped; the background colour is never a series colour. Empty when the
 * design system carries nothing usable.
 */
export function chartColorsOf(template: ChartSource | null | undefined): string[] {
  if (!template) return []
  const tokens = (template.palette || [])
    .filter((p) => CHART_TOKEN.test(`${p.varName || ''} ${p.name || ''}`))
    .map((p) => p.value)
  const core = [template.primaryColor, template.secondaryColor, template.accentColor]
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of [...tokens, ...core]) {
    if (!v || !isHex(v)) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length === MAX_CHART_COLORS) break
  }
  return out
}
