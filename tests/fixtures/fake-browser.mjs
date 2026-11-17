// Stand-in for Chrome in tests/browserProcess.test.mjs. Chrome forks helper
// processes (zygote, renderers, network and storage services) that inherit its
// stderr and can keep writing into the profile after the browser process has
// exited. This script copies that shape:
//
//   node fake-browser.mjs <profile> <helperMs> [--ignore-term]
//
// It starts one helper that inherits stderr, ignores SIGTERM and writes a file
// into <profile>/Default every 5 ms for <helperMs> ms. When the helper has
// written its first file it prints "ready <helperPid>" on the shared stderr.
// The browser exits on SIGTERM, unless --ignore-term is given.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, ...rest] = process.argv.slice(2)

if (mode === 'helper') {
  const [profile, ms] = rest
  process.on('SIGTERM', () => {})
  const dir = join(profile, 'Default')
  mkdirSync(dir, { recursive: true })
  const end = Date.now() + Number(ms)
  let i = 0
  const tick = () => {
    try {
      writeFileSync(join(dir, `f${i++}`), 'x')
    } catch {
      // the test removed the directory under us; keep running like Chrome would
    }
    if (i === 1) process.stderr.write(`ready ${process.pid}\n`)
    if (Date.now() < end) setTimeout(tick, 5)
    else process.exit(0)
  }
  tick()
} else {
  const profile = mode
  const [ms, flag] = rest
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'helper', profile, ms], { stdio: ['ignore', 'ignore', 'inherit'] })
  process.on('SIGTERM', () => {
    if (flag !== '--ignore-term') process.exit(0)
  })
  setInterval(() => {}, 1000)
}
