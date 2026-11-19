// Static contract of the three studios (W2-8), checked by grep so it cannot
// drift silently: one shared AI panel and one shared export menu (not three
// copies), tokens instead of raw colours, the type scale instead of arbitrary
// pixel sizes in the slide inspector, and no hard-coded Portuguese labels.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const STUDIOS = {
  DeckStudio: read('../DeckStudio.jsx'),
  SpreadsheetStudio: read('../SpreadsheetStudio.jsx'),
  DocumentStudio: read('../DocumentStudio.jsx'),
}
const INSPECTOR = read('../deck/HtmlSlideInspector.jsx')
const count = (src, re) => (src.match(re) || []).length
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b(?![-\w])/g
const RAW = /\b(?:text|bg|border|ring|from|to)-(?:white|black|(?:red|green|amber|yellow|emerald|blue|sky|orange|rose|gray|zinc|slate)-\d{2,3})\b/g

test('every studio renders the shared StudioAIPanel and StudioExportMenu exactly once', () => {
  for (const [name, src] of Object.entries(STUDIOS)) {
    assert.match(src, /import StudioAIPanel from '\.\/studio\/StudioAIPanel\.jsx'/, name)
    assert.match(src, /import StudioExportMenu from '\.\/studio\/StudioExportMenu\.jsx'/, name)
    assert.equal(count(src, /<StudioAIPanel\b/g), 1, `${name}: one AI panel`)
    assert.equal(count(src, /<StudioExportMenu\b/g), 1, `${name}: one export menu`)
    // the AI instruction box lives in the shared panel only
    assert.equal(count(src, /Paperclip/g), 0, `${name}: attach button belongs to StudioAIPanel`)
  }
})

test('studios use the shared confirm dialog, never window.confirm', () => {
  for (const [name, src] of Object.entries(STUDIOS)) assert.doesNotMatch(src, /window\.confirm\(|\bconfirm\(/, name)
  assert.match(STUDIOS.DeckStudio, /<StudioConfirmDialog\b/)
  assert.match(STUDIOS.DocumentStudio, /<StudioConfirmDialog\b/)
})

test('studio colours come from tokens (DS-derived cell fills stay data)', () => {
  assert.equal(count(STUDIOS.DocumentStudio, HEX), 0, 'DocumentStudio hex')
  assert.equal(count(STUDIOS.DocumentStudio, RAW), 0, 'DocumentStudio raw colours')
  assert.equal(count(STUDIOS.DeckStudio, HEX), 0, 'DeckStudio hex')
  // the presentation surface is a projector: black letterbox + white controls
  // on it in both themes, plus the shared modal scrim convention (bg-black/50)
  assert.ok(count(STUDIOS.DeckStudio, RAW) <= 4, `DeckStudio raw colours: ${STUDIOS.DeckStudio.match(RAW)}`)
  // the xlsx "paper" (white sheet + ink) is the exported workbook's own colour,
  // i.e. data, declared once
  assert.ok(count(STUDIOS.SpreadsheetStudio, HEX) <= 2, `SpreadsheetStudio hex: ${STUDIOS.SpreadsheetStudio.match(HEX)}`)
  assert.equal(count(STUDIOS.SpreadsheetStudio, RAW), 0, `SpreadsheetStudio raw: ${STUDIOS.SpreadsheetStudio.match(RAW)}`)
})

test('HtmlSlideInspector uses the type scale, not arbitrary pixel font sizes', () => {
  assert.deepEqual(INSPECTOR.match(/text-\[\d+(?:\.\d+)?px\]/g) || [], [])
})

test('HtmlSlideInspector layer labels come from the locale catalogue', () => {
  for (const pt of ["'Título'", "'Subtítulo'", "'Texto'", "'Bloco'", "'Grupo'", "'Imagem'", "'Tabela'", "'Célula'", "'Gráfico'"])
    assert.ok(!INSPECTOR.includes(pt), `hard-coded ${pt}`)
  assert.match(INSPECTOR, /t\(`inspector\.tag\./)
})

test('studio toolbars are named icon buttons of at least 32 px', () => {
  for (const [name, src] of Object.entries(STUDIOS)) {
    assert.match(src, /StudioIconButton|StudioCloseButton/, name)
    // the bare `p-2` icon buttons of the baseline (24-28 px, named only by title)
    assert.equal(count(src, /className="p-2 (?:-ml-2 )?rounded-lg/g), 0, `${name}: unnamed p-2 icon buttons`)
  }
})
