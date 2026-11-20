import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
// Import the lib file directly: the package root runs a debug block (reads a
// sample PDF) when there's no module parent, which breaks under bundling/ESM.
// @ts-expect-error pdf-parse ships no declaration for its lib entry point
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

const MAX_CHARS_PER_FILE = 50_000

const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'log', 'tsv', 'xml', 'html', 'yaml', 'yml']

export const SUPPORTED_EXTENSIONS = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'xls',
  ...TEXT_EXT,
]

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS_PER_FILE) return text
  return text.slice(0, MAX_CHARS_PER_FILE) + `\n\n... [truncado em ${MAX_CHARS_PER_FILE} caracteres]`
}

function decodeText(buf: Buffer): string {
  try {
    return buf.toString('utf-8')
  } catch {
    return buf.toString('latin1')
  }
}

async function readPdf(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer)
  return data.text || ''
}

async function readDocx(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer })
  return value || ''
}

function readSpreadsheet(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    parts.push(`--- Planilha: ${name} ---`)
    parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]!)) // SheetNames lists keys of Sheets
  }
  return parts.join('\n')
}

async function readPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)![1]!, 10) // the filter above guarantees the match
      const nb = parseInt(b.match(/slide(\d+)\.xml/)![1]!, 10)
      return na - nb
    })
  const parts: string[] = []
  let i = 1
  for (const p of slidePaths) {
    const xml = await zip.file(p)!.async('string') // p comes from zip.files
    const text = xml
      .replace(/<a:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim()
    parts.push(`--- Slide ${i++} ---\n${text}`)
  }
  return parts.join('\n\n')
}

export async function extractText(filename: string, buffer: Buffer): Promise<string> {
  const e = ext(filename)
  try {
    let content: string
    if (e === 'pdf') content = await readPdf(buffer)
    else if (e === 'docx') content = await readDocx(buffer)
    else if (e === 'xlsx' || e === 'xls') content = readSpreadsheet(buffer)
    else if (e === 'pptx') content = await readPptx(buffer)
    else content = decodeText(buffer)
    return truncate(content || '[arquivo sem texto extraível]')
  } catch (err) {
    return `[Falha ao ler ${filename}: ${(err as Error).message}]`
  }
}
