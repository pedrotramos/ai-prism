// Copies the files the chart rasteriser reads at runtime next to the server
// bundle: the resvg WebAssembly (MPL-2.0, ~2.5 MB) and the Inter fonts (OFL).
// They are files rather than bundled code, and server-dist stays flat (the boot
// test checks it), so the fonts are named Inter-<weight>.ttf at the top level.
// server/chartRaster.ts logs CHART_RASTER_UNAVAILABLE at startup when they are missing.
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// keep in step with server/chartRaster.ts (NODE_MODULES_ASSETS, WASM_FILE, FONT_FILES)
export const ASSETS = [
  ['node_modules/@resvg/resvg-wasm/index_bg.wasm', 'resvg.wasm'],
  ['node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf', 'Inter-Regular.ttf'],
  ['node_modules/@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf', 'Inter-SemiBold.ttf'],
  ['node_modules/@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf', 'Inter-Bold.ttf'],
]

/** Copies the assets into `outdir`; returns the names written. A missing source is skipped with a warning. */
export function copyServerAssets(outdir) {
  const written = []
  for (const [from, to] of ASSETS) {
    const src = path.join(root, from)
    if (!existsSync(src)) {
      console.warn(`[copy-server-assets] ${from} not found (run npm ci): charts will not be rasterised`)
      continue
    }
    copyFileSync(src, path.join(outdir, to))
    written.push(to)
  }
  return written
}
