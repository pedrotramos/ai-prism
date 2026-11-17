// Teardown of the browser used by client/src/styles/tokens.browser.test.js.
//   node --test tests/browserProcess.test.mjs
// CI flaked with `ENOTEMPTY: directory not empty, rmdir '<profile>/Default'`:
// the profile was removed while Chrome's helper processes were still writing
// into it. tests/fixtures/fake-browser.mjs reproduces that shape without Chrome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopBrowser, removeTemp } from './helpers/browserProcess.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-browser.mjs', import.meta.url))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Starts the fake browser; resolves once its helper is writing into the profile. */
async function startFake(t, helperMs, ...flags) {
  const profile = mkdtempSync(join(tmpdir(), 'prism-fake-browser-'))
  const proc = spawn(process.execPath, [FAKE, profile, String(helperMs), ...flags], { stdio: ['ignore', 'ignore', 'pipe'] })
  const closed = new Promise((resolve) => proc.once('close', resolve))
  const helperPid = await new Promise((resolve, reject) => {
    let err = ''
    proc.stderr.on('data', (d) => {
      err += d
      const m = /ready (\d+)/.exec(err)
      if (m) resolve(Number(m[1]))
    })
    proc.once('exit', (code) => reject(new Error(`fake browser exited early (${code}): ${err}`)))
  })
  t.after(async () => {
    for (const pid of [proc.pid, helperPid]) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await removeTemp(profile, { warn: () => {} })
  })
  return { proc, closed, helperPid, profile }
}

test('stopBrowser returns only once the helpers sharing the browser stderr are gone, so the profile can be removed', { timeout: 15000 }, async (t) => {
  const { proc, closed, profile } = await startFake(t, 1500)
  const warnings = []
  await stopBrowser(proc, closed, { warn: (m) => warnings.push(m) })
  // The helper writes every 5 ms until it exits. Its pid can outlive 'close'
  // for a moment (exited, not yet reaped), so check the writes, not the pid.
  const files = () => readdirSync(join(profile, 'Default')).length
  const before = files()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(files(), before, 'a helper was still writing into the profile when stopBrowser returned')
  await removeTemp(profile, { warn: (m) => warnings.push(m) })
  assert.equal(existsSync(profile), false)
  assert.deepEqual(warnings, [])
})

test('stopBrowser sends SIGKILL when the browser ignores SIGTERM for graceMs', { timeout: 5000 }, async (t) => {
  const { proc, closed } = await startFake(t, 0, '--ignore-term')
  const warnings = []
  await stopBrowser(proc, closed, { graceMs: 300, killMs: 3000, warn: (m) => warnings.push(m) })
  assert.equal(proc.signalCode, 'SIGKILL')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /SIGKILL/)
})

test('stopBrowser gives up and warns when a helper keeps the stderr pipe open past the bound', { timeout: 5000 }, async (t) => {
  const { proc, closed, helperPid } = await startFake(t, 20000)
  const warnings = []
  const started = Date.now()
  await stopBrowser(proc, closed, { graceMs: 200, killMs: 200, warn: (m) => warnings.push(m) })
  assert.ok(Date.now() - started < 2000, `stopBrowser took ${Date.now() - started} ms`)
  assert.equal(alive(helperPid), true, 'precondition: the helper is still running')
  assert.equal(warnings.length, 2)
  assert.match(warnings[1], /still running/)
})

test('removeTemp warns instead of throwing when the directory cannot be removed', async () => {
  const enotempty = Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir '/tmp/x/Default'"), { code: 'ENOTEMPTY' })
  const warnings = []
  await removeTemp('/tmp/x', { rm: async () => { throw enotempty }, warn: (m) => warnings.push(m) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ENOTEMPTY/)
  assert.match(warnings[0], /\/tmp\/x/)
})
