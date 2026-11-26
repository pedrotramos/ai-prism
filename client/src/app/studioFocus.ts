// Studio focus hand-off (WCAG 2.4.3): opening a studio moves keyboard focus into its panel (a dialog named by its title,
// tabIndex -1), closing it gives focus back to the control that opened it. Pure over a minimal element shape so it is unit-tested.
export interface Focusable {
  isConnected: boolean
  focus: () => void
}

export function createStudioFocus<T extends Focusable>() {
  let opener: T | null = null
  return {
    /** Remember who opened the studio and focus the panel (when it is already mounted). */
    opened(from: T | null, panel: () => T | null) {
      opener = from
      panel()?.focus()
    },
    /** Give focus back to the opener once, when it is still on the page. */
    closed() {
      const el = opener
      opener = null
      if (el && el.isConnected) el.focus()
    },
  }
}
