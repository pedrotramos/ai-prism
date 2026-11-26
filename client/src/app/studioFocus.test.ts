// W3-6 #3: opening a studio moves focus into the studio panel; closing it returns focus to the control that opened it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStudioFocus } from './studioFocus.ts'

type El = { id: string; isConnected: boolean; focused: number; focus: () => void }
const el = (id: string, isConnected = true): El => {
  const e: El = { id, isConnected, focused: 0, focus: () => void (e.focused += 1) }
  return e
}

test('open focuses the panel; the opener is remembered', () => {
  const opener = el('card')
  const panel = el('panel')
  const f = createStudioFocus<El>()
  f.opened(opener, () => panel)
  assert.equal(panel.focused, 1)
  assert.equal(opener.focused, 0)
})

test('close returns focus to the opener', () => {
  const opener = el('card')
  const f = createStudioFocus<El>()
  f.opened(opener, () => el('panel'))
  f.closed()
  assert.equal(opener.focused, 1)
})

test('close twice only restores once', () => {
  const opener = el('card')
  const f = createStudioFocus<El>()
  f.opened(opener, () => el('panel'))
  f.closed()
  f.closed()
  assert.equal(opener.focused, 1)
})

test('a detached opener is skipped (no throw)', () => {
  const opener = el('card', false)
  const f = createStudioFocus<El>()
  f.opened(opener, () => el('panel'))
  f.closed()
  assert.equal(opener.focused, 0)
})

test('no panel yet: open does not throw and still remembers the opener', () => {
  const opener = el('card')
  const f = createStudioFocus<El>()
  f.opened(opener, () => null)
  f.closed()
  assert.equal(opener.focused, 1)
})

test('a body/null opener is never restored', () => {
  const f = createStudioFocus<El>()
  f.opened(null, () => el('panel'))
  assert.doesNotThrow(() => f.closed())
})
