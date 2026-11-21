// Structured ingestion of an attached .pptx into the deck's SEMANTIC schema
// ({ title, slides:[{layout, heading, bullets, ... }] }). This is the bridge
// that was missing: an attached deck used to be flattened to plain text
// (server/files.js#readPptx), so "adjust this presentation to the selected
// template" had nothing structured to re-theme. Here we pull each slide's
// title / body bullets / notes and INFER a layout hint, so the chat flow can
// hand the model a real deck to restructure into the active design system
// (server/decks.js#renderPptx reapplies the template on export).
//
// We intentionally capture CONTENT + LAYOUT INTENT, not pixel-faithful visuals:
// the whole point is to let the design system win. Embedded images are noted
// (imageCount) but not re-inserted in v1.
import JSZip from 'jszip'

interface IngestedSlide {
  heading: string
  bullets: string[]
  notes: string
  bodyBlocks: number
  hasTable: boolean
  hasChart: boolean
  imageCount: number
  layout?: string
}
interface IngestedDeck {
  title: string
  slides: IngestedSlide[]
  meta: { slideCount: number; truncated: boolean; source: string }
}

// Office Open XML: DrawingML text lives in <a:t> runs inside <a:p> paragraphs;
// placeholders carry a type on <p:ph type="..."/>. We parse with tolerant
// regexes (no XML DOM on the server) — the shapes we need are simple and this
// avoids a parser dependency in the bundle.

const MAX_SLIDES = 60 // hard cap before the deck pipeline's own MAX_DECK_SLIDES
const MAX_BULLETS_PER_SLIDE = 16
const MAX_CHARS = 4000 // per text field, defensive

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_: string, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&') // last, so &amp;lt; doesn't double-decode
}

// Placeholder types that are chrome, not content — footer/date/slide-number.
// Their text (and the auto <a:fld> slide-number glyph "‹#›") must not pollute
// the extracted body or inflate the layout inference.
const CHROME_PH = new Set(['sldNum', 'ftr', 'dt'])

// Strip the auto slide-number field glyph and other non-content noise.
function cleanText(s: string): string {
  return s
    .replace(/[‹›]#[‹›]/g, '') // ‹#› slide-number placeholder
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// All text of one paragraph = concatenation of its <a:t> runs.
function paragraphText(pXml: string): string {
  const runs = pXml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []
  const text = runs.map((r: string) => decodeXmlEntities(r.replace(/<\/?a:t>/g, ''))).join('')
  return cleanText(text)
}

// A shape (<p:sp>) → { phType, isTitle, isChrome, paragraphs:[{text, level}] }.
function parseShape(spXml: string) {
  const phMatch = spXml.match(/<p:ph\b[^>]*\btype="([^"]+)"/)
  const phType = phMatch ? phMatch[1]! : (/<p:ph\b/.test(spXml) ? 'body' : null)
  const isTitle = phType === 'title' || phType === 'ctrTitle'
  const isChrome = CHROME_PH.has(phType as string)
  const paras = spXml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []
  const paragraphs: { text: string; level: number }[] = []
  for (const p of paras) {
    const text = paragraphText(p)
    if (!text) continue
    const lvlMatch = p.match(/<a:pPr\b[^>]*\blvl="(\d+)"/)
    const level = lvlMatch ? Number(lvlMatch[1]) : 0
    paragraphs.push({ text: text.slice(0, MAX_CHARS), level })
  }
  return { phType, isTitle, isChrome, paragraphs }
}

// Infer a semantic layout from the shapes on a slide. Conservative: the model
// gets this as a HINT and may override, but a good hint preserves the author's
// structural intent (a title-only slide stays a section divider, etc.).
function inferLayout(slide: IngestedSlide, idx: number): string {
  const bulletCount = slide.bullets.length
  const hasTable = slide.hasTable
  const hasChart = slide.hasChart
  const bodyBlocks = slide.bodyBlocks

  if (hasTable) return 'table'
  if (hasChart) return 'chart'
  if (idx === 0 && bulletCount <= 1) return 'title'
  // title present, no/scant body → section divider
  if (slide.heading && bulletCount === 0 && bodyBlocks <= 1) return 'section'
  // two distinct body placeholders with content → two-column
  if (bodyBlocks >= 2 && bulletCount >= 2) return 'two-column'
  // lots of short numeric-ish lines → stat grid
  const numericLines = slide.bullets.filter((b: string) => /\d/.test(b) && b.length <= 40).length
  if (bulletCount >= 3 && numericLines >= Math.ceil(bulletCount * 0.6)) return 'stat-grid'
  if (bulletCount > 0) return 'bullets'
  return 'bullets'
}

async function slideRelsHasTypes(zip: JSZip, slideNum: number): Promise<{ hasChart: boolean; imageCount: number }> {
  const relPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`
  const file = zip.file(relPath)
  if (!file) return { hasChart: false, imageCount: 0 }
  const xml = await file.async('string')
  const hasChart = /relationships\/chart/i.test(xml)
  const imageCount = (xml.match(/relationships\/image/gi) || []).length
  return { hasChart, imageCount }
}

/**
 * Parse a .pptx buffer into a semantic deck. Returns
 *   { title, slides: [{ layout, heading, bullets, notes, imageCount }], meta }
 * or null if it doesn't look like a parseable pptx.
 */
export async function ingestPptx(buffer: Buffer | Uint8Array | ArrayBuffer, filename = ''): Promise<IngestedDeck | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return null
  }
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)![1]!, 10)
      const nb = parseInt(b.match(/slide(\d+)\.xml/)![1]!, 10)
      return na - nb
    })
  if (!slidePaths.length) return null

  const slides: IngestedSlide[] = []
  let truncated = false
  for (const path of slidePaths) {
    if (slides.length >= MAX_SLIDES) {
      truncated = true
      break
    }
    const slideNum = parseInt(path.match(/slide(\d+)\.xml/)![1]!, 10)
    const xml = await zip.file(path)!.async('string')

    const shapeXmls = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []
    const shapes = shapeXmls.map(parseShape)

    let heading = ''
    const bullets: string[] = []
    let bodyBlocks = 0
    for (const sh of shapes) {
      if (!sh.paragraphs.length || sh.isChrome) continue // skip footer/date/slide-num chrome
      if (sh.isTitle && !heading) {
        heading = sh.paragraphs.map((p) => p.text).join(' ').slice(0, 240)
      } else if (!sh.isTitle) {
        bodyBlocks++
        for (const p of sh.paragraphs) bullets.push(p.text)
      }
    }

    const hasTable = /<a:tbl>/.test(xml)
    const rels = await slideRelsHasTypes(zip, slideNum)

    // speaker notes
    let notes = ''
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideNum}.xml`)
    if (notesFile) {
      const nXml = await notesFile.async('string')
      const nParas = nXml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []
      notes = nParas.map(paragraphText).filter(Boolean).join('\n').slice(0, MAX_CHARS)
    }

    const slide: IngestedSlide = {
      heading,
      bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE),
      notes,
      bodyBlocks,
      hasTable,
      hasChart: rels.hasChart,
      imageCount: rels.imageCount,
    }
    slide.layout = inferLayout(slide, slides.length)
    slides.push(slide)
  }

  if (!slides.length) return null

  // deck title: core props title, else first slide heading, else filename
  let title = ''
  const coreFile = zip.file('docProps/core.xml')
  if (coreFile) {
    const core = await coreFile.async('string')
    const m = core.match(/<dc:title>([\s\S]*?)<\/dc:title>/)
    if (m) title = decodeXmlEntities(m[1]!).trim()
  }
  if (!title) title = slides[0]?.heading || filename.replace(/\.pptx$/i, '')

  return {
    title: title.slice(0, 200),
    slides,
    meta: { slideCount: slides.length, truncated, source: filename },
  }
}

// Render the ingested deck as a compact, model-facing brief (JSON is the
// clearest signal for "here is the existing structure; restructure it").
export function pptxDeckToBrief(deck: IngestedDeck): string {
  const lines = deck.slides.map((s: IngestedSlide, i: number) => {
    const parts = [`#${i + 1} [${s.layout}] ${s.heading || '(sem título)'}`]
    if (s.bullets.length) parts.push('  • ' + s.bullets.join('\n  • '))
    if (s.notes) parts.push('  (notas: ' + s.notes.replace(/\n/g, ' ').slice(0, 300) + ')')
    if (s.imageCount) parts.push(`  (${s.imageCount} imagem(ns) no slide original)`)
    return parts.join('\n')
  })
  return `Título: ${deck.title}\nSlides: ${deck.meta.slideCount}${deck.meta.truncated ? ' (truncado)' : ''}\n\n${lines.join('\n\n')}`
}
