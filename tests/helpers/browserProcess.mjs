// Teardown for tests that drive a real browser (client/src/styles/tokens.browser.test.js).
// Tested by tests/browserProcess.test.mjs.
//
// Chrome forks helper processes (zygote, renderers, network and storage
// services) that inherit its stderr and can keep flushing into the profile
// after the browser process itself has exited, so 'exit' is not the moment the
// profile goes quiet. The child's 'close' event fires once every holder of the
// stdio pipes has closed them, i.e. once those helpers are gone too. Removing
// the profile before that failed CI with
// `ENOTEMPTY: directory not empty, rmdir '<profile>/Default'`.
import { rm as rmAsync } from 'node:fs/promises'

/** Resolves true when `promise` settles within `ms`, false otherwise. */
function within(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, false) })
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Sends SIGTERM and waits for `closed` (a promise on the child's 'close'
 * event, created right after spawn so it cannot be missed). If that does not
 * happen within `graceMs`, sends SIGKILL and waits up to `killMs` more. Never
 * throws and never waits longer than graceMs + killMs; a timeout is a warning.
 */
export async function stopBrowser(proc, closed, { graceMs = 10000, killMs = 5000, warn = console.warn } = {}) {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill()
  if (await within(closed, graceMs)) return
  warn(`[browser teardown] browser pid ${proc.pid} still running ${graceMs} ms after SIGTERM; sending SIGKILL`)
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
  if (await within(closed, killMs)) return
  warn(`[browser teardown] a process sharing browser pid ${proc.pid}'s stdio is still running ${killMs} ms after SIGKILL; continuing`)
}

/**
 * Removes a temporary directory, retrying transient errors (ENOTEMPTY, EBUSY…).
 * A failure is logged, never thrown: teardown must not fail the test, and a
 * leftover directory under the OS temp dir is harmless.
 */
export async function removeTemp(dir, { rm = rmAsync, warn = console.warn } = {}) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    warn(`[browser teardown] could not remove ${dir}: ${e.message}; leaving it for the OS temp cleaner`)
  }
}
