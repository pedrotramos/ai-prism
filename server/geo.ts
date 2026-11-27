// Geo sets for the `map` chart kind: the ones that ship (shared/geo) plus any
// the operator drops into GEO_DATA_DIR as <id>.json (shape: shared/geoTypes.ts,
// produced by scripts/build-geo.mjs). Loaded once, synchronously, so the chart
// candidate builder (analysis.ts) can match a column's values against them.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN_GEO_SETS } from '../shared/geo/index.ts'
import { matchGeoSet, parseGeoSet } from '../shared/geoTypes.ts'
import type { GeoMatch, GeoSet } from '../shared/geoTypes.ts'
import { logger } from './log.ts'

const MAX_FILE_BYTES = 6 * 1024 * 1024
const MAX_EXTRA_SETS = 20

let cache: GeoSet[] | null = null

/** Extra sets from `dir` (best effort: a bad file is logged and skipped, never fatal). */
export function loadExtraGeoSets(dir: string): GeoSet[] {
  const out: GeoSet[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    logger.warn('GEO_DATA_DIR is not readable; no extra geo sets loaded')
    return out
  }
  for (const f of files.slice(0, MAX_EXTRA_SETS)) {
    try {
      const file = path.join(dir, f)
      if (statSync(file).size > MAX_FILE_BYTES) throw new Error('file too large')
      const set = parseGeoSet(JSON.parse(readFileSync(file, 'utf8')))
      if (!set) throw new Error('not a valid geo set')
      out.push(set)
    } catch (err) {
      logger.warn(`geo set ${f} skipped: ${(err as Error).message}`)
    }
  }
  return out
}

/** Every geo set, bundled first: an extra set can add regions but never replaces a bundled id. */
export function listGeoSets(): GeoSet[] {
  if (cache) return cache
  const sets = [...BUILTIN_GEO_SETS]
  const dir = process.env.GEO_DATA_DIR?.trim()
  if (dir) for (const s of loadExtraGeoSets(dir)) if (!sets.some((x) => x.id === s.id)) sets.push(s)
  cache = sets
  return sets
}

export function getGeoSet(id: unknown): GeoSet | null {
  return typeof id === 'string' ? (listGeoSets().find((s) => s.id === id) ?? null) : null
}

/** The set that best names `labels` (one set when `geo` is given and it matches well enough). */
export function matchGeo(labels: string[], geo?: string): GeoMatch | null {
  const all = listGeoSets()
  const named = geo ? getGeoSet(geo) : null
  if (named) {
    const m = matchGeoSet(labels, [named], { minCoverage: 0.5, minRegions: 2 })
    if (m) return m
  }
  return matchGeoSet(labels, all)
}

/** Test hook: forget the loaded sets so GEO_DATA_DIR is read again. */
export function resetGeoCache(): void {
  cache = null
}
