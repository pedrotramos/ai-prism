// N5 AC2: the exported workbook's section-header font follows the WCAG ink
// rule. Reopens a real .xlsx and reads the font colour back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { renderXlsx } from './xlsx-export.js'
import { contrastRatio } from '../shared/deckTheme.js'

const SPEC = {
  type: 'spreadsheet',
  title: 'Ink',
  sheets: [{ name: 'S', blocks: [{ kind: 'section', text: 'Section header' }] }],
}

async function sectionCell(template) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await renderXlsx(SPEC, template))
  const cell = wb.getWorksheet('S').getCell(1, 1)
  assert.equal(cell.value, 'Section header')
  return { fill: cell.fill.fgColor.argb, font: cell.font.color.argb }
}

test('xlsx section header: mid-tone theme gets dark ink (AA), not white (3.6:1)', async () => {
  const mid = { primaryColor: '#E8743B', secondaryColor: '#E8743B', accentColor: '#2272B4', backgroundColor: '#FFFFFF' }
  const { fill, font } = await sectionCell(mid)
  assert.equal(fill, 'FFE8743B')
  assert.equal(font, 'FF1A1A1A')
  assert.ok(contrastRatio('#' + fill.slice(2), '#' + font.slice(2)) >= 4.5)
})

test('xlsx section header: dark theme keeps white ink', async () => {
  const dark = { primaryColor: '#1B3139', secondaryColor: '#1B3139', accentColor: '#2272B4', backgroundColor: '#FFFFFF' }
  const { font } = await sectionCell(dark)
  assert.equal(font, 'FFFFFFFF')
})
