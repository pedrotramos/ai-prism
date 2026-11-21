import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'

// A paint op the client extracted off the DOM (client/lib/domToSlideOps.js). Loose on
// purpose: it arrives as request JSON, so every field but `type` may be absent.
interface PaintRun {
  text: string
  font?: string
  size?: number
  color?: string
  bold?: boolean
  italic?: boolean
  tracking?: number
}
interface PaintOp {
  type?: string
  x: number
  y: number
  w: number
  h: number
  fill?: string
  line?: { color: string; width: number }
  radius?: number
  dataUrl?: string
  transparency?: number
  fit?: string
  runs?: PaintRun[]
  lineHeight?: number
  align?: PptxGenJS.HAlign
  valign?: PptxGenJS.VAlign
}
interface PaintSlide {
  w?: number
  h?: number
  ops?: PaintOp[]
}
interface FontAsset {
  family?: string
  dataUrl?: string
  weight?: string | number
  style?: string
}
type FontSlot = 'regular' | 'bold' | 'italic' | 'boldItalic'

// The .pptx canvas is a fixed 16:9 stage measured in inches (10 × 5.625in),
// the same proportions as the 1280×720 px stage the HTML slides render on.
const SLIDE_W = 10
const SLIDE_H = 5.625

// Pure-HTML deck export: assemble a .pptx of NATIVE, editable shapes from
// paint-ops the client extracted off the rendered DOM (see
// client/lib/domToSlideOps.js). This mirrors how Claude Design exports — every
// element becomes a positioned <p:sp>/text/image, nothing rasterized. Ops carry
// px coords on a 1280×720 stage; we scale to the 10×5.625in canvas.
export async function renderPptxFromOps(
  deck: { title?: string } | null | undefined,
  slides: PaintSlide[] | null | undefined,
  { embedFonts = false, fontAssets = [] }: { embedFonts?: boolean; fontAssets?: FontAsset[] } = {},
): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'PRISM_16x9', width: SLIDE_W, height: SLIDE_H })
  pptx.layout = 'PRISM_16x9'
  pptx.author = 'AI Prism'
  pptx.title = deck?.title || 'Apresentação'

  for (const slide of slides || []) {
    const s = pptx.addSlide()
    const stageW = slide.w || 1280
    const stageH = slide.h || 720
    const kx = SLIDE_W / stageW // px → inches
    const ky = SLIDE_H / stageH
    const IN = (v: number, k: number) => Math.round(v * k * 1000) / 1000
    for (const op of slide.ops || []) {
      const x = IN(op.x, kx)
      const y = IN(op.y, ky)
      const w = Math.max(IN(op.w, kx), 0.02)
      const h = Math.max(IN(op.h, ky), 0.02)
      try {
        if (op.type === 'rect') {
          if (!op.fill && !op.line) continue
          const shape = op.radius! > 0 ? 'roundRect' : 'rect'
          const opts: PptxGenJS.ShapeProps = { x, y, w, h }
          if (op.fill) opts.fill = { color: op.fill }
          else opts.fill = { type: 'none' }
          if (op.line) opts.line = { color: op.line.color, width: op.line.width }
          if (shape === 'roundRect') opts.rectRadius = Math.min(IN(op.radius!, kx), Math.min(w, h) / 2)
          s.addShape(shape, opts)
        } else if (op.type === 'image' && op.dataUrl) {
          // opacity from the DOM extractor → pptxgenjs `transparency` (0..100 %).
          // object-fit contain/cover → pptxgenjs `sizing` so the exported image
          // keeps its aspect ratio (matches the preview) instead of stretching to
          // fill the box. Absent `fit` (fill) keeps the legacy stretch behavior.
          const img: PptxGenJS.ImageProps = { data: op.dataUrl, x, y, w, h, ...(op.transparency ? { transparency: op.transparency } : {}) }
          if (op.fit === 'contain' || op.fit === 'cover') img.sizing = { type: op.fit, w, h }
          s.addImage(img)
        } else if (op.type === 'text' && op.runs?.length) {
          const runs = op.runs.map((r: PaintRun) => ({
            text: r.text,
            options: {
              fontFace: r.font || 'Arial',
              fontSize: r.size || 12,
              color: r.color || '000000',
              bold: !!r.bold,
              italic: !!r.italic,
              ...(r.tracking ? { charSpacing: r.tracking } : {}),
            },
          }))
          // Line height as EXACT points, not a multiple. pptxgenjs
          // `lineSpacingMultiple` maps to OOXML `spcPct`, which PowerPoint applies
          // relative to the font's NATURAL leading (~1.2×), not the font size —
          // so a CSS line-height:1.05 rendered ~1.26× tall in PPTX and the last
          // line overflowed. `lineSpacing` sets the exact inter-line distance in
          // points; we compute it from the tallest run (size in pt) × the CSS
          // multiple, matching the browser's line box exactly.
          const maxSize = Math.max(...op.runs.map((r: PaintRun) => r.size || 12))
          const lineSpacing = Math.round(maxSize * (op.lineHeight || 1.15) * 10) / 10
          s.addText(runs, {
            x, y, w, h,
            align: op.align || 'left',
            valign: op.valign || 'top',
            margin: 0,
            lineSpacing,
            wrap: true,
          })
        }
      } catch {
        // one malformed op must never abort the whole export
      }
    }
  }
  // pptxgenjs still accepts the legacy bare string at runtime; its types only know the props object
  const buf = (await pptx.write('nodebuffer' as unknown as PptxGenJS.WriteProps)) as Buffer
  if (embedFonts && fontAssets.length) {
    try {
      return await embedFontsInPptx(buf, fontAssets)
    } catch {
      // embedding is best-effort — a failure falls back to the un-embedded file
      return buf
    }
  }
  return buf
}

// Embed the design system's TrueType fonts into a .pptx so the deck renders in
// the brand face even where the font isn't installed. PowerPoint's OOXML font
// embedding: font bytes live at ppt/fonts/fontN.fntdata, declared per-typeface
// in ppt/presentation.xml <p:embeddedFontLst> (with embedTrueTypeFonts="1"),
// wired by rels in ppt/_rels/presentation.xml.rels, and the fntdata extension
// registered in [Content_Types].xml. pptxgenjs can't do this, so we post-process
// the zip it produced. Only TTF/OTF data URIs are embeddable.
async function embedFontsInPptx(buf: Buffer, fontAssets: FontAsset[]): Promise<Buffer> {
  // group assets by family → { regular, bold, italic, boldItalic } bytes
  const families = new Map<string, Partial<Record<FontSlot, Buffer>>>()
  for (const f of fontAssets) {
    if (!f?.family || typeof f.dataUrl !== 'string') continue
    const m = /^data:font\/(ttf|otf|truetype|opentype|sfnt)?;base64,(.+)$/i.exec(f.dataUrl)
    if (!m) continue
    const bytes = Buffer.from(m[2]!, 'base64')
    const name = String(f.family).replace(/['"]/g, '').trim()
    if (!name) continue
    const bold = parseInt(f.weight as string, 10) >= 600 || /bold/i.test((f.weight as string) || '')
    const italic = /italic|oblique/i.test(f.style || '')
    const slot: FontSlot = bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
    const entry = families.get(name) || {}
    // keep the first seen for each slot (weights beyond the 4 OOXML slots fold in)
    if (!entry[slot]) entry[slot] = bytes
    families.set(name, entry)
  }
  if (!families.size) return buf

  const zip = await JSZip.loadAsync(buf)
  const SLOT_TAG: Record<FontSlot, string> = { regular: 'regular', bold: 'bold', italic: 'italic', boldItalic: 'boldItalic' }
  let fontFileIx = 0
  const embeddedFontXml: string[] = []
  const relXml: string[] = []
  const seenExt = new Set()

  for (const [family, slots] of families) {
    const slotRels: Partial<Record<FontSlot, string>> = {}
    for (const slot of ['regular', 'bold', 'italic', 'boldItalic'] as FontSlot[]) {
      if (!slots[slot]) continue
      fontFileIx++
      const fileName = `font${fontFileIx}.fntdata`
      zip.file(`ppt/fonts/${fileName}`, slots[slot]!)
      const rId = `rIdFont${fontFileIx}`
      relXml.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${fileName}"/>`)
      slotRels[slot] = rId
      seenExt.add('fntdata')
    }
    if (!Object.keys(slotRels).length) continue
    const tags = Object.entries(slotRels)
      .map(([slot, rId]) => `<p:${SLOT_TAG[slot as FontSlot]} r:id="${rId}"/>`)
      .join('')
    embeddedFontXml.push(`<p:embeddedFont><p:font typeface="${xmlEscape(family)}"/>${tags}</p:embeddedFont>`)
  }
  if (!embeddedFontXml.length) return buf

  // 1) [Content_Types].xml — register the fntdata extension
  {
    const path = '[Content_Types].xml'
    let ct = await zip.file(path)!.async('string')
    if (!/Extension="fntdata"/.test(ct)) {
      ct = ct.replace(
        /<\/Types>/,
        '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>'
      )
      zip.file(path, ct)
    }
  }
  // 2) ppt/_rels/presentation.xml.rels — add the font relationships
  {
    const path = 'ppt/_rels/presentation.xml.rels'
    let rels = await zip.file(path)!.async('string')
    rels = rels.replace(/<\/Relationships>/, relXml.join('') + '</Relationships>')
    zip.file(path, rels)
  }
  // 3) ppt/presentation.xml — embedTrueTypeFonts + <p:embeddedFontLst>. CRITICAL:
  // the CT_Presentation schema fixes the child order — sldMasterIdLst,
  // notesMasterIdLst, handoutMasterIdLst, sldIdLst, sldSz, notesSz, then
  // embeddedFontLst. Inserting it before sldSz/notesSz makes PowerPoint reject
  // the file ("found a problem with content") and strip the fonts on repair. So
  // we place it right AFTER <p:notesSz…/> (or after <p:sldSz…/> if notesSz is
  // absent), never after </p:sldIdLst>.
  {
    const path = 'ppt/presentation.xml'
    let pres = await zip.file(path)!.async('string')
    pres = pres.replace(/<p:presentation([^>]*)>/, (mm: string, attrs: string) =>
      /embedTrueTypeFonts/.test(attrs) ? mm : `<p:presentation${attrs} embedTrueTypeFonts="1">`
    )
    const lst = `<p:embeddedFontLst>${embeddedFontXml.join('')}</p:embeddedFontLst>`
    if (/<p:notesSz\b[^>]*\/>/.test(pres)) pres = pres.replace(/(<p:notesSz\b[^>]*\/>)/, `$1${lst}`)
    else if (/<p:sldSz\b[^>]*\/>/.test(pres)) pres = pres.replace(/(<p:sldSz\b[^>]*\/>)/, `$1${lst}`)
    else pres = pres.replace(/<\/p:presentation>/, `${lst}</p:presentation>`)
    zip.file(path, pres)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function xmlEscape(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
