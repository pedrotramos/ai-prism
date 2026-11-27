// The geo sets that ship with the app. A deployment adds its own with
// GEO_DATA_DIR (server/geo.ts) — see docs/charts-geo.md.
import type { GeoSet } from '../geoTypes.ts'
import worldCountries from './worldCountries.ts'
import brStates from './brStates.ts'

/** Generic world map (ISO 3166-1 alpha-2 codes, en/pt/es names) and an example region set (Brazil, by state). */
export const BUILTIN_GEO_SETS: GeoSet[] = [worldCountries, brStates]
