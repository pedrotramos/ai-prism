// Share closes every studio that holds unsaved work, one at a time, through the studio's own prompt, and stops at the
// first one the user cancels (design-guarded-close.md). closeUnsavedStudios is the pure loop; the studios own the prompts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLOSE_ORDER, closeUnsavedStudios } from './studioClose.ts'
import type { CloseOutcome, StudioCloseHandle, StudioKind } from './studioClose.ts'

type Handles = Record<StudioKind, { current: StudioCloseHandle | null }>

/** A fake studio: `dirty` is what hasUnsavedWork says, `outcome` what requestClose resolves (a promise to hold it open). */
function fake(kind: StudioKind, log: string[], dirty: boolean, outcome: CloseOutcome | Promise<CloseOutcome> = 'closed'): { current: StudioCloseHandle } {
  return {
    current: {
      hasUnsavedWork: () => dirty,
      requestClose: () => {
        log.push(`close:${kind}`)
        return Promise.resolve(outcome)
      },
    },
  }
}

test('the order is document, deck, spreadsheet', () => {
  assert.deepEqual([...CLOSE_ORDER], ['doc', 'deck', 'sheet'])
})

test('(a) a clean studio is skipped: it is never asked to close', async () => {
  const log: string[] = []
  const handles: Handles = { doc: fake('doc', log, true), deck: fake('deck', log, false), sheet: fake('sheet', log, false) }
  assert.equal(await closeUnsavedStudios(handles), true)
  assert.deepEqual(log, ['close:doc'])
})

test('(b) dirty studios are closed in CLOSE_ORDER, one at a time: the second is not asked before the first answers', async () => {
  const log: string[] = []
  let answerDoc!: (o: CloseOutcome) => void
  const heldDoc = new Promise<CloseOutcome>((resolve) => (answerDoc = resolve))
  // the sheet is listed first on purpose: the order comes from CLOSE_ORDER, not from the object
  const handles: Handles = { sheet: fake('sheet', log, true), deck: fake('deck', log, true), doc: fake('doc', log, true, heldDoc) }
  const done = closeUnsavedStudios(handles)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(log, ['close:doc'], 'only the document has been asked while its prompt is open')
  answerDoc('closed')
  assert.equal(await done, true)
  assert.deepEqual(log, ['close:doc', 'close:deck', 'close:sheet'])
})

test('(c) it stops at the first cancel and never asks the studios after it', async () => {
  const log: string[] = []
  const handles: Handles = { doc: fake('doc', log, true), deck: fake('deck', log, true, 'cancelled'), sheet: fake('sheet', log, true) }
  assert.equal(await closeUnsavedStudios(handles), false)
  assert.deepEqual(log, ['close:doc', 'close:deck'])
})

test('(c) a cancel of the first studio asks nobody else', async () => {
  const log: string[] = []
  const handles: Handles = { doc: fake('doc', log, true, 'cancelled'), deck: fake('deck', log, true), sheet: fake('sheet', log, true) }
  assert.equal(await closeUnsavedStudios(handles), false)
  assert.deepEqual(log, ['close:doc'])
})

test('(d) with every handle null or clean it answers true and asks nobody', async () => {
  const log: string[] = []
  assert.equal(await closeUnsavedStudios({ doc: { current: null }, deck: { current: null }, sheet: { current: null } }), true)
  const clean: Handles = { doc: fake('doc', log, false), deck: fake('deck', log, false), sheet: fake('sheet', log, false) }
  assert.equal(await closeUnsavedStudios(clean), true)
  assert.deepEqual(log, [])
})

test('an outcome that is not "closed" counts as a cancel (an unknown answer is never success)', async () => {
  const log: string[] = []
  const handles: Handles = { doc: fake('doc', log, true, undefined as unknown as CloseOutcome), deck: fake('deck', log, true), sheet: fake('sheet', log, false) }
  assert.equal(await closeUnsavedStudios(handles), false)
  assert.deepEqual(log, ['close:doc'])
})
