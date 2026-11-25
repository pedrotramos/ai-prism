// Share leaves the chat for the project, and the open studio has to go with it. A studio with unsaved hand edits
// guards its own close (a Save / Discard / Cancel prompt), so the shell never clears the studio ids behind its back:
// it presses the studio's own close control and waits for the outcome. One path for every studio; a studio only
// has to mark itself with data-studio-dirty while it holds work that a close would lose.

const STUDIO = '[data-studio]'

/** True while the open studio holds unsaved work (it says so with data-studio-dirty). */
export const hasUnsavedStudio = (): boolean => !!document.querySelector(`${STUDIO}[data-studio-dirty]`)

/**
 * Closes the open studio through its own close control, so its unsaved-work guard runs.
 * Resolves true once the studio is gone (clean, or the user chose Save / Discard), false when the user cancelled the
 * prompt (the studio stays, with its draft). With no studio open there is nothing to close: true.
 */
export function closeStudioGuarded(): Promise<boolean> {
  const root = document.querySelector<HTMLElement>(STUDIO)
  const control = root?.querySelector<HTMLElement>('[data-studio-close]')
  if (!root || !control) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let sawPrompt = false
    let settled = false
    const observer = new MutationObserver(() => check())
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      observer.disconnect()
      resolve(ok)
    }
    const check = (final = false) => {
      if (!root.isConnected) return done(true)
      if (document.querySelector('[role="alertdialog"]')) {
        sawPrompt = true
        return
      }
      // the prompt came and went with the studio still here: Cancel. No prompt at all after the click settled: the
      // close was refused for another reason, the studio stays and so does Share.
      if (sawPrompt || final) done(false)
    }
    observer.observe(document.body, { childList: true, subtree: true })
    control.click()
    // React flushes a click's state before the next frame: by the second one the studio is gone or its prompt is up
    requestAnimationFrame(() => requestAnimationFrame(() => check(true)))
  })
}
