// Where the Tools popover goes and how tall it may be (WCAG 2.4.11: focus must not end up off-screen).
// Pure so the clamp is unit-tested; ToolsPicker measures the trigger and applies the result at md and up.

/** Space kept between the popover and the viewport edge (includes the 8 px gap to the trigger). */
export const EDGE_MARGIN_PX = 16
/** Opening upward needs at least this much room above the trigger; with less it flips down (if there is more room). */
export const FLIP_BELOW_PX = 320
/** Never shrink the popover below a usable list. */
export const MIN_HEIGHT_PX = 120

export interface FitInput {
  placement: 'up' | 'down'
  triggerTop: number
  triggerBottom: number
  viewportH: number
}
export interface Fit {
  side: 'up' | 'down'
  maxHeight: number
}

export function toolsPopoverFit({ placement, triggerTop, triggerBottom, viewportH }: FitInput): Fit {
  const above = triggerTop - EDGE_MARGIN_PX
  const below = viewportH - triggerBottom - EDGE_MARGIN_PX
  const cap = 0.7 * viewportH
  let side = placement
  if (placement === 'up' && above < FLIP_BELOW_PX && below > above) side = 'down'
  const room = side === 'up' ? above : below
  return { side, maxHeight: Math.max(MIN_HEIGHT_PX, Math.min(cap, room)) }
}
