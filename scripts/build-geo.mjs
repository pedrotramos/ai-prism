// GeoJSON -> a geo set (shared/geoTypes.ts) for the `map` chart kind.
//
//   node scripts/build-geo.mjs <input.geojson> --id my-regions --name "My regions" \
//        [--id-prop code] [--name-prop name] [--aliases aliases.json] \
//        [--projection equirect|mercator] [--width 1000] [--decimals 0] [--tolerance 0.8] \
//        [--bbox lonMin,latMin,lonMax,latMax] [--ts shared/geo/myRegions.ts | --json out.json]
//
// Each feature becomes one region: its code (`--id-prop`, or the feature id) and
// name (`--name-prop`) plus the aliases listed for that code in the optional
// `--aliases` file ({ "BR": ["Brasil", "BRA"] }). Polygons are projected into one
// viewBox, ring points closer than `--tolerance` px to the last kept point are
// dropped, and the result is written as a TS module (bundled with the app) or as
// a .json file an operator drops into GEO_DATA_DIR. See docs/charts-geo.md.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const input = args[0] && !args[0].startsWith('--') ? args.shift() : null
const opt = {}
for (let i = 0; i < args.length; i += 2) opt[String(args[i]).replace(/^--/, '')] = args[i + 1]
if (!input || !opt.id || !opt.name || !(opt.ts || opt.json)) {
  console.error('usage: node scripts/build-geo.mjs <input.geojson> --id <slug> --name <label> (--ts <file.ts> | --json <file.json>) [options]')
  process.exit(2)
}

const geo = JSON.parse(readFileSync(input, 'utf8'))
const aliases = opt.aliases ? JSON.parse(readFileSync(opt.aliases, 'utf8')) : {}
const decimals = Number(opt.decimals ?? 0)
const tolerance = Number(opt.tolerance ?? 0.8)
const W = Number(opt.width ?? 1000)
const mercator = opt.projection === 'mercator'
const features = (geo.features ?? []).filter((f) => f?.geometry)

const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [])
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360))
const yOf = mercator ? mercY : (lat) => lat

let box = opt.bbox ? opt.bbox.split(',').map(Number) : null
if (!box) {
  box = [Infinity, Infinity, -Infinity, -Infinity]
  for (const f of features) for (const poly of polys(f.geometry)) for (const [lon, lat] of poly[0] ?? []) {
    box = [Math.min(box[0], lon), Math.min(box[1], lat), Math.max(box[2], lon), Math.max(box[3], lat)]
  }
}
const [lonMin, latMin, lonMax, latMax] = box
const yTop = yOf(latMax)
const yBottom = yOf(latMin)
const scaleX = W / (lonMax - lonMin)
const scaleY = mercator ? W / (((lonMax - lonMin) * Math.PI) / 180) : scaleX
const H = Math.round(mercator ? scaleY * (yTop - yBottom) : (yTop - yBottom) * scaleX)
const px = (lon) => (lon - lonMin) * scaleX
const py = (lat) => (yTop - yOf(lat)) * (mercator ? scaleY : scaleX)
const num = (n) => String(Number(n.toFixed(decimals)))

// A ring that crosses the antimeridian jumps ~360 degrees between two points
// and would be drawn as a line across the whole map. On a world-wide box the
// ring is unwrapped (continuous longitudes) and clipped to [-180, 180] in its
// three copies (-360, 0, +360), so each side of the cut becomes its own shape.
const WORLD = box[2] - box[0] >= 359
function unwrap(coords) {
  let prev = null
  return coords.map(([lon, lat]) => {
    let l = lon
    if (prev != null) {
      while (l - prev > 180) l -= 360
      while (prev - l > 180) l += 360
    }
    prev = l
    return [l, lat]
  })
}
function clipLon(pts, min, max) {
  const side = (a, b, inside, cut) => {
    const out = []
    for (let i = 0; i < a.length; i++) {
      const p = a[i]
      const q = a[(i + 1) % a.length]
      const pin = inside(p)
      const qin = inside(q)
      if (pin) out.push(p)
      if (pin !== qin) {
        const t = (cut - p[0]) / (q[0] - p[0])
        out.push([cut, p[1] + t * (q[1] - p[1])])
      }
    }
    return out
  }
  return side(side(pts, null, (p) => p[0] >= min, min), null, (p) => p[0] <= max, max)
}
function rings(coords) {
  if (!WORLD) return [coords]
  const flat = unwrap(coords)
  return [-360, 0, 360]
    .map((shift) => clipLon(flat.map(([lon, lat]) => [lon + shift, lat]), -180, 180))
    .filter((r) => r.length >= 3)
}

function ring(coords) {
  let d = ''
  let kept = 0
  let lx = 0
  let ly = 0
  coords.forEach(([lon, lat], i) => {
    const x = px(lon)
    const y = py(lat)
    if (kept && i !== coords.length - 1 && Math.hypot(x - lx, y - ly) < tolerance) return
    d += `${kept ? 'L' : 'M'}${num(x)} ${num(y)}`
    lx = x
    ly = y
    kept++
  })
  return kept >= 3 ? `${d}Z` : ''
}

const regions = []
for (const f of features) {
  const id = String(opt['id-prop'] ? f.properties?.[opt['id-prop']] : (f.id ?? f.properties?.id) ?? '').trim().toUpperCase()
  const name = String((opt['name-prop'] && f.properties?.[opt['name-prop']]) || f.properties?.name || id).trim()
  const d = polys(f.geometry).map((p) => p.map((r) => rings(r).map(ring).join('')).join('')).join('')
  if (!id || !d) continue
  regions.push({ id, name, ...(aliases[id]?.length ? { aliases: aliases[id] } : {}), d })
}
const set = { id: opt.id, name: opt.name, viewBox: [W, H], regions }

if (opt.json) writeFileSync(opt.json, JSON.stringify(set))
if (opt.ts) {
  const rel = path.relative(path.dirname(opt.ts), 'shared/geoTypes.ts').replace(/\\/g, '/')
  writeFileSync(
    opt.ts,
    `// Generated by scripts/build-geo.mjs (${path.basename(input)}); do not edit by hand. See docs/charts-geo.md.\n` +
      `import type { GeoSet } from '${rel.startsWith('.') ? rel : `./${rel}`}'\n\nconst geo: GeoSet = ${JSON.stringify(set)}\n\nexport default geo\n`
  )
}
console.log(`[build-geo] ${set.id}: ${regions.length} regions, viewBox ${W}x${H}, ${Math.round(JSON.stringify(set).length / 1024)} KB`)
