import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtNumber, fmtStat } from './sheetFormat.ts'

// The studio grid and the selection footer follow the interface language (en / pt / es); the exported .xlsx is a
// separate path and is not formatted here.

test('fmtStat groups and rounds with the UI locale', () => {
  assert.equal(fmtStat(208.2, 'en'), '208.2')
  assert.equal(fmtStat(208.2, 'pt'), '208,2')
  assert.equal(fmtStat(208.2, 'es'), '208,2')
  assert.equal(fmtStat(12345.678, 'en'), '12,345.68')
  assert.equal(fmtStat(12345.678, 'pt'), '12.345,68')
  assert.equal(fmtStat(12345.678, 'es'), '12.345,68')
})

test('fmtStat shows a dash for a non-finite number', () => {
  assert.equal(fmtStat(Infinity, 'en'), '—')
  assert.equal(fmtStat(NaN, 'pt'), '—')
})

test('fmtNumber: percent and number follow the locale', () => {
  assert.equal(fmtNumber(0.123, 'percent', 'en'), '12.3%')
  assert.equal(fmtNumber(0.123, 'percent', 'pt'), '12,3%')
  assert.equal(fmtNumber(1234.5, 'number', 'en'), '1,234.50')
  assert.equal(fmtNumber(1234.5, 'number', 'pt'), '1.234,50')
  assert.equal(fmtNumber(1234567, 'integer', 'en'), '1,234,567')
  assert.equal(fmtNumber(1234567, 'integer', 'es'), '1.234.567')
})

test('fmtNumber: the currency symbol belongs to the format, the separators to the locale', () => {
  assert.equal(fmtNumber(1234.5, 'currency', 'en'), 'R$ 1,234.50')
  assert.equal(fmtNumber(1234.5, 'currency', 'pt'), 'R$ 1.234,50')
  assert.equal(fmtNumber(1234.5, 'usd', 'en'), '$1,234.50')
  assert.equal(fmtNumber(1234.5, 'usd', 'pt'), '$1.234,50')
  assert.equal(fmtNumber(1234.5, 'eur', 'es'), '€ 1.234,50')
})

test('fmtNumber: empty and non-numeric values pass through', () => {
  assert.equal(fmtNumber(null, 'number', 'en'), '')
  assert.equal(fmtNumber('', 'number', 'en'), '')
  assert.equal(fmtNumber('abc', 'number', 'en'), 'abc')
  assert.equal(fmtNumber(5, undefined, 'en'), '5')
  assert.equal(fmtNumber(0.5, 'percent0', 'en'), '50%')
})

test('an unknown locale falls back to pt', () => {
  assert.equal(fmtStat(208.2, 'xx'), '208,2')
})
