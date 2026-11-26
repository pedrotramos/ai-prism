// W3-6 #2: the Tools popover opening upward is clamped to the room above the trigger, or flips down when that room is small.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolsPopoverFit, FLIP_BELOW_PX, EDGE_MARGIN_PX } from './toolsPlacement.ts'

test('plenty of room above: stays up, capped at 70vh', () => {
  const r = toolsPopoverFit({ placement: 'up', triggerTop: 800, triggerBottom: 840, viewportH: 900 })
  assert.equal(r.side, 'up')
  assert.equal(r.maxHeight, Math.min(0.7 * 900, 800 - EDGE_MARGIN_PX))
})

test('a short viewport: the popover never reaches above the viewport edge', () => {
  // 600 px tall, trigger near the bottom: only ~500 px above, but the 70vh cap is 420
  const r = toolsPopoverFit({ placement: 'up', triggerTop: 520, triggerBottom: 560, viewportH: 600 })
  assert.equal(r.side, 'up')
  assert.ok(r.maxHeight <= 520 - EDGE_MARGIN_PX)
})

test('little room above flips down and clamps to the room below', () => {
  const r = toolsPopoverFit({ placement: 'up', triggerTop: FLIP_BELOW_PX - 20, triggerBottom: FLIP_BELOW_PX + 20, viewportH: 900 })
  assert.equal(r.side, 'down')
  assert.ok(r.maxHeight <= 900 - (FLIP_BELOW_PX + 20) - EDGE_MARGIN_PX)
})

test('a down placement is clamped to the room below', () => {
  const r = toolsPopoverFit({ placement: 'down', triggerTop: 100, triggerBottom: 140, viewportH: 600 })
  assert.equal(r.side, 'down')
  assert.ok(r.maxHeight <= 600 - 140 - EDGE_MARGIN_PX)
})

test('never returns a height under a usable minimum', () => {
  const r = toolsPopoverFit({ placement: 'up', triggerTop: 10, triggerBottom: 50, viewportH: 80 })
  assert.ok(r.maxHeight >= 120)
})
