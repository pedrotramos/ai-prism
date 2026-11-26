// W3-6 r1: focus hand-off is tracked per studio kind, so a second studio opening or closing while one is open still moves focus.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStudioFocusMap } from './studioFocus.ts'

type El = { id: string; isConnected: boolean; focused: number; focus: () => void }
const el = (id: string, isConnected = true): El => {
  const e: El = { id, isConnected, focused: 0, focus: () => void (e.focused += 1) }
  return e
}

test('each kind remembers its own opener and focuses its own panel', () => {
  const f = createStudioFocusMap<El>()
  const cardDoc = el('card-doc')
  const cardSheet = el('card-sheet')
  const panelDoc = el('panel-doc')
  const panelSheet = el('panel-sheet')
  f.opened('doc', cardDoc, () => panelDoc)
  f.opened('sheet', cardSheet, () => panelSheet)
  assert.equal(panelDoc.focused, 1)
  assert.equal(panelSheet.focused, 1)
  f.closed('sheet', () => panelDoc)
  assert.equal(cardSheet.focused, 1)
  assert.equal(cardDoc.focused, 0)
  assert.equal(panelDoc.focused, 1)
})

test('a gone opener falls back to the remaining panel, then to the last resort', () => {
  const f = createStudioFocusMap<El>()
  const remaining = el('remaining')
  f.opened('deck', el('gone', false), () => null)
  f.closed('deck', () => remaining)
  assert.equal(remaining.focused, 1)
  const composer = el('composer')
  f.opened('deck', null, () => null)
  f.closed('deck', () => composer)
  assert.equal(composer.focused, 1)
})

test('closing a kind that was never opened is a no-op', () => {
  const f = createStudioFocusMap<El>()
  const fb = el('fb')
  f.closed('doc', () => fb)
  assert.equal(fb.focused, 0)
})
