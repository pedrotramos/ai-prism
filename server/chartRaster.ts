// A chart block → PNG, on the server, with @resvg/resvg-wasm (WebAssembly: no
// native binary, no network) and the Inter font of the design system. It is the
// image of a chart inside a deck slide (PPTX export reads data: PNGs) and inside
// a DOCX. The SVG comes from chartSvg.ts.
//
// The .wasm and the fonts are files, not bundled code: `npm run bundle` copies
// them next to the server bundle (scripts/copy-server-assets.mjs) and, in
// development, they are read from node_modules. When they are missing the
// raster is unavailable (rasterAvailable() is false) and callers fall back to
// text — a chart image is an enhancement, never a reason to fail an answer.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { chartSvg, FIGURE_SIZE } from './chartSvg.ts'
import type { ChartLike, SvgOptions } from './chartSvg.ts'

export const RASTER_WIDTH = 1600 // twice the drawing's width: sharp on a slide and in print
export const WASM_FILE = 'resvg.wasm'
export const FONT_FILES = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf']
// where `npm run bundle` finds them in node_modules (scripts/copy-server-assets.mjs)
export const NODE_MODULES_ASSETS = {
  wasm: 'node_modules/@resvg/resvg-wasm/index_bg.wasm',
  fonts: [
    'node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf',
    'node_modules/@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf',
    'node_modules/@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf',
  ],
}

function baseDir(): string {
  // bundled (server-dist/): __dirname; ESM dev: this file's folder (server/)
  if (typeof __dirname !== 'undefined') return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}

const firstExisting = (list: string[]): string | undefined => list.find((p) => existsSync(p))

/** Where the wasm and the fonts are; `dir` forces a folder (a bundle, in the QA). */
export function rasterAssetPaths(dir?: string): { wasm: string | undefined; fonts: string[] } {
  if (dir) return { wasm: path.join(dir, WASM_FILE), fonts: FONT_FILES.map((f) => path.join(dir, f)) }
  const roots = [baseDir(), path.join(baseDir(), '..'), process.cwd(), path.join(process.cwd(), 'server-dist')]
  const wasm = firstExisting([
    ...roots.map((r) => path.join(r, WASM_FILE)),
    ...roots.map((r) => path.join(r, NODE_MODULES_ASSETS.wasm)),
  ])
  const fonts = FONT_FILES.map((f, i) => firstExisting([...roots.map((r) => path.join(r, f)), ...roots.map((r) => path.join(r, NODE_MODULES_ASSETS.fonts[i] as string))]))
  return { wasm, fonts: fonts.filter((f): f is string => !!f) }
}

let ready: Promise<void> | null = null
let fontBuffers: Uint8Array[] = []

/** Initialises the wasm once per process (resvg-wasm accepts a single initWasm). */
export function initRaster(dir?: string): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const { wasm, fonts } = rasterAssetPaths(dir)
      if (!wasm || !existsSync(wasm)) throw new Error('resvg.wasm not found')
      await initWasm(readFileSync(wasm))
      fontBuffers = fonts.filter((f) => existsSync(f)).map((f) => new Uint8Array(readFileSync(f)))
      if (!fontBuffers.length) throw new Error('Inter fonts not found')
    })()
    ready.catch(() => (ready = null))
  }
  return ready
}

/** True when the wasm and at least one font can be found (no initialisation). */
export function rasterAvailable(dir?: string): boolean {
  const { wasm, fonts } = rasterAssetPaths(dir)
  return !!wasm && existsSync(wasm) && fonts.length > 0
}

/** SVG → PNG with `width` px of width. */
export async function rasterizeSvg(svg: string, { width = RASTER_WIDTH, dir }: { width?: number; dir?: string } = {}): Promise<Buffer> {
  await initRaster(dir)
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: '#FFFFFF',
    font: { fontBuffers, defaultFontFamily: 'Inter', sansSerifFamily: 'Inter', loadSystemFonts: false },
  })
  const img = r.render()
  const png = Buffer.from(img.asPng())
  img.free()
  r.free()
  return png
}

// recent PNGs by SVG content: a Studio asks for the same figure on every open
const cache = new Map<string, Buffer>()
const CACHE_MAX = 64

/** The PNG of a chart block, or null when the block is not a figure. */
export async function chartPng(block: ChartLike, opts: SvgOptions & { dir?: string } = {}): Promise<Buffer | null> {
  const svg = chartSvg(block, { width: FIGURE_SIZE.width, height: FIGURE_SIZE.height, ...opts })
  if (!svg) return null
  const hit = cache.get(svg)
  if (hit) return hit
  const png = await rasterizeSvg(svg, opts.dir ? { dir: opts.dir } : {})
  cache.set(svg, png)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return png
}

/** Width and height of a PNG, read from its IHDR; null when it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}
