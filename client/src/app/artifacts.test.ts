import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestArtifact } from './artifacts.ts'

test('no blocks, no artifact', () => {
  assert.equal(latestArtifact([]), null)
  assert.equal(latestArtifact([{ blocks: null }, { blocks: [{ type: 'chart' }] }]), null)
})

test('the last artifact block of the thread wins, whatever its kind', () => {
  const msgs = [
    { blocks: [{ type: 'deck', deckId: 9 }] },
    { blocks: [{ type: 'spreadsheet', spreadsheetId: '8' }, { type: 'document', documentId: '18' }] },
    { blocks: [] },
  ]
  assert.deepEqual(latestArtifact(msgs), { kind: 'document', id: '18' })
  assert.deepEqual(latestArtifact(msgs.slice(0, 1)), { kind: 'deck', id: 9 })
})

test('an artifact block still without an id (being generated) is skipped', () => {
  assert.deepEqual(latestArtifact([{ blocks: [{ type: 'deck', deckId: 9 }, { type: 'deck-html', deckId: null }] }]), { kind: 'deck', id: 9 })
})
