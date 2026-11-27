import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INSTRUCTIONS_SHEET_NAME, instructionsSheetName } from './sheetInstructions.js'

// the export names the generated sheet with this rule; the studio footer calls it with the preview's sheet names

test('no collision: the base name', () => {
  assert.equal(instructionsSheetName([]), INSTRUCTIONS_SHEET_NAME)
  assert.equal(instructionsSheetName(['Vendas', 'Resumo']), INSTRUCTIONS_SHEET_NAME)
})

test('one collision: suffix 2', () => {
  assert.equal(instructionsSheetName(['Vendas', INSTRUCTIONS_SHEET_NAME]), `${INSTRUCTIONS_SHEET_NAME} 2`)
})

test('two collisions: suffix 3', () => {
  assert.equal(instructionsSheetName([INSTRUCTIONS_SHEET_NAME, `${INSTRUCTIONS_SHEET_NAME} 2`]), `${INSTRUCTIONS_SHEET_NAME} 3`)
})

test('a gap is filled from 2 up, and undefined names are ignored', () => {
  assert.equal(instructionsSheetName([INSTRUCTIONS_SHEET_NAME, `${INSTRUCTIONS_SHEET_NAME} 3`, undefined]), `${INSTRUCTIONS_SHEET_NAME} 2`)
})
