// Pure design-system mining/merging logic for deck templates — no React,
// no UI. Everything here runs in the browser (Settings import flow) AND in
// Node (scripts/mine-pptx-qa.mjs, with a DOMParser polyfill), which is what
// keeps the .pptx miner testable without opening the app.

import type JSZip from 'jszip'

type SchemeMap = Record<string, string | undefined>
type Mapper = (v: number) => number

interface IconAsset {
  id: string
  label: string
  dataUrl: string
  kind: string
}
interface MotifShape {
  x: number
  y: number
  w: number
  h: number
  geom: string
  color: string | null
}
interface Motif {
  geom: string
  box: { x: number; y: number; w: number; h: number }
  dotW: number
  shapes: { x: number; y: number; color: string | null }[]
}
interface DiagramShape {
  x: number
  y: number
  w: number
  h: number
  geom: string
  color?: string
  line?: string
  rot?: number
  text?: string
  textColor?: string
  fontPt?: number
  bold?: boolean
}
interface DiagramConnector {
  x: number
  y: number
  w: number
  h: number
  flipH?: boolean
  flipV?: boolean
  arrow?: boolean
  color?: string
}
interface DiagramSpec {
  label: string
  aspect: number
  shapes: DiagramShape[]
  connectors: DiagramConnector[]
  bg?: string
}
interface MinedStyle {
  coverOverlayDataUrl?: string
  sectionPlateDataUrl?: string
  motif?: Motif | null
  diagrams?: (DiagramSpec & { id: string })[]
  headingColor?: string
  titleFont?: string
  titlePt?: number | null
  bodyPt?: number | null
}
interface PreviewSlide {
  background: string | null
  title: string
  bullets: string[]
  imageMediaPath: string | null
}
interface ResolvedPreviewSlide {
  background: string | null
  title: string
  bullets: string[]
  imageDataUrl: string | null
}
interface MediaInfo {
  count: number
  label: string
  widthIn: number
  heightIn: number
}
interface Leaf {
  node: Element
  spPr: Element
  isConnector: boolean
  prst: string
  x: number
  y: number
  w: number
  h: number
  flipH: boolean
  flipV: boolean
  rot: number
}
interface Template {
  name: string
  primaryColor: string
  secondaryColor: string
  accentColor: string
  backgroundColor: string
  headingFont: string
  bodyFont: string
  logoDataUrl: string
  styleNotes: string
  iconAssets: IconAsset[]
  previewSlides: ResolvedPreviewSlide[]
  coverPlateDataUrl: string
  minedStyle: MinedStyle | null
  logoLightDataUrl: string
  readme: string
  brandRules: string
  palette: unknown[]
  fontAssets: unknown[]
  dsCards: unknown[]
  _importReport?: unknown
}
type StringTemplateKey =
  | 'primaryColor' | 'secondaryColor' | 'accentColor' | 'backgroundColor' | 'headingFont' | 'bodyFont'
  | 'logoDataUrl' | 'logoLightDataUrl' | 'coverPlateDataUrl' | 'styleNotes' | 'name' | 'readme' | 'brandRules'

export const EMPTY_TEMPLATE: Template = {
  name: '',
  primaryColor: '#1A1A2E',
  secondaryColor: '#4A4E69',
  accentColor: '#E63946',
  backgroundColor: '#FFFFFF',
  headingFont: 'Georgia',
  bodyFont: 'Helvetica',
  logoDataUrl: '',
  styleNotes: '',
  iconAssets: [],
  previewSlides: [],
  // full-bleed background photo mined from the template's own cover — when
  // present, generated covers/dividers use it (with a primary-color veil)
  // instead of the flat-color fallback
  coverPlateDataUrl: '',
  // deeper mined identity (overlay layer, section plate, vector motif spec,
  // title ink/typography) — see extractPptxTheme
  minedStyle: null,
  // design-system BUNDLE fields (Claude Design folder/zip exports — see
  // dsImport.ts): declared identity, strictly richer than what the .pptx
  // miner can reverse-engineer
  logoLightDataUrl: '', // full-color logo for light backgrounds (logoDataUrl favors dark covers)
  readme: '', // full README.md (viewer)
  brandRules: '', // condensed voice/visual rules (model prompt)
  palette: [], // [{varName, name, value}] full named color tokens
  fontAssets: [], // [{family, weight, style, dataUrl}] self-hosted webfonts
  dsCards: [], // [{id, group, title, description, html}] specimen cards
}


const DML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PML_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const IMAGE_EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }
const MAX_ICON_ASSETS = 30
const MAX_OTHER_IMAGES = 12
const MAX_PREVIEW_SLIDES = 16
const MAX_PREVIEW_BULLETS = 6
// Per-asset caps, tighter for icons (which are small by definition) than for
// logos/photos — keeps a rich template's whole payload comfortably under the
// server's 15mb JSON body limit (server/index.js) even at MAX_ICON_ASSETS +
// MAX_OTHER_IMAGES.
const ICON_MAX_BASE64_CHARS = 500_000
const IMAGE_MAX_BASE64_CHARS = 2_000_000

function extOf(path: string | null | undefined): string {
  const m = /\.([a-z0-9]+)$/i.exec(path || '')
  return m ? m[1]!.toLowerCase() : ''
}

let iconAssetCounter = 0
function nextAssetId(prefix: string): string {
  iconAssetCounter += 1
  return `${prefix}_${iconAssetCounter}`
}

function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function hexSaturation(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

// A slide's media relationships (r:id -> media path) live in a sibling
// `_rels/slideN.xml.rels` file — targets are relative to `ppt/slides/`, and
// in practice media references always look like `../media/imageN.ext`.
async function loadSlideRels(zip: JSZip, slideNum: number): Promise<Map<string, string>> {
  const file = zip.files[`ppt/slides/_rels/slide${slideNum}.xml.rels`]
  const map = new Map<string, string>()
  if (!file) return map
  const xml = await file.async('text')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (!id || !target) continue
    map.set(id, target.startsWith('../') ? 'ppt/' + target.slice(3) : 'ppt/slides/' + target)
  }
  return map
}

// Tallies which colors/fonts are actually painted on the slides (shape fills
// + slide backgrounds, weighted by shape area) instead of trusting the
// declared OOXML theme — confirmed empirically that real-world decks often
// never touch their theme swatch (theme1.xml ships the generic Office
// palette) while every visible color is hardcoded per-shape via `srgbClr`.
// A full-slide background/rect gets a constant large weight so it always
// outweighs small accent bars or icons, even without exact shape geometry.
//
// Same pass also collects two things the color mining doesn't need but the
// Design System inspector does: real embedded picture assets (candidates for
// the icon library — see buildIconAssets below) and a lightweight per-slide
// text/image summary (previewSlides) so a user can browse "what does this
// template actually look like" without a full pptx-to-image renderer.
// Resolves the theme's scheme-color map (bg1/tx1/accentN → hex) so mined
// shape/text fills declared as <a:schemeClr> get real colors.
async function mineSchemeMap(zip: JSZip): Promise<SchemeMap> {
  const map: SchemeMap = {}
  const themePath = Object.keys(zip.files).find((p) => /ppt\/theme\/theme\d*\.xml$/i.test(p))
  if (!themePath) return map
  try {
    const doc = new DOMParser().parseFromString(await zip.files[themePath]!.async('text'), 'application/xml')
    const read = (tag: string) => {
      const el = doc.getElementsByTagNameNS(DML_NS, tag)[0]
      const srgb = el?.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
      if (srgb) return '#' + srgb.getAttribute('val')!.toUpperCase()
      const sys = el?.getElementsByTagNameNS(DML_NS, 'sysClr')[0]
      return sys?.getAttribute('lastClr') ? '#' + sys.getAttribute('lastClr')!.toUpperCase() : null
    }
    for (const tag of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']) {
      const v = read(tag)
      if (v) map[tag] = v
    }
    // standard clrMap aliases (bg1→lt1 etc.)
    map.bg1 = map.bg1 || map.lt1
    map.tx1 = map.tx1 || map.dk1
    map.bg2 = map.bg2 || map.lt2
    map.tx2 = map.tx2 || map.dk2
  } catch {
    // no scheme resolution — mined fills stay null and get theme fallbacks
  }
  return map
}

function fillHexOf(node: Element, schemeMap: SchemeMap): string | null {
  const solidFill = (Array.from(node.childNodes || []) as Element[]).find((n) => n.localName === 'solidFill')
  if (!solidFill) return null
  const srgb = solidFill.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
  if (srgb) return '#' + srgb.getAttribute('val')!.toUpperCase()
  const scheme = solidFill.getElementsByTagNameNS(DML_NS, 'schemeClr')[0]
  return scheme ? schemeMap[scheme.getAttribute('val')!] || null : null
}

// Shapes styled through <p:style><a:fillRef> (instead of an explicit
// solidFill) carry their color as the fillRef's scheme reference.
function shapeFillHex(sp: Element, spPr: Element, schemeMap: SchemeMap): string | null {
  const direct = fillHexOf(spPr, schemeMap)
  if (direct) return direct
  const fillRef = sp.getElementsByTagNameNS(PML_NS, 'style')[0]?.getElementsByTagNameNS(DML_NS, 'fillRef')[0]
  if (!fillRef) return null
  const srgb = fillRef.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
  if (srgb) return '#' + srgb.getAttribute('val')!.toUpperCase()
  const scheme = fillRef.getElementsByTagNameNS(DML_NS, 'schemeClr')[0]
  return scheme ? schemeMap[scheme.getAttribute('val')!] || null : null
}

// --- diagram mining -------------------------------------------------------
// Complex vector diagrams (architecture boxes, flows, funnels) present on the
// template's own slides are one of its most valuable assets — this captures
// them as a normalized vector spec (shapes + connectors, fractions of the
// slide) that server/decks.js re-draws inside generated slides via
// `diagramRef` (see sanitizeDiagramSpec in server/blocks.js for the shape).
const DIAGRAM_GEOMS = new Set([
  'rect', 'roundRect', 'ellipse', 'diamond', 'triangle', 'hexagon', 'pentagon',
  'chevron', 'homePlate', 'parallelogram', 'trapezoid', 'can', 'cube', 'pie',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow',
])
const CONNECTOR_GEOMS = /^(line|straightConnector\d*|bentConnector\d*|curvedConnector\d*)$/
const MAX_MINED_DIAGRAMS = 8

// Depth-first walk of a slide's shape tree yielding every leaf <p:sp> and
// <p:cxnSp> with its transform composed through nested <p:grpSp> coordinate
// spaces — the same off/ext/chOff/chExt math as the motif miner's
// flattenGroup, but generalized to any shape size and to connectors.
function walkShapeTree(node: Element, mapX: Mapper, mapY: Mapper, sX: number, sY: number, out: Leaf[]): void {
  for (const child of Array.from(node.childNodes || []) as Element[]) {
    if (child.localName === 'grpSp') {
      const grpPr = child.getElementsByTagNameNS(PML_NS, 'grpSpPr')[0]
      const xfrm = grpPr?.getElementsByTagNameNS(DML_NS, 'xfrm')[0]
      const off = xfrm?.getElementsByTagNameNS(DML_NS, 'off')[0]
      const ext = xfrm?.getElementsByTagNameNS(DML_NS, 'ext')[0]
      const chOff = xfrm?.getElementsByTagNameNS(DML_NS, 'chOff')[0]
      const chExt = xfrm?.getElementsByTagNameNS(DML_NS, 'chExt')[0]
      if (!off || !ext || !chOff || !chExt) continue
      const gx = mapX(Number(off.getAttribute('x')) / 914400)
      const gy = mapY(Number(off.getAttribute('y')) / 914400)
      const gw = (Number(ext.getAttribute('cx')) / 914400) * sX
      const gh = (Number(ext.getAttribute('cy')) / 914400) * sY
      const cx0 = Number(chOff.getAttribute('x')) / 914400
      const cy0 = Number(chOff.getAttribute('y')) / 914400
      const cw = Number(chExt.getAttribute('cx')) / 914400 || 1
      const chh = Number(chExt.getAttribute('cy')) / 914400 || 1
      walkShapeTree(child, (v: number) => gx + (v - cx0) * (gw / cw), (v: number) => gy + (v - cy0) * (gh / chh), gw / cw, gh / chh, out)
    } else if (child.localName === 'sp' || child.localName === 'cxnSp') {
      const spPr = child.getElementsByTagNameNS(PML_NS, 'spPr')[0]
      const xfrm = spPr?.getElementsByTagNameNS(DML_NS, 'xfrm')[0]
      const off = xfrm?.getElementsByTagNameNS(DML_NS, 'off')[0]
      const ext = xfrm?.getElementsByTagNameNS(DML_NS, 'ext')[0]
      if (!spPr || !off || !ext) continue
      out.push({
        node: child,
        spPr,
        isConnector: child.localName === 'cxnSp',
        prst: spPr.getElementsByTagNameNS(DML_NS, 'prstGeom')[0]?.getAttribute('prst') || '',
        x: mapX(Number(off.getAttribute('x')) / 914400),
        y: mapY(Number(off.getAttribute('y')) / 914400),
        w: (Number(ext.getAttribute('cx')) / 914400) * sX,
        h: (Number(ext.getAttribute('cy')) / 914400) * sY,
        flipH: xfrm!.getAttribute('flipH') === '1',
        flipV: xfrm!.getAttribute('flipV') === '1',
        rot: xfrm!.getAttribute('rot') ? Math.round(Number(xfrm!.getAttribute('rot')) / 60000) : 0,
      })
    }
  }
}

function lineHexOf(spPr: Element, schemeMap: SchemeMap): string | null {
  const ln = spPr.getElementsByTagNameNS(DML_NS, 'ln')[0]
  return ln ? fillHexOf(ln, schemeMap) : null
}

function shapeTextOf(sp: Element, schemeMap: SchemeMap) {
  const lines: string[] = []
  for (const para of Array.from(sp.getElementsByTagNameNS(DML_NS, 'p'))) {
    const text = Array.from(para.getElementsByTagNameNS(DML_NS, 't')).map((t) => t.textContent).join('').trim()
    if (text) lines.push(text)
  }
  if (!lines.length) return null
  const rPr = sp.getElementsByTagNameNS(DML_NS, 'rPr')[0]
  const fill = rPr && (Array.from(rPr.childNodes) as Element[]).find((n) => n.localName === 'solidFill')
  const srgb = fill?.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
  const scheme = fill?.getElementsByTagNameNS(DML_NS, 'schemeClr')[0]
  return {
    text: lines.join('\n'),
    color: srgb ? '#' + srgb.getAttribute('val')!.toUpperCase() : scheme ? schemeMap[scheme.getAttribute('val')!] || null : null,
    pt: rPr?.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : null,
    bold: rPr?.getAttribute('b') === '1',
  }
}

// A slide "is a diagram" when it carries several mid-size labeled shapes tied
// together by connectors/arrows — the composition is captured whole, in
// z-order, so the re-drawn version keeps the original layering.
export function mineSlideDiagram(
  doc: Document,
  schemeMap: SchemeMap,
  slideWIn: number,
  slideHIn: number,
  title: string | null | undefined,
  slideNum: number,
  slideBg: string | null | undefined
): DiagramSpec | null {
  const leaves: Leaf[] = []
  const spTree = doc.getElementsByTagNameNS(PML_NS, 'spTree')[0]
  if (!spTree) return null
  walkShapeTree(spTree, (v: number) => v, (v: number) => v, 1, 1, leaves)

  const shapes: DiagramShape[] = []
  const connectors: DiagramConnector[] = []
  let arrowCount = 0
  for (const leaf of leaves) {
    if (leaf.isConnector || CONNECTOR_GEOMS.test(leaf.prst)) {
      if (Math.max(leaf.w, leaf.h) < 0.15) continue
      const ln = leaf.spPr.getElementsByTagNameNS(DML_NS, 'ln')[0]
      const hasArrow = !!(ln && (Array.from(ln.childNodes) as Element[]).some(
        (n) => (n.localName === 'tailEnd' || n.localName === 'headEnd') && n.getAttribute('type') && n.getAttribute('type') !== 'none'
      ))
      connectors.push({
        x: leaf.x / slideWIn, y: leaf.y / slideHIn,
        w: leaf.w / slideWIn, h: leaf.h / slideHIn,
        flipH: leaf.flipH || undefined, flipV: leaf.flipV || undefined,
        arrow: hasArrow || undefined,
        color: lineHexOf(leaf.spPr, schemeMap) || undefined,
      })
      continue
    }
    if (!DIAGRAM_GEOMS.has(leaf.prst)) continue
    // skip full-slide background rects and specks
    if (leaf.w >= slideWIn * 0.92 && leaf.h >= slideHIn * 0.92) continue
    if (leaf.w < 0.25 || leaf.h < 0.12) continue
    const fill = shapeFillHex(leaf.node, leaf.spPr, schemeMap)
    const line = lineHexOf(leaf.spPr, schemeMap)
    const txt = shapeTextOf(leaf.node, schemeMap)
    if (!fill && !line && !txt) continue
    // the slide's own title drawn as a loose text box isn't part of the art
    if (txt && !fill && title && txt.text.trim() === title.trim()) continue
    // ghost box: near-white text with no fill/border of its own, floating
    // over nothing — it was designed over some colored area we failed to
    // resolve and would re-draw as unreadable noise on a light background.
    // A white label whose center sits on a dark filled shape already mined
    // (band/chip label layered in z-order) is legitimate and kept.
    if (txt && !fill && !line && txt.color && hexLuminance(txt.color.slice(1)) > 0.8) {
      const bgLum = slideBg ? hexLuminance(slideBg.slice(1)) : 1
      const cx = leaf.x + leaf.w / 2
      const cy = leaf.y + leaf.h / 2
      const onDarkFill = shapes.some(
        (s) =>
          s.color && hexLuminance(s.color.slice(1)) < 0.6 &&
          cx / slideWIn >= s.x && cx / slideWIn <= s.x + s.w &&
          cy / slideHIn >= s.y && cy / slideHIn <= s.y + s.h
      )
      if (bgLum > 0.6 && !onDarkFill) continue
    }
    if (/Arrow$/.test(leaf.prst)) arrowCount++
    const shape: DiagramShape = {
      x: leaf.x / slideWIn, y: leaf.y / slideHIn,
      w: leaf.w / slideWIn, h: leaf.h / slideHIn,
      geom: leaf.prst,
    }
    if (fill) shape.color = fill
    if (line) shape.line = line
    if (leaf.rot) shape.rot = leaf.rot
    if (txt) {
      shape.text = txt.text.slice(0, 120)
      if (txt.color) shape.textColor = txt.color
      // normalize the point size to the 10in render canvas
      if (txt.pt) shape.fontPt = Math.round(txt.pt * (10 / slideWIn) * 10) / 10
      if (txt.bold) shape.bold = true
    }
    shapes.push(shape)
  }

  const labeled = shapes.filter((s) => s.text).length
  // Connectors/arrows are the strongest diagram signal. Without them, plain
  // content slides built from shapes (agendas, card grids, logo walls) would
  // over-trigger — the connectorless path additionally requires NESTED filled
  // structure (bands/chips inside a filled container), the signature of an
  // architecture/containment diagram that plain lists never have.
  const filled = shapes.filter((s) => s.color)
  let nestedFilled = 0
  for (const a of filled) {
    for (const b of filled) {
      if (
        a !== b &&
        a.w * a.h < b.w * b.h * 0.8 &&
        a.x >= b.x - 0.005 && a.y >= b.y - 0.005 &&
        a.x + a.w <= b.x + b.w + 0.005 && a.y + a.h <= b.y + b.h + 0.005
      ) {
        nestedFilled++
        break
      }
    }
  }
  const isDiagram =
    shapes.length >= 4 && shapes.length <= 60 &&
    (connectors.length >= 2 || arrowCount >= 2 ||
      (shapes.length >= 6 && labeled >= 4 && nestedFilled >= 2))
  if (!isDiagram) return null
  const spec: DiagramSpec = {
    label: (title || '').slice(0, 120) || `Diagrama do slide ${slideNum}`,
    aspect: Math.round((slideWIn / slideHIn) * 1000) / 1000,
    shapes: shapes.slice(0, 48),
    connectors: connectors.slice(0, 24),
  }
  // the background the art was designed against — the renderer uses it as the
  // contrast plate when the deck's own background would melt the shapes
  if (slideBg) spec.bg = slideBg
  return spec
}

export async function mineSlideTheme(zip: JSZip, schemeMap: SchemeMap = {}) {
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)![1]) - Number(b.match(/slide(\d+)\.xml/)![1]))
  // slide canvas size (EMU) — used to normalize positions/typography so the
  // mined identity survives the 13.33in→10in canvas difference
  let slideWIn = 13.333
  let slideHIn = 7.5
  try {
    const presXml = await zip.files['ppt/presentation.xml']!.async('text')
    const m = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml)
    if (m) {
      slideWIn = Number(m[1]) / 914400
      slideHIn = Number(m[2]) / 914400
    }
  } catch {
    // keep 16:9 defaults
  }
  const colorWeight = new Map<string, number>()
  const fontCount = new Map<string, number>()
  const titleFontCount = new Map<string, number>()
  const titleColorCount = new Map<string, number>()
  const mediaByPath = new Map<string, MediaInfo>() // path -> {count, label, widthIn, heightIn}
  const previewSlides: PreviewSlide[] = []
  // full-bleed pictures (≥ ~90% of the slide) are the template's own cover/
  // divider background plates — the strongest carrier of its visual identity
  // beyond colors. The cover keeps its stacked layers (photo + gradient/
  // texture overlay); the first LATER, distinct full-bleed becomes the
  // section-divider plate.
  let coverPlatePaths: string[] | null = null // [path, ...] in z-order, from the first slide that has one
  let sectionPlatePath: string | null = null
  // decorative motif: a cluster of ≥8 tiny same-geometry shapes (dot grids,
  // dash rows...) captured as a normalized vector spec so generated decks can
  // reproduce the template's OWN motif — never a stock one (and none at all
  // when the template has none)
  let motif: Motif | null = null
  // complex vector diagrams found on the slides (see mineSlideDiagram)
  const diagrams: DiagramSpec[] = []
  const SLIDE_AREA_WEIGHT = 1e13

  const addColor = (hex: string | null, weight: number) => {
    if (!hex) return
    colorWeight.set(hex, (colorWeight.get(hex) || 0) + weight)
  }

  let slideNum = 0
  for (const path of slidePaths) {
    slideNum++
    const xml = await zip.files[path]!.async('text')
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const relsMap = await loadSlideRels(zip, slideNum)

    let slideBg: string | null = null
    for (const bg of Array.from(doc.getElementsByTagNameNS(PML_NS, 'bg'))) {
      const srgb = bg.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
      if (!srgb) continue
      const hex = '#' + srgb.getAttribute('val')!.toUpperCase()
      addColor(hex, SLIDE_AREA_WEIGHT)
      if (!slideBg) slideBg = hex
    }

    const textShapes: { isTitle: boolean; lines: string[] }[] = []
    const smallShapes: MotifShape[] = [] // motif candidates on this slide
    for (const sp of Array.from(doc.getElementsByTagNameNS(PML_NS, 'sp'))) {
      const spPr = sp.getElementsByTagNameNS(PML_NS, 'spPr')[0]
      let fillHex: string | null = null
      let geomW = 0
      let geomH = 0
      let geomX = 0
      let geomY = 0
      let prst = ''
      if (spPr) {
        // only a direct child solidFill counts as the shape's own fill — a
        // solidFill under <a:ln> is a border color, not the shape's fill
        const solidFill = (Array.from(spPr.childNodes) as Element[]).find((n) => n.localName === 'solidFill')
        const srgb = solidFill?.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
        const ext = spPr.getElementsByTagNameNS(DML_NS, 'ext')[0]
        const off = spPr.getElementsByTagNameNS(DML_NS, 'off')[0]
        geomW = ext ? Number(ext.getAttribute('cx')) / 914400 : 0
        geomH = ext ? Number(ext.getAttribute('cy')) / 914400 : 0
        geomX = off ? Number(off.getAttribute('x')) / 914400 : 0
        geomY = off ? Number(off.getAttribute('y')) / 914400 : 0
        prst = spPr.getElementsByTagNameNS(DML_NS, 'prstGeom')[0]?.getAttribute('prst') || ''
        if (srgb) {
          addColor('#' + srgb.getAttribute('val')!.toUpperCase(), geomW && geomH ? geomW * geomH * 914400 * 914400 : SLIDE_AREA_WEIGHT * 0.01)
        }
        fillHex = fillHexOf(spPr, schemeMap)
      }
      if (
        ['ellipse', 'rect', 'roundRect', 'diamond'].includes(prst) &&
        geomW > 0 && geomW <= 0.25 && geomH > 0 && geomH <= 0.25
      ) {
        smallShapes.push({ x: geomX, y: geomY, w: geomW, h: geomH, geom: prst, color: fillHex })
      }
      const ph = sp.getElementsByTagNameNS(PML_NS, 'ph')[0]
      const phType = ph?.getAttribute('type') || ''
      const isTitle = phType === 'title' || phType === 'ctrTitle'
      if (isTitle) {
        // the template's own title voice: face + explicit run color (dark
        // colors only — white titles on dark slides aren't the "ink" color)
        for (const latin of Array.from(sp.getElementsByTagNameNS(DML_NS, 'latin'))) {
          const tf = latin.getAttribute('typeface')
          if (tf) titleFontCount.set(tf, (titleFontCount.get(tf) || 0) + 1)
        }
        for (const rPr of Array.from(sp.getElementsByTagNameNS(DML_NS, 'rPr'))) {
          const fill = (Array.from(rPr.childNodes) as Element[]).find((n) => n.localName === 'solidFill')
          const srgb = fill?.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
          if (srgb) {
            const hexVal = srgb.getAttribute('val')!.toUpperCase()
            if (hexLuminance(hexVal) < 0.55) titleColorCount.set('#' + hexVal, (titleColorCount.get('#' + hexVal) || 0) + 1)
          }
        }
      }
      const lines: string[] = []
      for (const para of Array.from(sp.getElementsByTagNameNS(DML_NS, 'p'))) {
        const text = Array.from(para.getElementsByTagNameNS(DML_NS, 't')).map((t) => t.textContent).join('').trim()
        if (text) lines.push(text)
      }
      if (lines.length) textShapes.push({ isTitle, lines })
    }

    // decorative motif candidates: PowerPoint decks group these (dot grids,
    // dash rows) in a <p:grpSp> — child coordinates live in the group's own
    // space and are mapped through the group xfrm. Loose (ungrouped) clusters
    // of tiny shapes are the fallback. The largest-area candidate across the
    // earliest slides wins.
    // Fraction of shapes that share a row OR column (within half a dot of
    // tolerance) with at least 2 siblings — 1.0 for a perfect grid, near 0
    // for a random scatter.
    const gridRegularity = (group: MotifShape[]) => {
      const tol = Math.max(group[0]!.w, 0.06)
      const near = (a: number, b: number) => Math.abs(a - b) <= tol
      let aligned = 0
      for (const s of group) {
        const rowMates = group.filter((o) => o !== s && near(o.y, s.y)).length
        const colMates = group.filter((o) => o !== s && near(o.x, s.x)).length
        if (rowMates >= 2 || colMates >= 2) aligned++
      }
      return aligned / group.length
    }
    const groupCandidates: MotifShape[][] = []
    // depth-first flatten of a group tree, composing each nested group's
    // child-space transform so every leaf shape lands in slide coordinates
    const flattenGroup = (grp: Element, mapX: Mapper, mapY: Mapper, sX: number, sY: number): MotifShape[] => {
      const grpPr = grp.getElementsByTagNameNS(PML_NS, 'grpSpPr')[0]
      const xfrm = grpPr?.getElementsByTagNameNS(DML_NS, 'xfrm')[0]
      const off = xfrm?.getElementsByTagNameNS(DML_NS, 'off')[0]
      const ext = xfrm?.getElementsByTagNameNS(DML_NS, 'ext')[0]
      const chOff = xfrm?.getElementsByTagNameNS(DML_NS, 'chOff')[0]
      const chExt = xfrm?.getElementsByTagNameNS(DML_NS, 'chExt')[0]
      if (!off || !ext || !chOff || !chExt) return []
      const gx = mapX(Number(off.getAttribute('x')) / 914400)
      const gy = mapY(Number(off.getAttribute('y')) / 914400)
      const gw = (Number(ext.getAttribute('cx')) / 914400) * sX
      const gh = (Number(ext.getAttribute('cy')) / 914400) * sY
      const cx0 = Number(chOff.getAttribute('x')) / 914400
      const cy0 = Number(chOff.getAttribute('y')) / 914400
      const cw = Number(chExt.getAttribute('cx')) / 914400 || 1
      const chh = Number(chExt.getAttribute('cy')) / 914400 || 1
      const kX: Mapper = (v) => gx + (v - cx0) * (gw / cw)
      const kY: Mapper = (v) => gy + (v - cy0) * (gh / chh)
      const leaves: MotifShape[] = []
      for (const child of Array.from(grp.childNodes) as Element[]) {
        if (child.localName === 'grpSp') {
          leaves.push(...flattenGroup(child, kX, kY, gw / cw, gh / chh))
        } else if (child.localName === 'sp') {
          const spPr = child.getElementsByTagNameNS(PML_NS, 'spPr')[0]
          if (!spPr) continue
          const prst = spPr.getElementsByTagNameNS(DML_NS, 'prstGeom')[0]?.getAttribute('prst') || ''
          if (!['ellipse', 'rect', 'roundRect', 'diamond'].includes(prst)) continue
          const sOff = spPr.getElementsByTagNameNS(DML_NS, 'off')[0]
          const sExt = spPr.getElementsByTagNameNS(DML_NS, 'ext')[0]
          if (!sOff || !sExt) continue
          const w = (Number(sExt.getAttribute('cx')) / 914400) * (gw / cw)
          const h = (Number(sExt.getAttribute('cy')) / 914400) * (gh / chh)
          if (w <= 0 || w > 0.3 || h <= 0 || h > 0.3) continue
          leaves.push({
            x: kX(Number(sOff.getAttribute('x')) / 914400),
            y: kY(Number(sOff.getAttribute('y')) / 914400),
            w, h, geom: prst,
            color: shapeFillHex(child, spPr, schemeMap),
          })
        }
      }
      return leaves
    }
    const spTree = doc.getElementsByTagNameNS(PML_NS, 'spTree')[0]
    for (const child of Array.from(spTree?.childNodes || []) as Element[]) {
      if (child.localName !== 'grpSp') continue
      // keep only the dominant geometry inside the group (a dot grid often
      // ships with one stray bar/label shape)
      const leaves = flattenGroup(child, (v) => v, (v) => v, 1, 1)
      const byGeom = new Map<string, MotifShape[]>()
      for (const l of leaves) byGeom.set(l.geom, [...(byGeom.get(l.geom) || []), l])
      const main = Array.from(byGeom.values()).sort((a, b) => b.length - a.length)[0]
      if (main && main.length >= 8) groupCandidates.push(main)
    }
    if (smallShapes.length >= 8) groupCandidates.push(smallShapes)
    if (!motif) {
      let best: { group: MotifShape[]; minX: number; minY: number; boxW: number; boxH: number } | null = null
      let bestArea = 0
      for (const group of groupCandidates) {
        const minX = Math.min(...group.map((s) => s.x))
        const minY = Math.min(...group.map((s) => s.y))
        const boxW = Math.max(...group.map((s) => s.x + s.w)) - minX
        const boxH = Math.max(...group.map((s) => s.y + s.h)) - minY
        if (boxW > slideWIn * 0.55 || boxH > slideHIn * 0.8) continue
        // a real decorative motif (dot grid, dash row) is REGULAR: most
        // shapes share a row or column with others. A loose scatter of
        // small marks (stray bullets, legend chips, decoration debris)
        // isn't — re-drawing it on generated covers reads as random
        // confetti, strictly worse than no motif at all.
        if (gridRegularity(group) < 0.6) continue
        if (boxW * boxH > bestArea) {
          bestArea = boxW * boxH
          best = { group, minX, minY, boxW, boxH }
        }
      }
      if (best) {
        motif = {
          geom: best.group[0]!.geom,
          // motif box as fractions of the slide, shapes as fractions of the box
          box: { x: best.minX / slideWIn, y: best.minY / slideHIn, w: best.boxW / slideWIn, h: best.boxH / slideHIn },
          dotW: best.group[0]!.w / slideWIn,
          shapes: best.group.slice(0, 120).map((s) => ({
            x: best.boxW > 0 ? (s.x - best.minX) / best.boxW : 0,
            y: best.boxH > 0 ? (s.y - best.minY) / best.boxH : 0,
            color: s.color,
          })),
        }
      }
    }

    for (const latin of Array.from(doc.getElementsByTagNameNS(DML_NS, 'latin'))) {
      const tf = latin.getAttribute('typeface')
      if (tf) fontCount.set(tf, (fontCount.get(tf) || 0) + 1)
    }

    const slidePics: { mediaPath: string; widthIn: number; heightIn: number }[] = []
    const fullBleeds: string[] = []
    for (const pic of Array.from(doc.getElementsByTagNameNS(PML_NS, 'pic'))) {
      const blip = pic.getElementsByTagNameNS(DML_NS, 'blip')[0]
      const embedId = blip?.getAttributeNS(R_NS, 'embed')
      const mediaPath = embedId ? relsMap.get(embedId) : null
      if (!mediaPath || !zip.files[mediaPath]) continue
      if (!IMAGE_EXT_MIME[extOf(mediaPath)]) continue // skip emf/wmf — don't render in <img>/pptxgenjs
      const cNvPr = pic.getElementsByTagNameNS(PML_NS, 'cNvPr')[0]
      const label = (cNvPr?.getAttribute('descr') || cNvPr?.getAttribute('name') || '').trim()
      const spPr = pic.getElementsByTagNameNS(PML_NS, 'spPr')[0]
      const extEl = spPr?.getElementsByTagNameNS(DML_NS, 'ext')[0]
      const widthIn = extEl ? Number(extEl.getAttribute('cx')) / 914400 : 0
      const heightIn = extEl ? Number(extEl.getAttribute('cy')) / 914400 : 0
      slidePics.push({ mediaPath, widthIn, heightIn })
      if (widthIn >= slideWIn * 0.85 && heightIn >= slideHIn * 0.85) fullBleeds.push(mediaPath)

      const existing = mediaByPath.get(mediaPath)
      if (existing) {
        existing.count++
        if (!existing.label && label) existing.label = label
      } else {
        mediaByPath.set(mediaPath, { count: 1, label, widthIn, heightIn })
      }
    }

    if (fullBleeds.length) {
      if (!coverPlatePaths) coverPlatePaths = fullBleeds.slice(0, 2)
      else if (!sectionPlatePath && !coverPlatePaths.includes(fullBleeds[0]!)) sectionPlatePath = fullBleeds[0]!
    }

    const slideTitleShape = textShapes.find((s) => s.isTitle) || textShapes[0]
    const slideTitle = slideTitleShape?.lines[0] || ''

    if (diagrams.length < MAX_MINED_DIAGRAMS) {
      const diagram = mineSlideDiagram(doc, schemeMap, slideWIn, slideHIn, slideTitle, slideNum, slideBg)
      if (diagram) diagrams.push(diagram)
    }

    if (previewSlides.length < MAX_PREVIEW_SLIDES) {
      const titleShape = slideTitleShape
      const title = slideTitle
      const bullets = []
      for (const shape of textShapes) {
        if (shape === titleShape) continue
        bullets.push(...shape.lines)
      }
      // the largest picture that isn't itself icon-sized becomes this
      // slide's representative image in the preview
      const bigPic = slidePics
        .filter((p) => Math.max(p.widthIn, p.heightIn) > 1.8)
        .sort((a, b) => b.widthIn * b.heightIn - a.widthIn * a.heightIn)[0]
      if (title || bullets.length || bigPic) {
        previewSlides.push({
          background: slideBg,
          title: title.slice(0, 140),
          bullets: bullets.slice(0, MAX_PREVIEW_BULLETS).map((b) => b.slice(0, 160)),
          imageMediaPath: bigPic?.mediaPath || null,
        })
      }
    }
  }

  return {
    colorWeight,
    fontCount,
    titleFontCount,
    titleColorCount,
    mediaByPath,
    previewSlides,
    slideCount: slidePaths.length,
    coverPlatePaths,
    sectionPlatePath,
    motif,
    diagrams,
    slideWIn,
  }
}

// The declared master typography (title/body point sizes, title face and
// ink) carries the template's typographic "personality" — sizes normalized
// by the source slide width so they transfer to any canvas size.
async function mineMasterTypography(zip: JSZip, slideWIn: number, schemeMap: SchemeMap = {}) {
  const masterPath = Object.keys(zip.files).find((p) => /ppt\/slideMasters\/slideMaster1\.xml$/i.test(p))
  if (!masterPath) return null
  try {
    const xml = await zip.files[masterPath]!.async('text')
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const lvl1DefRPr = (tag: string) => {
      const style = doc.getElementsByTagNameNS(PML_NS, tag)[0]
      const lvl1 = style?.getElementsByTagNameNS(DML_NS, 'lvl1pPr')[0]
      return lvl1?.getElementsByTagNameNS(DML_NS, 'defRPr')[0] || null
    }
    const titleRPr = lvl1DefRPr('titleStyle')
    const bodyRPr = lvl1DefRPr('bodyStyle')
    const sz = (rPr: Element | null) => (rPr?.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : null)
    const titlePt = sz(titleRPr)
    const norm = 10 / (slideWIn || 13.333) // rescale to the 10in render canvas
    const titleColor = titleRPr ? fillHexOf(titleRPr, schemeMap) : null
    const titleFont = titleRPr?.getElementsByTagNameNS(DML_NS, 'latin')[0]?.getAttribute('typeface') || null
    return {
      titlePt: titlePt ? titlePt * norm : null,
      bodyPt: sz(bodyRPr) ? sz(bodyRPr)! * norm : null,
      titleColor: titleColor && hexLuminance(titleColor.slice(1)) < 0.55 ? titleColor : null,
      titleFont: titleFont && !titleFont.startsWith('+') ? titleFont : null,
    }
  } catch {
    return null
  }
}

async function mediaDataUrl(zip: JSZip, path: string, maxChars = IMAGE_MAX_BASE64_CHARS): Promise<string | null> {
  const mime = IMAGE_EXT_MIME[extOf(path)]
  if (!mime) return null
  const base64 = await zip.files[path]!.async('base64')
  if (base64.length > maxChars) return null // skip oversized embeds (rare — a full photo/background)
  return `data:${mime};base64,${base64}`
}

// Near-square and small (icon-sized) embeds become pickable icons for
// `iconRef` (see server/blocks.js); anything bigger/more rectangular is kept
// only for the Design System inspector's "Ícones e imagens" gallery, tagged
// `kind: 'image'` so the model never picks a logo/photo as a card icon.
// Second signal: media reused on a large share of the slides is a watermark/
// footer logo (a brand mark, not a reusable concept icon) no matter how
// icon-sized it is — a real concept icon shows up on a handful of slides,
// a logo shows up on nearly all of them. Watermarks get their own kind so
// they are NEVER offered to the model (neither as `iconRef` nor `imageRef`)
// — a generated deck must never carry a watermark (see isModelUsableAsset in
// server/blocks.js); they stay visible in the Design System inspector only.
export function classifyMedia(entry: { count: number; widthIn: number; heightIn: number }, slideCount: number): 'watermark' | 'icon' | 'image' {
  if (slideCount >= 5 && entry.count / slideCount > 0.4) return 'watermark'
  const maxSide = Math.max(entry.widthIn, entry.heightIn)
  const minSide = Math.min(entry.widthIn, entry.heightIn) || 0.001
  return maxSide > 0 && maxSide <= 1.6 && maxSide / minSide <= 1.8 ? 'icon' : 'image'
}

// Reused media (the same file referenced across many slides — a logo
// watermark, a recurring bullet icon) is a strong signal of "real brand
// asset" vs. a one-off illustration, so assets are ranked by reuse count
// before the icon/image caps are applied.
async function buildIconAssets(zip: JSZip, mediaByPath: Map<string, MediaInfo>, slideCount: number): Promise<IconAsset[]> {
  // PowerPoint dedupes a reused image into a single media file, but decks
  // written by other tools embed one copy per slide — merge identical
  // content first so the reuse count (the watermark signal, classifyMedia)
  // reflects how often the IMAGE appears, not how many files carry it.
  const byContent = new Map<string, MediaInfo & { path: string }>()
  for (const [path, info] of mediaByPath.entries()) {
    let key = path
    try {
      key = extOf(path) + ':' + (await zip.files[path]!.async('base64'))
    } catch {
      // unreadable entry — fall back to path identity
    }
    const cur = byContent.get(key)
    if (cur) {
      cur.count += info.count
      if (!cur.label && info.label) cur.label = info.label
    } else {
      byContent.set(key, { path, ...info })
    }
  }
  const entries = Array.from(byContent.values())
    .map((info) => ({ ...info, kind: classifyMedia(info, slideCount) }))
    .sort((a, b) => b.count - a.count)

  const toAsset = async (entry: MediaInfo & { path: string; kind: string }): Promise<IconAsset | null> => {
    const cap = entry.kind === 'icon' ? ICON_MAX_BASE64_CHARS : IMAGE_MAX_BASE64_CHARS
    const dataUrl = await mediaDataUrl(zip, entry.path, cap)
    if (!dataUrl) return null
    return { id: nextAssetId(entry.kind), label: entry.label || '', dataUrl, kind: entry.kind }
  }

  const icons = entries.filter((e) => e.kind === 'icon').slice(0, MAX_ICON_ASSETS)
  const images = entries.filter((e) => e.kind === 'image').slice(0, MAX_OTHER_IMAGES)
  const watermarks = entries.filter((e) => e.kind === 'watermark').slice(0, 6)
  const assets = await Promise.all([...icons, ...images, ...watermarks].map(toAsset))
  return assets.filter((a): a is IconAsset => Boolean(a))
}

async function resolvePreviewSlides(zip: JSZip, previewSlides: PreviewSlide[]): Promise<ResolvedPreviewSlide[]> {
  return Promise.all(
    previewSlides.map(async ({ imageMediaPath, ...rest }) => ({
      ...rest,
      imageDataUrl: imageMediaPath ? await mediaDataUrl(zip, imageMediaPath) : null,
    }))
  )
}

// Turns the raw color/font tallies into a template — background is the
// heaviest light color seen, primary the heaviest remaining color, accent
// the next reasonably saturated one (skips flat grays when a real hue is
// available), secondary whatever's left. Not exact, but a much closer guess
// than the declared theme — and the caller always reviews before saving.
function pickTheme(colorWeight: Map<string, number>, fontCount: Map<string, number>, fallback: Template) {
  const entries = Array.from(colorWeight.entries()).sort((a, b) => b[1] - a[1])
  if (!entries.length) return null

  const backgroundEntry = entries.find(([hex]) => hexLuminance(hex.slice(1)) > 0.82)
  const background = backgroundEntry?.[0] || fallback.backgroundColor

  const rest = entries.filter(([hex]) => hex !== background)
  const primary = rest[0]?.[0] || fallback.primaryColor

  const restAfterPrimary = rest.filter(([hex]) => hex !== primary)
  const saturated = restAfterPrimary.filter(([hex]) => hexSaturation(hex.slice(1)) > 0.25)
  const accent = (saturated[0] || restAfterPrimary[0])?.[0] || fallback.accentColor

  const restAfterAccent = restAfterPrimary.filter(([hex]) => hex !== accent)
  const secondary = restAfterAccent[0]?.[0] || fallback.secondaryColor

  const font = Array.from(fontCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0]

  return {
    backgroundColor: background,
    primaryColor: primary,
    accentColor: accent,
    secondaryColor: secondary,
    headingFont: font || fallback.headingFont,
    bodyFont: font || fallback.bodyFont,
  }
}

// OOXML themes don't always carry brand-accurate colors — this is
// best-effort extraction (mined from what's actually on the slides, see
// mineSlideTheme/pickTheme above), always followed by a review step before
// saving, never a blind trust-and-save. Exported for the visual QA harness
// (scripts/render-deck-preview.mjs flow) — the app itself only uses it via
// the import button below.
export async function extractPptxTheme(file: Blob | ArrayBuffer): Promise<Partial<Template>> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(file)

  const schemeMap = await mineSchemeMap(zip)
  const {
    colorWeight, fontCount, titleFontCount, titleColorCount, mediaByPath, previewSlides,
    slideCount, coverPlatePaths, sectionPlatePath, motif, diagrams, slideWIn,
  } = await mineSlideTheme(zip, schemeMap)
  const [iconAssets, resolvedPreviewSlides, coverPlateDataUrl, coverOverlayDataUrl, sectionPlateDataUrl, typography] =
    await Promise.all([
      buildIconAssets(zip, mediaByPath, slideCount),
      resolvePreviewSlides(zip, previewSlides),
      coverPlatePaths?.[0] ? mediaDataUrl(zip, coverPlatePaths[0], 4_000_000) : null,
      coverPlatePaths?.[1] ? mediaDataUrl(zip, coverPlatePaths[1], 4_000_000) : null,
      sectionPlatePath ? mediaDataUrl(zip, sectionPlatePath, 4_000_000) : null,
      mineMasterTypography(zip, slideWIn, schemeMap),
    ])
  const topOf = (map: Map<string, number>) => Array.from(map.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  const extras = {
    iconAssets,
    previewSlides: resolvedPreviewSlides,
    coverPlateDataUrl: coverPlateDataUrl || '',
    // everything below is the template's own visual identity beyond the four
    // colors — consumed by resolveTheme in server/decks.js and the preview.
    // Per-slide explicit runs win over the master declaration (they're what
    // the deck actually shows); the master fills the gaps.
    minedStyle: {
      coverOverlayDataUrl: coverOverlayDataUrl || '',
      sectionPlateDataUrl: sectionPlateDataUrl || '',
      motif: motif || null,
      // mined vector diagrams, id'd so the model can reference them via
      // `diagramRef` (see templateHint in server/blocks.js)
      diagrams: (diagrams || []).map((d, i) => ({ id: `diag_${i + 1}`, ...d })),
      headingColor: topOf(titleColorCount) || typography?.titleColor || '',
      titleFont: topOf(titleFontCount) || typography?.titleFont || '',
      titlePt: typography?.titlePt || null,
      bodyPt: typography?.bodyPt || null,
    },
  }

  const mined = pickTheme(colorWeight, fontCount, EMPTY_TEMPLATE)
  if (mined) {
    if (extras.minedStyle.titleFont) mined.headingFont = extras.minedStyle.titleFont
    return { ...mined, ...extras }
  }

  // Fallback for the rare deck that only ever uses scheme colors inherited
  // from the master (no hardcoded srgbClr anywhere on any slide) — read the
  // declared theme, even though it's often just the generic Office palette.
  const themePath = Object.keys(zip.files).find((p) => /ppt\/theme\/theme\d*\.xml$/i.test(p))
  if (!themePath) throw new Error('nenhuma cor encontrada dentro do .pptx')
  const xml = await zip.files[themePath]!.async('text')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const clr = (tag: string) => {
    const el = doc.getElementsByTagNameNS(DML_NS, tag)[0]
    if (!el) return null
    const srgb = el.getElementsByTagNameNS(DML_NS, 'srgbClr')[0]
    if (srgb) return '#' + srgb.getAttribute('val')!.toUpperCase()
    const sys = el.getElementsByTagNameNS(DML_NS, 'sysClr')[0]
    if (sys && sys.getAttribute('lastClr')) return '#' + sys.getAttribute('lastClr')!.toUpperCase()
    return null
  }
  const font = (schemeTag: string) => {
    const scheme = doc.getElementsByTagNameNS(DML_NS, schemeTag)[0]
    const latin = scheme?.getElementsByTagNameNS(DML_NS, 'latin')[0]
    return latin?.getAttribute('typeface') || ''
  }
  const dk1 = clr('dk1')
  const lt1 = clr('lt1')
  const dk2 = clr('dk2')
  const accent1 = clr('accent1')
  const accent2 = clr('accent2')
  return {
    backgroundColor: lt1 || EMPTY_TEMPLATE.backgroundColor,
    primaryColor: dk2 || dk1 || EMPTY_TEMPLATE.primaryColor,
    secondaryColor: accent2 || dk1 || EMPTY_TEMPLATE.secondaryColor,
    accentColor: accent1 || EMPTY_TEMPLATE.accentColor,
    headingFont: font('majorFont') || EMPTY_TEMPLATE.headingFont,
    bodyFont: font('minorFont') || EMPTY_TEMPLATE.bodyFont,
    ...extras,
  }
}

export function stripExt(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '')
}

const MAX_WATERMARK_ASSETS = 6
const ASSET_CAPS: Record<string, number> = {
  icon: 48, // bundle imports carry a full product-icon family; .pptx mining alone stays under MAX_ICON_ASSETS anyway
  image: MAX_OTHER_IMAGES + 12,
  watermark: MAX_WATERMARK_ASSETS,
  illustration: 16,
  background: 12,
  lockup: 24,
}

// Merges a freshly extracted design-system payload into an existing template
// draft: scalar identity fields (colors, fonts, logo, plates, typography)
// only fill gaps — whatever the user already has/reviewed wins — while
// collections (icons, images, preview slides, diagrams) append up to their
// caps. Lets a design system be assembled from SEVERAL files (a slide
// template + a component library + logo files), not just one .pptx.
export function mergeTemplate(base: Partial<Template>, extra: Partial<Template>, { preferBase = false }: { preferBase?: boolean } = {}): Partial<Template> {
  const merged: Partial<Template> = { ...base }
  // the report describes ONE extraction — after a merge it describes the
  // incoming patch, which is what the review panel wants to explain
  if (extra._importReport) merged._importReport = extra._importReport
  for (const key of ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor', 'headingFont', 'bodyFont', 'logoDataUrl', 'logoLightDataUrl', 'coverPlateDataUrl', 'styleNotes', 'name', 'readme', 'brandRules'] as StringTemplateKey[]) {
    if (!merged[key] && extra[key]) merged[key] = extra[key]
  }
  // bundle-only collections: whichever side is richer wins whole (they are
  // authoritative snapshots of one export, not append-forever asset
  // libraries). `preferBase` pins the user's reviewed draft instead — the
  // "Manter os atuais" choice in the enrich-confirmation flow.
  for (const key of ['palette', 'fontAssets', 'dsCards'] as ('palette' | 'fontAssets' | 'dsCards')[]) {
    if (preferBase && base[key]?.length) merged[key] = base[key]
    else merged[key] = (base[key]?.length || 0) >= (extra[key]?.length || 0) ? base[key] || [] : extra[key] || []
  }
  const seen = new Set((base.iconAssets || []).map((a) => a.dataUrl))
  const counts: Record<string, number> = { icon: 0, image: 0, watermark: 0, illustration: 0, background: 0, lockup: 0 }
  const kindOf = (a: IconAsset) => (ASSET_CAPS[a.kind] ? a.kind : a.kind === 'image' ? 'image' : a.kind === 'watermark' ? 'watermark' : 'icon')
  for (const a of base.iconAssets || []) counts[kindOf(a)]!++
  const appended = [...(base.iconAssets || [])]
  for (const a of extra.iconAssets || []) {
    const kind = kindOf(a)
    if (seen.has(a.dataUrl) || counts[kind]! >= ASSET_CAPS[kind]!) continue
    seen.add(a.dataUrl)
    counts[kind]!++
    appended.push({ ...a, kind, id: nextAssetId(kind) })
  }
  merged.iconAssets = appended
  merged.previewSlides = [...(base.previewSlides || []), ...(extra.previewSlides || [])].slice(0, MAX_PREVIEW_SLIDES)
  const baseMined: MinedStyle = base.minedStyle || {}
  const extraMined: MinedStyle = extra.minedStyle || {}
  const diagrams = [...(baseMined.diagrams || []), ...(extraMined.diagrams || [])]
    .slice(0, MAX_MINED_DIAGRAMS)
    .map((d, i) => ({ ...d, id: `diag_${i + 1}` }))
  merged.minedStyle = {
    ...extraMined,
    ...Object.fromEntries(Object.entries(baseMined).filter(([, v]) => v != null && v !== '')),
    diagrams,
    motif: baseMined.motif || extraMined.motif || null,
  }
  return merged
}

// A loose image file added to the design system: files named like a logo
// become the template logo (when none exists yet); everything else joins the
// icon library — reclassifiable afterwards in the asset editor below.
async function imageFileToTemplatePatch(file: File, tpl: Partial<Template>): Promise<Partial<Template>> {
  const raw = await fileToDataUrl(file)
  if (/logo|marca|brand/i.test(file.name) && !tpl.logoDataUrl) {
    return { logoDataUrl: raw }
  }
  const dataUrl = await rasterizeToPng(raw)
  return {
    iconAssets: [...(tpl.iconAssets || []), { id: nextAssetId('icon'), label: stripExt(file.name), dataUrl, kind: 'icon' }],
  }
}

// Reads any mix of design-system source files (.pptx templates, .json
// exports, loose images, a design-system bundle folder or .zip) into a
// single template draft. A folder pick / dropped folder arrives as many
// files sharing a webkitRelativePath root — when that set (or a .zip) looks
// like a design-system bundle (see dsImport.ts), the whole set is parsed as
// one bundle instead of file-by-file.
export async function extractFromFiles(
  files: ArrayLike<File> | Iterable<File>,
  startFrom?: Partial<Template> | null,
  { onProgress }: { onProgress?: (msg: string) => void } = {}
): Promise<Partial<Template>> {
  let tpl: Partial<Template> | null = startFrom ? { ...startFrom } : null
  const list = Array.from(files)

  // whole-folder pick → bundle import (plus any .pptx inside it, mined too)
  const { isDesignSystemBundle, entriesFromFileList, entriesFromZip, importDesignSystemBundle } = await import('./dsImport.ts')
  if (list.length > 3 && list.some((f) => f.webkitRelativePath) && isDesignSystemBundle(list.map((f) => f.webkitRelativePath || f.name))) {
    const patch = await importDesignSystemBundle(entriesFromFileList(list), { onProgress })
    return tpl ? mergeTemplate(tpl, patch) : { ...EMPTY_TEMPLATE, ...patch }
  }

  const images: File[] = []
  for (const file of list) {
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.zip')) {
      const entries = await entriesFromZip(file)
      if (!isDesignSystemBundle(entries.map((e) => e.path))) {
        throw new Error(`${file.name} não parece um export de design system (esperado _ds_manifest.json ou README.md + colors_and_type.css)`)
      }
      const patch = await importDesignSystemBundle(entries, { onProgress })
      tpl = tpl ? mergeTemplate(tpl, patch) : { ...EMPTY_TEMPLATE, ...patch }
    } else if (lower.endsWith('.json')) {
      const parsed = { ...JSON.parse(await file.text()) }
      tpl = tpl ? mergeTemplate(tpl, parsed) : { ...EMPTY_TEMPLATE, ...parsed }
    } else if (lower.endsWith('.pptx')) {
      const extracted = await extractPptxTheme(file)
      tpl = tpl
        ? mergeTemplate(tpl, extracted)
        : { ...EMPTY_TEMPLATE, ...extracted, name: extracted.name || stripExt(file.name) }
    } else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) {
      images.push(file)
    } else if (/\.(md|css|js|jsx|html|ttf|otf|woff2?)$/i.test(lower) || lower === '.ds_store') {
      // stray bundle files picked outside a full folder — ignore quietly
      continue
    } else {
      throw new Error(`arquivo não suportado: ${file.name} (use .pptx, .json, .zip de design system ou imagens)`)
    }
  }
  if (!tpl) tpl = { ...EMPTY_TEMPLATE }
  for (const file of images) {
    try {
      tpl = { ...tpl, ...(await imageFileToTemplatePatch(file, tpl)) }
    } catch {
      // unreadable image — skip it rather than fail the whole import
    }
  }
  return tpl
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string) // readAsDataURL always yields a string
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// pptxgenjs (and <img> reliability across the app) only deals in raster
// images, and a manually uploaded "icon" should be small regardless of the
// source file's resolution/format — every manual upload gets rasterized
// once, up front, into a fixed 128×128 PNG via an offscreen <img>/<canvas>
// round-trip. This also bounds the size (a multi-MB photo picked as an
// "icon" by mistake never bloats the template's saved payload).
export function rasterizeToPng(dataUrl: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const size = 128
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const scale = Math.min(size / (img.width || size), size / (img.height || size))
      const w = (img.width || size) * scale
      const h = (img.height || size) * scale
      ctx!.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = dataUrl
  })
}