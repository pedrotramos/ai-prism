import { useEffect, useRef, type RefObject } from 'react'

// Modal dialog behaviour for an element that renders only while open:
// initial focus moves in, Tab / Shift+Tab wrap inside, Escape closes, and on
// close focus returns to the exact element that had it when the dialog opened.
// Nested dialogs work: listeners sit on the dialog element, so the innermost
// one handles a key first and stops it from reaching its parent.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

export const focusablesIn = (el: ParentNode): HTMLElement[] =>
  [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0 && !n.closest('[inert]'))

interface ModalDialogOptions {
  onClose?: () => void
  initialFocus?: (el: HTMLElement) => HTMLElement | null | undefined
  returnFocus?: () => Element | null | undefined
}

// `returnFocus` names a fallback for when the opener is gone by close time
// (e.g. a menu item that unmounted when it opened this dialog).
export function useModalDialog(ref: RefObject<HTMLElement | null>, { onClose, initialFocus, returnFocus }: ModalDialogOptions = {}): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const opener = document.activeElement
    const first = (typeof initialFocus === 'function' ? initialFocus(el) : null) || focusablesIn(el)[0] || el
    first.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusablesIn(el)
      if (!list.length) {
        e.preventDefault()
        el.focus()
        return
      }
      const head = list[0] as HTMLElement // list is non-empty here
      const tail = list[list.length - 1] as HTMLElement
      const active = document.activeElement
      if (e.shiftKey && (active === head || !el.contains(active))) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && (active === tail || !el.contains(active))) {
        e.preventDefault()
        head.focus()
      }
    }
    // focus that lands outside (a click on the page behind, an async re-render)
    // is pulled back in, unless it went into a dialog nested inside this one
    const onFocusIn = (e: FocusEvent) => {
      if (el.contains(e.target as Node | null)) return
      if (e.target instanceof Element && e.target.closest('[role="dialog"][aria-modal="true"]')) return
      ;(focusablesIn(el)[0] || el).focus({ preventScroll: true })
    }
    // focus can also fall to <body> without a focusin (a focused button that
    // becomes disabled or unmounts): the next Tab / Escape there still belongs
    // to the topmost dialog, i.e. this one when no modal is nested inside it
    const onDocKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.key !== 'Tab' && e.key !== 'Escape')) return
      const active = document.activeElement
      if (active && active !== document.body && active !== document.documentElement) return
      if (el.querySelector('[role="dialog"][aria-modal="true"]')) return
      onKey(e)
    }
    el.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onDocKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      el.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onDocKey)
      document.removeEventListener('focusin', onFocusIn)
      const usable = (n: unknown): n is HTMLElement => n instanceof HTMLElement && n.isConnected && n !== document.body
      const target = usable(opener) ? opener : returnFocus?.()
      if (usable(target)) target.focus({ preventScroll: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
