// Teardown for tests that drive a real browser (client/src/styles/tokens.browser.test.js).
// Tested by tests/browserProcess.test.mjs.
import { rm as rmAsync } from 'node:fs/promises'

/** Stops the browser started by the test. */
export async function stopBrowser(proc, closed, opts = {}) {
  if (proc.exitCode === null) {
    const exited = new Promise((resolve) => proc.once('exit', resolve))
    proc.kill()
    await exited
  }
}

/** Removes a temporary directory the test created. */
export async function removeTemp(dir, { rm = rmAsync } = {}) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
