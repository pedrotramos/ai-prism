// chartSvg draws every figure kind from the block's own series, in the AI Prism
// light tokens; chartRaster turns it into a real PNG with the wasm engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chartSvg } from './chartSvg.ts'
import { chartPng, pngSize, rasterAvailable, RASTER_WIDTH } from './chartRaster.ts'
import { EXPORT_THEME } from '../shared/chartTheme.ts'

const pts = (rows: [string, number | null][]) => rows.map(([label, value]) => ({ label, value }))
const BLOCKS = {
  bar: { chartType: 'bar', title: 'Revenue by region', series: [{ name: 'Revenue', data: pts([['North', 120], ['South', 98], ['East', 75]]) }] },
  hbar: { chartType: 'bar', title: 'Many', series: [{ name: 'A', data: pts(Array.from({ length: 9 }, (_, i) => [`S${i}`, i + 1] as [string, number])) }] },
  line: { chartType: 'line', title: 'Trend', series: [{ name: '2024', data: pts([['Jan', 1], ['Feb', null], ['Mar', 3]]) }, { name: '2025', data: pts([['Jan', 2], ['Feb', 3], ['Mar', 5]]) }] },
  area: { chartType: 'area', title: 'Area', series: [{ name: 'x', data: pts([['a', 1], ['b', 4]]) }] },
  pie: { chartType: 'pie', title: 'Pie', series: [{ name: 'x', data: pts([['a', 3], ['b', 1]]) }] },
  donut: { chartType: 'donut', title: 'Share <by> "channel"', series: [{ name: 'Revenue', data: pts([['Online', 60], ['Stores', 30], ['Other', 10]]) }] },
  histogram: { chartType: 'histogram', title: 'Dist', series: [{ name: 'x', data: pts([['0–1', 3], ['1–2', 7]]) }] },
  scatter: { chartType: 'scatter', title: 'XY', xLabel: 'a', yLabel: 'b', series: [{ name: 'g', data: [{ label: '', x: 1, y: 2 }, { label: '', x: 3, y: 5 }] }] },
  heatmap: { chartType: 'heatmap', title: 'Heat', series: [{ name: 'c1', data: pts([['r1', 1], ['r2', null]]) }, { name: 'c2', data: pts([['r1', 5], ['r2', 9]]) }] },
  map: { chartType: 'map', geo: 'world-countries', title: 'Map', series: [{ name: 'Sales', data: pts([['Brazil', 10], ['Germany', 40], ['India', 25], ['Chile', null]]) }] },
}

test('every figure kind yields a self-contained svg using only the AI Prism light tokens', () => {
  const allowed = new Set([...EXPORT_THEME.series, EXPORT_THEME.bg, EXPORT_THEME.text, EXPORT_THEME.muted, EXPORT_THEME.faint, EXPORT_THEME.border, EXPORT_THEME.empty, EXPORT_THEME.neutral, 'none'])
  for (const [name, block] of Object.entries(BLOCKS)) {
    const svg = chartSvg(block)
    assert.ok(svg, name)
    assert.match(svg, /^<svg [^>]*viewBox="0 0 800 450"[^>]*>.*<\/svg>$/s, name)
    assert.ok(!/<script|javascript:|on\w+=/i.test(svg), `${name}: no active content`)
    const fills = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6}|none)"/g)].map((m) => m[1] as string)
    // colours are tokens, or a mix along the token ramp (heatmap / map shades)
    const strays = fills.filter((c) => !allowed.has(c))
    if (name !== 'heatmap' && name !== 'map') assert.deepEqual(strays, [], name)
    assert.ok(!/natura|#04241a|#eb6619/i.test(svg), `${name}: no foreign palette`)
  }
})

test('text is escaped, a donut carries the total and the shares, a pivot is not a figure', () => {
  const svg = chartSvg(BLOCKS.donut) as string
  assert.match(svg, /Share &lt;by&gt; &quot;channel&quot;/)
  assert.match(svg, />100<\/text>/, 'total in the centre')
  for (const pct of ['60%', '30%', '10%']) assert.ok(svg.includes(`>${pct}<`), pct)
  assert.equal(chartSvg({ chartType: 'pivot', series: BLOCKS.heatmap.series }), null)
  assert.equal(chartSvg({ chartType: 'bar', series: [] }), null)
  assert.equal(chartSvg({ chartType: 'donut', series: [{ name: 'x', data: pts([['a', 0], ['b', -2]]) }] }), null)
})

test('a map paints the regions that have a value and leaves the rest as "no data"', () => {
  const svg = chartSvg(BLOCKS.map) as string
  const noData = (svg.match(new RegExp(`fill="${EXPORT_THEME.empty}"`, 'g')) ?? []).length
  const regions = (svg.match(/<path d="M/g) ?? []).length
  assert.ok(regions > 150, 'every region is drawn')
  assert.ok(noData > regions - 5 && noData < regions, 'only the three valued countries are shaded')
  assert.equal(chartSvg({ ...BLOCKS.map, geo: 'nope', series: [{ name: 'x', data: pts([['zzz', 1]]) }] }), null, 'no geo set, no figure')
})

test('chartPng renders a real PNG at twice the drawing width, and caches it', { skip: !rasterAvailable() && 'resvg wasm / Inter not installed' }, async () => {
  const png = (await chartPng(BLOCKS.donut)) as Buffer
  assert.deepEqual(pngSize(png), { width: RASTER_WIDTH, height: 900 })
  assert.equal(await chartPng(BLOCKS.donut), png, 'same SVG, same buffer')
  const map = (await chartPng(BLOCKS.map)) as Buffer
  assert.ok(map.length > 20_000, 'a map is a real picture, not a blank')
  assert.equal(await chartPng({ chartType: 'pivot', series: [] }), null)
  assert.equal(pngSize(Buffer.from('not a png at all, really not!')), null)
})
