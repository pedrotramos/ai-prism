// Design-system BUNDLE importer (Claude Design folder/zip exports) — no React,
// no UI, browser + Node testable like pptxMining.ts. A bundle is the folder a
// design tool exports: `_ds_manifest.json`, `README.md`, a tokens CSS, `fonts/
// *.ttf`, `assets/**` (SVG icons/lockups/illustrations + PNG backgrounds) and
// HTML specimen cards (`preview/`, `slides/`, `templates/`). The .pptx miner
// (pptxMining.ts) reverse-engineers identity from painted slides; this module
// reads the identity the design system DECLARES, which is strictly richer:
// full named palette, self-hosted fonts, brand voice rules, and curated
// vector illustrations that generated covers/sections can reuse as-is.

import { collectExternalRefs } from './dsExternalRefs.ts'
import type { ExternalRef } from './dsExternalRefs.ts'

// ---- entry normalization --------------------------------------------------
// Everything downstream works on a flat list of { path, text(), bytes() }
// with bundle-root-relative posix paths, so zip files, directory picks and
// drag-and-dropped folders all import identically.

/** A bundle file: bundle-root-relative posix path + lazy readers. */
interface Entry {
  path: string
  text: () => Promise<string>
  bytes: () => Promise<Uint8Array>
}

type AssetKind = 'icon' | 'lockup' | 'illustration' | 'background' | 'image'

interface ManifestToken { kind?: string; name?: string; value?: string }
interface ManifestFont { family: string; weight?: string | number; style?: string; files?: string[] }
interface Manifest {
  namespace?: string
  globalCssPaths?: string[]
  tokens?: ManifestToken[]
  fonts?: ManifestFont[]
  brandFonts?: { family?: string }[]
  cards?: { path: string; group?: string }[]
  templates?: { entryPath?: string; name?: string; folder?: string; description?: string }[]
}

interface PaletteColor { varName: string; name: string; value: string }
interface FontAsset { family: string; weight: string; style: string; dataUrl: string }
interface IconAsset { id: string; kind: AssetKind; label: string; dataUrl: string; sourcePath: string; tone?: 'dark' }
interface DsCard { id: string; group: string; title: string; description: string; html: string }
interface PathReason { path: string; reason: string }

/** What the importer decided, for the review form. Never persisted. */
interface ImportReport {
  manifestFound: boolean
  manifestError: string
  paletteSource: string
  paletteCount: number
  fontCount: number
  fontsSkipped: PathReason[]
  readmeFound: boolean
  readmeChars: number
  brandRulesChars: number
  cardCount: number
  cardsSkipped: PathReason[]
  counts: Record<AssetKind, number> | null
  catchAllImages: string[]
  skippedAssets: PathReason[]
  /** http(s) refs kept in the kit's CSS/cards: blocked at render time (CSP + sanitizer). */
  externalRefs: ExternalRef[]
}

interface DsImportResult {
  _importReport: ImportReport
  name: string
  backgroundColor?: string
  primaryColor?: string
  accentColor?: string
  secondaryColor?: string
  headingFont?: string
  bodyFont?: string
  logoDataUrl: string
  logoLightDataUrl: string
  readme: string
  brandRules: string
  palette: PaletteColor[]
  fontAssets: FontAsset[]
  dsCards: DsCard[]
  iconAssets: IconAsset[]
  styleNotes: string
}

interface FamilyVariant { path: string; file: string; kind: AssetKind; score: number; tone: 'light' | 'dark' }

type DownscaleImage = (dataUrl: string, maxW?: number, quality?: number) => Promise<string | null>

/** Everything the card inliner needs from the bundle. */
interface CardCtx {
  cssByPath: Map<string, string>
  readText: (p: string) => Promise<string | null>
  readDataUrl: (p: string) => Promise<string | null>
  cardImageDataUrl: (p: string, opts?: { background?: boolean }) => Promise<string | null>
}

const ROOT_MARKERS = ['_ds_manifest.json', 'colors_and_type.css', 'README.md']

function stripRoot(paths: string[]): string {
  // find the shallowest dir containing a root marker; return its prefix
  let best: string | null = null
  for (const marker of ROOT_MARKERS) {
    for (const p of paths) {
      if (p === marker || p.endsWith('/' + marker)) {
        const prefix = p === marker ? '' : p.slice(0, -marker.length)
        if (best == null || prefix.split('/').length < best.split('/').length) best = prefix
      }
    }
    if (best != null) break
  }
  return best ?? ''
}

export async function entriesFromZip(file: Blob | ArrayBuffer | Uint8Array): Promise<Entry[]> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(file)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir)
  const prefix = stripRoot(names)
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({
      path: n.slice(prefix.length),
      text: () => zip.files[n]!.async('text'),
      bytes: () => zip.files[n]!.async('uint8array'),
    }))
}

export function entriesFromFileList(files: ArrayLike<File>): Entry[] {
  const list = Array.from(files)
  const paths = list.map((f) => f.webkitRelativePath || f.name)
  const prefix = stripRoot(paths)
  return list
    .map((f, i) => ({ path: paths[i]!, file: f }))
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({
      path: e.path.slice(prefix.length),
      text: () => e.file.text(),
      bytes: async () => new Uint8Array(await e.file.arrayBuffer()),
    }))
}

/** True when a set of relative paths looks like a design-system bundle. */
export function isDesignSystemBundle(paths: string[]): boolean {
  const set = paths.map((p) => p.split('/').pop())
  return set.includes('_ds_manifest.json') || (set.includes('README.md') && set.includes('colors_and_type.css'))
}

// ---- small helpers ---------------------------------------------------------

const b64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]) // apply() takes a number[]; a Uint8Array is array-like at runtime
  return btoa(bin)
}

const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }
const extOf = (p: string | null | undefined): string => (/\.([a-z0-9]+)$/i.exec(p || '')?.[1] || '').toLowerCase()

async function toDataUrl(entry: Entry): Promise<string> {
  const bytes = await entry.bytes()
  const mime = MIME[extOf(entry.path)] || 'application/octet-stream'
  return `data:${mime};base64,${b64(bytes)}`
}

function hexLum(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}
function hexSat(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

// "unity-catalog-icon-full-color" → "Unity Catalog"; camelCase namespaces split too
function humanize(name: string): string {
  return name
    .replace(/\.(svg|png|jpe?g|gif|webp|html)$/i, '')
    // prefix-style families ("primary-icon-lakeflow-jobs-orange") name the
    // product AFTER the marker — pull it forward before suffix stripping
    .replace(/^(?:primary|secondary)-icon-(.+?)(?:-(?:navy|orange|white|black|gray))?$/i, '$1')
    .replace(/-(icon|lockup|logo)(-.*)?$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim()
}

// ---- palette / tokens -------------------------------------------------------

const HEX_RE = /^#?[0-9a-f]{6}$/i
const normHex = (v: string): string => '#' + v.replace('#', '').toUpperCase()

function paletteFromManifest(manifest: Manifest | null): PaletteColor[] {
  const tokens = (manifest?.tokens || []).filter((t) => t.kind === 'color' && HEX_RE.test(String(t.value || '').trim()))
  return tokens.map((t) => ({
    varName: t.name || '',
    name: humanize(String(t.name || '').replace(/^--/, '').replace(/^[a-z]{1,4}-/, '')),
    value: normHex(String(t.value).trim()),
  }))
}

function paletteFromCss(css: string): PaletteColor[] {
  const out: PaletteColor[] = []
  const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    out.push({ varName: m[1]!, name: humanize(m[1]!.replace(/^--/, '').replace(/^[a-z]{1,4}-/, '')), value: normHex(m[2]!) })
  }
  return out
}

// Map the declared palette onto the 4 theme slots the renderer consumes.
// Name hints first (bundles name their tokens meaningfully), value heuristics
// as fallback — always user-editable afterwards in the template form.
function pickThemeColors(palette: PaletteColor[]): { background: string | undefined; primary: string | undefined; accent: string | undefined; secondary: string | undefined } {
  const find = (re: RegExp, pred: (v: string) => boolean = () => true): string | undefined => palette.find((t) => re.test(t.varName) && pred(t.value))?.value
  const light = (v: string): boolean => hexLum(v) > 0.8
  const dark = (v: string): boolean => hexLum(v) < 0.35
  const byLum = [...palette].sort((a, b) => hexLum(a.value) - hexLum(b.value))
  const background =
    find(/(oat|bg|background|paper|surface)[-\w]*light|light[-\w]*(bg|background)/i, light) ||
    find(/(oat|bg|background|paper|surface|white)/i, light) ||
    byLum[byLum.length - 1]?.value
  const primary =
    find(/(navy|primary|brand)[-\w]*$/i, dark) ||
    find(/(ink|navy|primary|dark)/i, dark) ||
    byLum[0]?.value
  const saturated = palette
    .filter((t) => hexSat(t.value) > 0.55 && hexLum(t.value) > 0.25 && hexLum(t.value) < 0.75 && t.value !== primary)
    .sort((a, b) => hexSat(b.value) - hexSat(a.value))
  const accent = find(/(lava|accent|cta)[-\w]*$/i) || saturated[0]?.value
  const secondary = find(/(coral|secondary)[-\w]*$/i) || saturated.find((t) => t.value !== accent)?.value
  return { background, primary, accent, secondary }
}

// ---- README → model-facing brand rules --------------------------------------

// The README is the same context a human designer reads: voice, casing,
// color/type rules. The full text is stored for the viewer; the model gets a
// condensed cut (headline sections only) so every deck turn carries the brand
// rules without ballooning the prompt.
const RULE_SECTIONS = /content fundamentals|visual foundations|iconography|quick reference|voice|tone/i

export function condenseReadme(readme: string | null | undefined, cap = 3800): string {
  if (!readme) return ''
  const lines = readme.split('\n')
  const kept: string[] = []
  let keep = false
  for (const line of lines) {
    const h = /^#{1,3}\s+(.*)/.exec(line)
    if (h) keep = RULE_SECTIONS.test(h[1]!)
    if (keep) kept.push(line)
  }
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!out) out = readme.slice(0, 2000)
  return out.length > cap ? out.slice(0, cap) + '…' : out
}

// ---- brand asset classification ---------------------------------------------

const ASSET_CAPS: Record<AssetKind, number> = { icon: 48, lockup: 24, illustration: 16, background: 12, image: 16 }
const ASSET_MAX_B64: Record<AssetKind, number> = { icon: 400_000, lockup: 400_000, illustration: 700_000, background: 2_400_000, image: 900_000 }
// full-bleed backgrounds ship as multi-MB PNGs; a 1440px JPEG keeps them
// visually identical on a 10in slide while cutting the template payload ~10×
const BACKGROUND_MAX_W = 1440
const DOWNSCALE_OVER_B64 = 450_000

// Browser default for opts.downscaleImage — Node callers (QA harness) get
// null and keep originals under the per-kind byte caps instead.
function browserDownscale(dataUrl: string, maxW = BACKGROUND_MAX_W, quality = 0.82): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return new Promise<string | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxW / (img.width || maxW))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round((img.width || maxW) * scale)
      canvas.height = Math.round((img.height || maxW) * scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function classifyBrandAsset(path: string): AssetKind | null {
  const file = path.split('/').pop()!.toLowerCase()
  const ext = extOf(file)
  if (!MIME[ext] || ext === 'ttf' || ext === 'otf' || ext === 'woff' || ext === 'woff2') return null
  if (/illustration|nodal/.test(file)) return 'illustration'
  if (/(^|-)bg[-_]|background|bg-pattern|industry-/.test(file)) return 'background'
  if (/lockup/.test(file)) return 'lockup'
  if (/-icon(-|\.)/.test(file)) return 'icon'
  if (/logo|symbol/.test(file)) return 'lockup'
  return 'image'
}

// color/variant suffix tokens a family ships one file each of — stripping them
// yields the product IDENTITY, so all variants of a product collapse to one
// family key. (Order-independent: we strip every occurrence.)
const VARIANT_TOKENS = /(?:-(?:full-color|color|full|primary|secondary|navy|orange|white|black|gray|grey|mono|alt|container|no-db|on-(?:light|dark|navy|white|black)|light|dark|inverse|inverted|reverse|solid|outline))+$/gi

// The product family a brand asset belongs to (kind + identity), used to keep
// exactly ONE canonical asset per family instead of dropping variants by a
// fixed-suffix rule (which lost whole products that never ship the "expected"
// suffix — e.g. a lockup that only exists in -white). Repeatedly strips the
// icon/lockup markers and color/variant tails.
function familyKey(file: string, kind: AssetKind): string {
  let base = file.replace(/\.(svg|png|jpe?g|gif|webp)$/i, '').toLowerCase()
  base = base
    .replace(/^(?:primary|secondary)-icon-/, '')
    // prefix-icon families put the COLOR right after the marker
    // (primary-icon-white-delta-live-tables) — drop a leading color token so
    // all colors of a product collapse to the same family
    .replace(/^(?:full-color|color|navy|orange|white|black|gray|grey|mono)-/, '')
    .replace(/-(icon|lockup|logo|symbol|mark|wordmark)\b/g, '-')
  // strip trailing color/variant tails until stable
  let prev: string
  do { prev = base; base = base.replace(VARIANT_TOKENS, '') } while (base !== prev)
  base = base.replace(/[-_]+/g, '-').replace(/^-|-$/g, '')
  return `${kind}:${base || file.toLowerCase()}`
}

// A variant made for DARK backgrounds (white/inverse/reverse lockups). We keep
// one of these PER FAMILY too, tagged tone:'dark', so covers/dividers on a dark
// plate have the right asset — dropping them entirely (as the first fix did)
// would leave dark slides with an invisible or wrong-color logo.
function isDarkVariant(file: string): boolean {
  const f = file.toLowerCase()
  return /-(white|inverse|inverted|reverse|on-(?:dark|navy|black))\b/.test(f) && !/full-color-white/.test(f)
}

// Canonicality score for a variant — higher wins within its TONE bucket. We
// prefer full-color, non-container/alt versions (the everyday asset), but ANY
// variant beats losing the product entirely.
function variantScore(file: string): number {
  const f = file.toLowerCase()
  let s = 0
  if (/full-color/.test(f)) s += 5
  if (/-orange\b/.test(f)) s += 3 // brand accent (prefix icon families)
  if (/-navy\b/.test(f) && !/-navy-alt/.test(f)) s += 2
  if (!/-(alt|container|no-db)/.test(f)) s += 2
  if (/-(alt|container)\b/.test(f)) s -= 3
  return s
}

function labelFor(file: string, kind: AssetKind): string {
  const base = humanize(file.split('/').pop()!)
  if (kind === 'illustration') {
    const n = /nodal-([\d]+)/.exec(file)?.[1]
    const gray = /gray/.test(file) ? ' (cinza)' : ''
    return n ? `Ilustração nodal ${n}${gray}` : `Ilustração — ${base}`
  }
  if (kind === 'lockup') return `${base} (lockup)`
  if (kind === 'background') return `Fundo — ${base}`
  return base
}

// ---- HTML specimen cards ----------------------------------------------------

// After inlining, cards embed their referenced rasters as data-URLs. Rich
// template/slide specimens (architecture diagrams, event covers) legitimately
// reference several logos/backgrounds, so the ceiling has to clear a card that
// inlines a handful of downscaled PNGs — the old 600KB cap silently dropped
// exactly those richest cards (2 of 4 templates, the lakehouse/arch slides).
// Heavy rasters are downscaled inline (see inlineCardHtml) so this rarely bites.
// Matches the server's per-card persistence cap (see validateTemplatePayload).
// Tokens/fonts are NOT baked per-card — they're reconstructed from the
// template's palette + fontAssets and injected into each iframe at render time
// (see DeckTemplateInspector), so a card is just its own markup + inlined art.
const CARD_MAX_HTML = 2_600_000
const CARDS_TOTAL_BUDGET = 24_000_000
// raster (png/jpg) refs inside a card larger than this get downscaled to a
// screen-resolution JPEG before inlining — a specimen preview never needs a
// full-res product screenshot, and one 447KB PNG referenced 3× was ~2MB alone.
// Template/slide backgrounds render on the large featured canvas, so they get a
// higher width/quality ceiling than incidental product screenshots (the design
// system has to look crisp — a pixelated cover discredits the whole preview).
const CARD_IMG_DOWNSCALE_OVER = 60_000
const CARD_IMG_MAX_W = 900
const CARD_BG_MAX_W = 1600
const CARD_BG_QUALITY = 0.9

// Resolves a relative asset reference (./foo, ../bar) against a directory,
// walking `../` up the path. Shared by the card HTML and CSS inliners.
function resolveRelative(dir: string, ref: string): string {
  let p = ref.replace(/^\.\//, '')
  let d = dir
  while (p.startsWith('../')) {
    p = p.slice(3)
    d = d.replace(/[^/]+\/$/, '')
  }
  return d + p
}

// Rewrites a specimen card into a fully self-contained document: static
// stylesheet links are inlined, scripts are inlined, and relative asset
// references become data URLs. The design TOKENS are NOT baked in here — some
// cards (templates, via ds-base.js) load them at runtime through a JS-created
// <link> this static pass can't see, and inlining the full token CSS + fonts
// into every one of ~60 cards both bloats each past the persistence limit and
// duplicates ~1MB of fonts N times. Instead the tokens are reconstructed from
// the template's palette + fontAssets and injected into each card's iframe at
// render time (see DeckTemplateInspector), which also repairs templates saved
// before this fix without a reimport.
async function inlineCardHtml(html: string, cardPath: string, ctx: CardCtx): Promise<string> {
  const dir = cardPath.includes('/') ? cardPath.slice(0, cardPath.lastIndexOf('/') + 1) : ''
  const resolve = (ref: string): string => resolveRelative(dir, ref)

  let out = html
  // stylesheet links → inline <style>
  out = await replaceAsync(out, /<link[^>]+rel=["']stylesheet["'][^>]*>/gi, async (tag) => {
    const href = /href=["']([^"']+)["']/.exec(tag)?.[1]
    if (!href || /^https?:/.test(href)) return ''
    const resolved = resolve(href)
    const css = ctx.cssByPath.get(resolved) ?? (await ctx.readText(resolved))
    return css != null ? `<style>${css}</style>` : ''
  })
  // scripts → inline. The HTML parser ends a <script> at the first literal
  // "</script" in its text, so any such sequence inside the JS body (e.g. a
  // "</script>" in a doc comment, as deck-stage.js has) would truncate the
  // element and dump the rest of the file as visible page text — the custom
  // element then never registers and `:not(:defined)` hides the real slide.
  // Escaping it to "<\/script" is inert inside JS strings/comments/regex.
  out = await replaceAsync(out, /<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, async (tag, src) => {
    if (/^https?:/.test(src)) return ''
    const js = await ctx.readText(resolve(src))
    return js != null ? `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>` : ''
  })
  // img/src + inline url(...) asset references → data URLs. Heavy rasters are
  // downscaled to a screen-res JPEG (cardImageDataUrl) so a specimen embedding
  // several product screenshots doesn't blow the per-card ceiling; the result
  // is memoized per path, so the same asset referenced N times inlines once.
  out = await replaceAsync(out, /(src|href)=["']([^"']+\.(?:svg|png|jpe?g|gif|webp))["']/gi, async (m, attr, ref) => {
    if (/^(https?:|data:)/.test(ref)) return m
    const url = await ctx.cardImageDataUrl(resolve(ref))
    return url ? `${attr}="${url}"` : m
  })
  // CSS url() refs are almost always full-bleed backgrounds (cover/section/
  // industry photos that fill the slide), so inline them at the higher-quality
  // background tier — a soft, over-compressed cover on the large featured
  // canvas is exactly the "pixelated → discredits the preview" failure.
  out = await replaceAsync(out, /url\((['"]?)([^'")]+\.(?:svg|png|jpe?g|gif|webp|ttf|otf|woff2?))\1\)/gi, async (m, q, ref) => {
    if (/^(https?:|data:)/.test(ref)) return m
    // Fonts must never touch the raster downscaler — embed the bytes verbatim.
    if (/\.(?:ttf|otf|woff2?)$/i.test(ref)) {
      const font = await ctx.readDataUrl(resolve(ref))
      return font ? `url(${font})` : m
    }
    const url = await ctx.cardImageDataUrl(resolve(ref), { background: true })
    return url ? `url(${url})` : m
  })
  return out
}

async function replaceAsync(str: string, re: RegExp, fn: (...args: string[]) => Promise<string>): Promise<string> {
  const jobs: Promise<string>[] = []
  str.replace(re, (...args: string[]) => {
    jobs.push(fn(...args.slice(0, -2)))
    return ''
  })
  const results = await Promise.all(jobs)
  let i = 0
  return str.replace(re, () => results[i++]!)
}

// ---- main -------------------------------------------------------------------

let dsAssetCounter = 0
const nextId = (prefix: string): string => `${prefix}_ds_${++dsAssetCounter}`

/**
 * Parses a design-system bundle into a deck-template patch (same shape the
 * pptx miner produces, plus the bundle-only fields: readme/brandRules/
 * palette/fontAssets/dsCards and iconAssets kinds illustration/background/
 * lockup). Pure: `entries` come from entriesFromZip/entriesFromFileList.
 */
export async function importDesignSystemBundle(
  entries: Entry[],
  { onProgress, downscaleImage = browserDownscale }: { onProgress?: (msg: string) => void; downscaleImage?: DownscaleImage | null } = {},
): Promise<DsImportResult> {
  const byPath = new Map(entries.map((e) => [e.path, e] as const))
  const readText = async (p: string): Promise<string | null> => {
    try {
      return byPath.has(p) ? await byPath.get(p)!.text() : null
    } catch {
      return null
    }
  }
  const dataUrlCache = new Map<string, string>()
  const readDataUrl = async (p: string): Promise<string | null> => {
    if (!byPath.has(p)) return null
    if (!dataUrlCache.has(p)) dataUrlCache.set(p, await toDataUrl(byPath.get(p)!))
    return dataUrlCache.get(p)!
  }
  const progress = (msg: string): void | undefined => onProgress?.(msg)

  // import report: everything the classifier decided, so the review form can
  // show the user exactly what entered, what was skipped (and why), and which
  // files fell into the generic-'image' catch-all (the usual sign of a
  // misnamed asset). Never persisted — stripped before POST/PATCH.
  const report: ImportReport = {
    manifestFound: false,
    manifestError: '',
    paletteSource: 'none',
    paletteCount: 0,
    fontCount: 0,
    fontsSkipped: [],
    readmeFound: false,
    readmeChars: 0,
    brandRulesChars: 0,
    cardCount: 0,
    cardsSkipped: [],
    counts: null,
    catchAllImages: [],
    skippedAssets: [],
    externalRefs: [],
  }
  const externalSources: string[] = []

  // manifest + tokens css
  let manifest: Manifest | null = null
  try {
    const raw = await readText('_ds_manifest.json')
    if (raw) manifest = JSON.parse(raw)
    report.manifestFound = !!manifest
  } catch (e) {
    manifest = null
    report.manifestError = (e as Error).message || 'JSON inválido'
  }
  const cssPaths = manifest?.globalCssPaths?.length ? manifest.globalCssPaths : ['colors_and_type.css']
  const cssByPath = new Map<string, string>()
  for (const p of cssPaths) {
    const css = await readText(p)
    if (css != null) cssByPath.set(p, css)
  }
  const cssAll = Array.from(cssByPath.values()).join('\n')

  progress('Lendo paleta e tokens…')
  let palette = paletteFromManifest(manifest)
  report.paletteSource = palette.length ? 'manifest' : 'css'
  if (!palette.length) palette = paletteFromCss(cssAll)
  if (!palette.length) report.paletteSource = 'none'
  // dedupe by varName keeping first
  const seenVar = new Set<string>()
  palette = palette.filter((t) => (seenVar.has(t.varName) ? false : (seenVar.add(t.varName), true))).slice(0, 64)
  const themeColors = pickThemeColors(palette)

  // fonts: manifest entries win (they carry family/weight/style), css @font-face fallback
  progress('Carregando fontes…')
  const fontAssets: FontAsset[] = []
  const manifestFonts = manifest?.fonts || []
  for (const f of manifestFonts.slice(0, 16)) {
    const file = f.files?.[0]
    if (!file || !byPath.has(file)) {
      if (file) report.fontsSkipped.push({ path: file, reason: 'arquivo não encontrado no bundle' })
      continue
    }
    const url = await readDataUrl(file)
    if (!url || url.length > 1_500_000) {
      report.fontsSkipped.push({ path: file, reason: 'acima de 1.5MB' })
      continue
    }
    fontAssets.push({ family: f.family, weight: String(f.weight || '400'), style: f.style || 'normal', dataUrl: url })
  }
  if (!fontAssets.length) {
    const faceRe = /@font-face\s*{[^}]*font-family\s*:\s*['"]?([^'";]+)['"]?[^}]*font-weight\s*:\s*(\d+)[^}]*src\s*:\s*url\(['"]?([^'")]+)['"]?\)[^}]*}/gi
    let m: RegExpExecArray | null
    while ((m = faceRe.exec(cssAll)) && fontAssets.length < 16) {
      const url = await readDataUrl(m[3]!)
      if (url && url.length <= 1_500_000) fontAssets.push({ family: m[1]!.trim(), weight: m[2]!, style: /italic/i.test(m[0]) ? 'italic' : 'normal', dataUrl: url })
    }
  }
  const brandFamilies = (manifest?.brandFonts || []).map((f) => f.family).filter(Boolean)
  const mainFamily = brandFamilies[0] || fontAssets[0]?.family || ''

  // readme
  const readme = ((await readText('README.md')) || '').slice(0, 60_000)
  const brandRules = condenseReadme(readme)

  // brand assets
  progress('Importando assets de marca…')
  const assetPaths = entries.filter((e) => e.path.startsWith('assets/')).map((e) => e.path)
  const counts: Record<AssetKind, number> = { icon: 0, lockup: 0, illustration: 0, background: 0, image: 0 }
  const iconAssets: IconAsset[] = []
  let logoDataUrl = ''
  let logoLightDataUrl = ''
  // main logo detection (brand-level, not product lockups)
  const logoCandidates = assetPaths
    .filter((p) => /(^|\/)(?:[\w-]*-)?(logo|symbol)[\w-]*\.(svg|png)$/i.test(p) && !/lockup/.test(p))
    // horizontal lockup beats stacked/mono/symbol-only when both exist
    .sort((a, b) => Number(/stacked|mono|symbol/.test(a)) - Number(/stacked|mono|symbol/.test(b)))
  const preferLogo = (re: RegExp): string | undefined => logoCandidates.find((p) => re.test(p.split('/').pop()!))
  const whiteLogo = preferLogo(/logo[\w-]*white(?!-mono)/i) || preferLogo(/white/i)
  const colorLogo = preferLogo(/full-color(?!-white)/i) || logoCandidates[0]
  if (whiteLogo) logoDataUrl = (await readDataUrl(whiteLogo)) || ''
  if (colorLogo) logoLightDataUrl = (await readDataUrl(colorLogo)) || ''
  if (!logoDataUrl) logoDataUrl = logoLightDataUrl

  // PASS 1 — classify every asset and group by product family, keeping the
  // best-scored variant PER TONE (light + dark) per family. This replaces the
  // old fixed-suffix filter that dropped whole products which never shipped the
  // "expected" variant (the report showed 300+ files lost). We keep the dark
  // variant too, because covers/dividers on a dark plate need the white/inverse
  // lockup — but still collapse the 4-6 redundant color/container files to one
  // canonical per tone, so the library stays clean.
  const families = new Map<string, Partial<Record<'light' | 'dark', FamilyVariant>>>() // familyKey → { light?: {…}, dark?: {…} }
  for (const path of assetPaths) {
    const file = path.split('/').pop()!
    if (path === whiteLogo || path === colorLogo) continue
    const kind = classifyBrandAsset(path)
    if (!kind) {
      report.skippedAssets.push({ path, reason: 'extensão não suportada' })
      continue
    }
    // illustrations/backgrounds/images are content, not logo variants — each
    // file is its own family (keep them all, up to the per-kind cap)
    const grouped = kind === 'icon' || kind === 'lockup'
    const key = grouped ? familyKey(file, kind) : `${kind}:${file.toLowerCase()}`
    const tone = grouped && isDarkVariant(file) ? 'dark' : 'light'
    const score = variantScore(file)
    const fam: Partial<Record<'light' | 'dark', FamilyVariant>> = families.get(key) || {}
    const cur = fam[tone]
    if (!cur || score > cur.score) {
      if (cur) report.skippedAssets.push({ path: cur.path, reason: `variante redundante de "${key.split(':')[1]}" (${tone}) — mantida a melhor` })
      fam[tone] = { path, file, kind, score, tone }
      families.set(key, fam)
    } else {
      report.skippedAssets.push({ path, reason: `variante redundante de "${key.split(':')[1]}" (${tone}) — mantida a melhor` })
    }
  }

  // PASS 2 — materialize the chosen canonical assets (data URLs, downscaling,
  // caps). Emit in a stable order (grouped by kind) for a tidy library. A dark
  // variant carries tone:'dark' so the renderer can pick it on dark plates.
  const KIND_ORDER: Record<AssetKind, number> = { icon: 0, lockup: 1, illustration: 2, background: 3, image: 4 }
  const chosen = [...families.values()]
    .flatMap((fam) => [fam.light, fam.dark].filter((v): v is FamilyVariant => !!v))
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.file.localeCompare(b.file))
  for (const { path, file, kind, tone } of chosen) {
    if (counts[kind] >= ASSET_CAPS[kind]) {
      report.skippedAssets.push({ path, reason: `acima do limite de ${ASSET_CAPS[kind]} por tipo (${kind})` })
      continue
    }
    let url = await readDataUrl(path)
    if (!url) continue
    // heavy raster backgrounds/photos → downscaled JPEG (see BACKGROUND_MAX_W)
    if ((kind === 'background' || kind === 'image') && url.length > DOWNSCALE_OVER_B64 && !url.startsWith('data:image/svg') && downscaleImage) {
      url = (await downscaleImage(url)) || url
    }
    if (url.length > ASSET_MAX_B64[kind]) {
      report.skippedAssets.push({ path, reason: 'arquivo grande demais para o tipo' })
      continue
    }
    counts[kind]++
    // 'image' is the catch-all for names no regex recognized — surface these
    // by name so a misnamed icon/background is one glance away from the fix
    if (kind === 'image') report.catchAllImages.push(file)
    iconAssets.push({
      id: nextId(kind), kind, label: labelFor(file, kind), dataUrl: url, sourcePath: path,
      ...(tone === 'dark' ? { tone: 'dark' } : {}),
    })
  }

  // specimen cards (viewer): manifest groups + templates
  progress('Preparando cartões do design system…')
  // card-scoped image resolver: downscales heavy rasters to a screen-res JPEG
  // (SVGs pass through untouched) and memoizes by path, so a 447KB PNG shared
  // by several cards is decoded/inlined once. Falls back to the raw data-URL
  // when no downscaler is available (Node QA) or the image can't be decoded.
  const cardImgCache = new Map<string, string | null>()
  // `background` refs (full-bleed CSS url() covers/industry photos) fill the
  // large featured canvas, so they get a higher width/quality ceiling than
  // incidental <img> screenshots — a 900px/0.8 cover reads as pixelated blown
  // up on the stage. Cache is keyed by path + tier so the same asset used both
  // ways keeps each rendition.
  const cardImageDataUrl = async (p: string, { background = false }: { background?: boolean } = {}): Promise<string | null> => {
    const key = background ? `bg:${p}` : p
    if (cardImgCache.has(key)) return cardImgCache.get(key)!
    let url = await readDataUrl(p)
    const maxW = background ? CARD_BG_MAX_W : CARD_IMG_MAX_W
    const quality = background ? CARD_BG_QUALITY : 0.8
    if (url && downscaleImage && !url.startsWith('data:image/svg') && url.length > CARD_IMG_DOWNSCALE_OVER) {
      url = (await downscaleImage(url, maxW, quality)) || url
    }
    cardImgCache.set(key, url)
    return url
  }
  const ctx: CardCtx = { cssByPath, readText, readDataUrl, cardImageDataUrl }
  const dsCards: DsCard[] = []
  let cardsBudget = CARDS_TOTAL_BUDGET
  const pushCard = async (group: string, title: string, path: string, description = ''): Promise<void> => {
    if (cardsBudget <= 0) {
      report.cardsSkipped.push({ path, reason: `orçamento total de cartões esgotado (${Math.round(CARDS_TOTAL_BUDGET / 1e6)}MB)` })
      return
    }
    const raw = await readText(path)
    if (raw == null) {
      report.cardsSkipped.push({ path, reason: 'arquivo não encontrado no bundle' })
      return
    }
    externalSources.push(raw)
    let html: string
    try {
      html = await inlineCardHtml(raw, path, ctx)
    } catch {
      report.cardsSkipped.push({ path, reason: 'falha ao processar o HTML' })
      return
    }
    if (html.length > CARD_MAX_HTML || html.length > cardsBudget) {
      report.cardsSkipped.push({ path, reason: `cartão acima de ${(CARD_MAX_HTML / 1e6).toFixed(1)}MB (após inline dos assets)` })
      return
    }
    cardsBudget -= html.length
    dsCards.push({ id: nextId('card'), group, title, description, html })
  }
  for (const card of manifest?.cards || []) {
    const title = humanize(card.path.split('/').pop()!)
    await pushCard(card.group || 'Outros', title, card.path)
  }
  for (const tpl of manifest?.templates || []) {
    if (tpl.entryPath) await pushCard('Templates', tpl.name || humanize(tpl.folder || tpl.entryPath), tpl.entryPath, tpl.description || '')
  }

  const name = manifest?.namespace
    ? humanize(manifest.namespace.replace(/_[0-9a-f]{4,}$/i, ''))
    : humanize((entries[0]?.path.split('/')[0] || 'Design System'))

  report.paletteCount = palette.length
  report.fontCount = fontAssets.length
  report.readmeFound = !!readme
  report.readmeChars = readme.length
  report.brandRulesChars = brandRules.length
  report.cardCount = dsCards.length
  report.counts = counts
  report.externalRefs = collectExternalRefs([...cssByPath.values(), ...externalSources])

  return {
    _importReport: report,
    name,
    ...(themeColors.background ? { backgroundColor: themeColors.background } : {}),
    ...(themeColors.primary ? { primaryColor: themeColors.primary } : {}),
    ...(themeColors.accent ? { accentColor: themeColors.accent } : {}),
    ...(themeColors.secondary ? { secondaryColor: themeColors.secondary } : {}),
    ...(mainFamily ? { headingFont: mainFamily, bodyFont: mainFamily } : {}),
    logoDataUrl,
    logoLightDataUrl,
    readme,
    brandRules,
    palette,
    fontAssets,
    dsCards,
    iconAssets,
    styleNotes: '',
  }
}
