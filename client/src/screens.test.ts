// W2-4 item 7: the a11y/e2e SCREENS matrix covers the screens the revamp added, and every screen is a step function.
import { test } from 'node:test'
import assert from 'node:assert/strict'
// the harness is plain .mjs shared with Playwright
import { SCREENS as SCREENS_MAP, VARIANTS } from '../e2e/lib.mjs'

const SCREENS = SCREENS_MAP as Record<string, unknown>

test('SCREENS includes the projects, agents and costs screens', () => {
  for (const name of ['projects', 'agents', 'costs']) assert.equal(typeof SCREENS[name], 'function', name)
})

test('SCREENS keeps the four original screens', () => {
  for (const name of ['welcome', 'chat-rich', 'settings-preferences', 'deck-studio']) assert.equal(typeof SCREENS[name], 'function', name)
})

test('every variant is light or dark at 1440 or 390', () => {
  assert.deepEqual(
    VARIANTS.map((v: { theme: string; mobile: boolean }) => `${v.theme}-${v.mobile ? 390 : 1440}`).sort(),
    ['dark-1440', 'dark-390', 'light-1440', 'light-390']
  )
})
