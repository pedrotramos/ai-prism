// W3-2 item 3: the studio's footer note names the sheet exactly as the downloaded file has it, so the name comes
// from one constant that the export and the studio share. Reopens a real .xlsx.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { renderXlsx } from './xlsx-export.ts'
import { INSTRUCTIONS_SHEET_NAME, instructionsSheetName } from '../shared/sheetInstructions.js'

const SPEC = { type: 'spreadsheet', title: 'T', sheets: [{ name: 'S', blocks: [{ kind: 'section', text: 'Header' }] }] }

test('the constant is the name of the instructions sheet in the exported workbook', async () => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await renderXlsx(SPEC, null)) as unknown as ArrayBuffer)
  assert.equal(INSTRUCTIONS_SHEET_NAME, 'Instruções de Uso')
  assert.ok(wb.getWorksheet(INSTRUCTIONS_SHEET_NAME), wb.worksheets.map((w) => w.name).join(', '))
})

test('a source tab with the reserved name: the generated sheet gets the name the studio footer computes', async () => {
  const spec = { ...SPEC, sheets: [...SPEC.sheets, { name: INSTRUCTIONS_SHEET_NAME, blocks: [{ kind: 'section', text: 'Mine' }] }] }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await renderXlsx(spec, null)) as unknown as ArrayBuffer)
  const expected = instructionsSheetName(spec.sheets.map((s) => s.name))
  assert.equal(expected, `${INSTRUCTIONS_SHEET_NAME} 2`)
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['S', INSTRUCTIONS_SHEET_NAME, expected])
})
