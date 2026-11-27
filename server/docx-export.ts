// Markdown → .docx, built by hand as an OOXML package zipped with JSZip (same
// no-heavy-dep approach as xlsx-export.ts). We don't need a full markdown/OOXML
// bridge — the model writes reasonably plain markdown (headings, paragraphs,
// lists, bold/italic/code, blockquotes, simple tables), and this covers those.
// The output opens cleanly in Word/Google Docs. Anything exotic degrades to
// plain paragraphs rather than failing.
import JSZip from 'jszip'

const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// Inline markdown → an array of <w:r> runs. Handles **bold**, *italic*/_italic_,
// `code`, and [text](url) (rendered as the text). Order matters: code first so
// its contents aren't re-parsed for emphasis.
function inlineRuns(text: string): string {
  const runs: string[] = []
  // tokenizer: split on the inline markers, keeping delimiters
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  const push = (t: string, opts: { b?: boolean; i?: boolean; code?: boolean } = {}): void => {
    if (!t) return
    const props = []
    if (opts.b) props.push('<w:b/>')
    if (opts.i) props.push('<w:i/>')
    if (opts.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''
    runs.push(`<w:r>${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`)
  }
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    const tok = m[0]!
    if (tok.startsWith('**') || tok.startsWith('__')) push(tok.slice(2, -2), { b: true })
    else if (tok.startsWith('`')) push(tok.slice(1, -1), { code: true })
    else if (tok.startsWith('[')) push(tok.slice(1, tok.indexOf(']')))
    else push(tok.slice(1, -1), { i: true })
    last = re.lastIndex
  }
  push(text.slice(last))
  return runs.length ? runs.join('') : '<w:r><w:t/></w:r>'
}

const para = (runsXml: string, { style, bullet }: { style?: string; bullet?: boolean } = {}): string => {
  const pPr: string[] = []
  if (style) pPr.push(`<w:pStyle w:val="${style}"/>`)
  if (bullet) pPr.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  return `<w:p>${pPrXml}${runsXml}</w:p>`
}

// A markdown table block → a Word table. `rows` is an array of cell-arrays.
function tableXml(rows: string[][]): string {
  if (!rows.length) return ''
  const rowXml = (cells: string[], header: boolean): string =>
    `<w:tr>${cells
      .map(
        (c: string) =>
          `<w:tc><w:tcPr><w:tcBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tcBorders></w:tcPr>${para(
            inlineRuns(header ? c : c),
            {}
          )}</w:tc>`
      )
      .join('')}</w:tr>`
  const body = rows.map((r: string[], i: number) => rowXml(r, i === 0)).join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${body}</w:tbl>`
}

// Figures: a markdown image alone on a line whose URL is in `images` (the PNG bytes the
// caller resolved, e.g. a chart of the chat) becomes an inline picture; any other image
// stays its alt text, in italics (no network fetch from the exporter).
export interface DocxImages {
  /** markdown image URL → PNG bytes */
  images?: Map<string, Buffer>
}
interface Media {
  rid: string
  name: string
  buf: Buffer
}
const PAGE_CONTENT_EMU = 5_731_510 // A4 width minus the 1" margins (9026 twips x 635)

function pngDims(png: Buffer): { w: number; h: number } {
  return png.length >= 24 && png.readUInt32BE(0) === 0x89504e47 ? { w: png.readUInt32BE(16), h: png.readUInt32BE(20) } : { w: 16, h: 9 }
}

function pictureXml(m: Media, alt: string, n: number): string {
  const { w, h } = pngDims(m.buf)
  const cx = PAGE_CONTENT_EMU
  const cy = Math.round((cx * h) / w)
  return (
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Figure ${n}" descr="${esc(alt).replace(/"/g, '&quot;')}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${m.name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${m.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  )
}

// Parse markdown into a flat list of block descriptors, then emit OOXML.
function markdownToBody(md: unknown, images: Map<string, Buffer> = new Map(), media: Media[] = []): string {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]! // i < lines.length (loop guard)
    // fenced code block
    if (/^```/.test(line)) {
      i++
      const code: string[] = []
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!)
      i++ // closing fence
      for (const cl of code) out.push(para(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">${esc(cl)}</w:t></w:r>`))
      continue
    }
    // table: a line with | and a following |---| separator
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) && /-/.test(lines[i + 1]!)) {
      const rows: string[][] = []
      const parseRow = (l: string): string[] =>
        l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c: string) => c.trim())
      rows.push(parseRow(line))
      i += 2 // header + separator
      while (i < lines.length && /\|/.test(lines[i]!) && lines[i]!.trim()) rows.push(parseRow(lines[i++]!))
      out.push(tableXml(rows))
      continue
    }
    const image = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/)
    if (image) {
      const buf = images.get(image[2]!)
      if (buf) {
        const n = media.length + 1
        const m: Media = { rid: `rIdImg${n}`, name: `image${n}.png`, buf }
        media.push(m)
        out.push(pictureXml(m, image[1]!, n))
      } else if (image[1]) {
        out.push(para(inlineRuns(`*${image[1]}*`)))
      }
      i++
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const lvl = Math.min(heading[1]!.length, 6)
      out.push(para(inlineRuns(heading[2]!), { style: `Heading${lvl}` }))
      i++
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      out.push(para(inlineRuns(bullet[1]!), { bullet: true }))
      i++
      continue
    }
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ordered) {
      out.push(para(inlineRuns(ordered[1]!), { bullet: true }))
      i++
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      out.push(para(inlineRuns(quote[1]!), { style: 'Quote' }))
      i++
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    out.push(para(inlineRuns(line)))
    i++
  }
  return out.join('')
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const docRels = (media: Media[]): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('\n')}
</Relationships>`

// minimal styles: heading levels + Quote + a base body font.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:rPr><w:b/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>`

// one bullet list definition (numId=1)
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`

/** Render a { title, markdown } document to a .docx Buffer. */
export async function renderDocx(docIn: unknown, { images }: DocxImages = {}): Promise<Buffer> {
  const doc = docIn as { title?: string; markdown?: string } | null | undefined // a stored/sanitized document; the fields are read defensively below
  const title = doc?.title || 'Documento'
  // prepend the title as an H1 only if the markdown doesn't already open with one
  const md = String(doc?.markdown || '')
  const media: Media[] = []
  const body = markdownToBody(md.trimStart().startsWith('#') ? md : `# ${title}\n\n${md}`, images, media)
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.folder('_rels')!.file('.rels', ROOT_RELS)
  const word = zip.folder('word')! // folder() with a name always returns a JSZip
  word.file('document.xml', documentXml)
  word.file('styles.xml', STYLES)
  word.file('numbering.xml', NUMBERING)
  word.folder('_rels')!.file('document.xml.rels', docRels(media))
  for (const m of media) word.file(`media/${m.name}`, m.buf)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
