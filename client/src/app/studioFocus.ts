// Studio focus hand-off (WCAG 2.4.3): opening a studio moves keyboard focus into ITS panel, closing it gives focus back to
// the control that opened THAT studio. Tracked per studio kind, so a second studio opening or closing while another one is
// open hands focus off too. Pure over a minimal element shape so it is unit-tested.
export interface Focusable {
  isConnected: boolean
  focus: () => void
}

export function createStudioFocusMap<T extends Focusable>() {
  const openers = new Map<string, T | null>()
  return {
    /** Remember who opened `kind` and focus its panel (when it is already mounted). */
    opened(kind: string, from: T | null, panel: () => T | null) {
      openers.set(kind, from)
      panel()?.focus()
    },
    /** Give focus back to the opener of `kind`; when it is gone, to `fallback` (the remaining studio, then the composer). */
    closed(kind: string, fallback: () => T | null) {
      if (!openers.has(kind)) return
      const el = openers.get(kind)
      openers.delete(kind)
      if (el && el.isConnected) el.focus()
      else fallback()?.focus()
    },
  }
}
