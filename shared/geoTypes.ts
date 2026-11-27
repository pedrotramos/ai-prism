// Geo data behind the `map` chart kind (choropleth by region). A geo set is a
// list of regions already projected into one SVG viewBox, so the client and the
// server render the same shapes with no map library and no projection maths at
// paint time. The sets that ship are in shared/geo/; an operator adds more with
// `scripts/build-geo.mjs` and GEO_DATA_DIR (docs/charts-geo.md).

export interface GeoRegion {
  /** Stable code the data refers to (ISO 3166-1 alpha-2, a state code, ...). Upper case. */
  id: string
  /** Display name, in the set's main language. */
  name: string
  /** Other names and codes that resolve to this region (other languages, alpha-3, ...). */
  aliases?: string[]
  /** SVG path data in viewBox coordinates. */
  d: string
}

export interface GeoSet {
  /** Lower-case slug; what a `map` block's `geo` field names. */
  id: string
  /** Label of the set (en). */
  name: string
  /** [width, height] of the SVG viewBox every region path is drawn in. */
  viewBox: [number, number]
  regions: GeoRegion[]
}

export const MAX_GEO_REGIONS = 400
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * Validates an untrusted geo set (a GEO_DATA_DIR file). Returns null when the
 * shape is unusable; a region without a path is dropped, never repaired.
 */
export function parseGeoSet(raw: unknown): GeoSet | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ID_RE.test(r.id) || typeof r.name !== 'string') return null
  const vb = r.viewBox
  if (!Array.isArray(vb) || vb.length !== 2) return null
  const w = Number(vb[0])
  const h = Number(vb[1])
  if (!(w > 0 && h > 0 && w <= 10000 && h <= 10000)) return null
  if (!Array.isArray(r.regions)) return null
  const regions: GeoRegion[] = []
  for (const x of r.regions.slice(0, MAX_GEO_REGIONS)) {
    if (!x || typeof x !== 'object') continue
    const g = x as Record<string, unknown>
    if (typeof g.id !== 'string' || typeof g.name !== 'string' || typeof g.d !== 'string') continue
    // path data only: commands, numbers, separators — nothing that could carry markup
    if (!g.d || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/.test(g.d)) continue
    const region: GeoRegion = { id: g.id.trim().toUpperCase().slice(0, 40), name: g.name.slice(0, 80), d: g.d }
    if (Array.isArray(g.aliases)) region.aliases = g.aliases.filter((a): a is string => typeof a === 'string').slice(0, 12).map((a) => a.slice(0, 80))
    if (region.id) regions.push(region)
  }
  if (regions.length < 2) return null
  return { id: r.id, name: r.name.slice(0, 80), viewBox: [w, h], regions }
}

/** Lower-case, accent-free, alphanumeric-only key a region label is matched by. */
export function geoKey(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
}

/** label → region id for every id, name and alias of a set. First writer wins (ids before names). */
export function geoIndex(set: GeoSet): Map<string, string> {
  const idx = new Map<string, string>()
  for (const r of set.regions) if (!idx.has(geoKey(r.id))) idx.set(geoKey(r.id), r.id)
  for (const r of set.regions) {
    for (const label of [r.name, ...(r.aliases ?? [])]) {
      const k = geoKey(label)
      if (k && !idx.has(k)) idx.set(k, r.id)
    }
  }
  return idx
}

export interface GeoMatch {
  set: GeoSet
  /** matched region id per input label (null when the label is not a region) */
  ids: (string | null)[]
  /** share of the labels that resolved, 0..1 */
  coverage: number
}

/**
 * The geo set whose regions the labels best name, or null when none reaches
 * `minCoverage` of the labels (and at least `minRegions` distinct regions).
 * A tie keeps the set listed first.
 */
export function matchGeoSet(labels: string[], sets: GeoSet[], { minCoverage = 0.7, minRegions = 3 } = {}): GeoMatch | null {
  const usable = labels.filter((l) => geoKey(l))
  if (usable.length < minRegions) return null
  let best: GeoMatch | null = null
  for (const set of sets) {
    const idx = geoIndex(set)
    const ids = labels.map((l) => idx.get(geoKey(l)) ?? null)
    const hit = ids.filter((x): x is string => x != null)
    if (new Set(hit).size < minRegions) continue
    const coverage = hit.length / usable.length
    if (coverage >= minCoverage && (!best || coverage > best.coverage)) best = { set, ids, coverage }
  }
  return best
}
