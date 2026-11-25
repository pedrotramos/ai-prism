import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INSTRUCTIONS_SHEET_NAME, hasInstructionsSheet } from './sheetInstructions.ts'

// The footer note points at the instructions sheet, so it shows only when the workbook carries that sheet. The name
// is the one server/xlsx-export.ts gives the sheet (with " 2", " 3"... when the model already used the name).

test('the name matches the one the export writes', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../../server/xlsx-export.ts', import.meta.url), 'utf8')
  assert.ok(src.includes(`let name = '${INSTRUCTIONS_SHEET_NAME}'`))
})

test('no sheets, or none with that name: no instructions sheet', () => {
  assert.equal(hasInstructionsSheet(undefined), false)
  assert.equal(hasInstructionsSheet([]), false)
  assert.equal(hasInstructionsSheet([{ name: 'Vendas' }, { name: 'Resumo' }]), false)
})

test('the sheet is found by name, including the deduplicated name', () => {
  assert.equal(hasInstructionsSheet([{ name: 'Vendas' }, { name: INSTRUCTIONS_SHEET_NAME }]), true)
  assert.equal(hasInstructionsSheet([{ name: `${INSTRUCTIONS_SHEET_NAME} 2` }]), true)
  assert.equal(hasInstructionsSheet([{ name: `${INSTRUCTIONS_SHEET_NAME} extra` }]), false)
})
