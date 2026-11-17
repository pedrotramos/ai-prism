// Behaviour of the deploy wrappers (deploy.sh, deploy.ps1) around the steps that
// no workspace call can check for us: they must build the artifacts before
// `bundle deploy`, run the post-deploy smoke after the auto-config, and fail the
// whole run when either of those fails.
//
// Each test copies the wrapper and app.yaml into a temp directory (the wrapper
// edits app.yaml and writes .databricks/ next to itself) and runs it with a PATH
// that holds only a fake `databricks` CLI, a fake `npm` and the few system tools
// the wrapper uses. The fakes append every call to a log file; the assertions
// read that log. Nothing here talks to a workspace.
//
// deploy.ps1 runs under `pwsh` (PowerShell 7). GitHub's ubuntu runners ship it;
// locally set PWSH=/path/to/pwsh when it is not on PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = 'https://ai-prism-1234.aws.databricksapps.com'
const FAKE_TOKEN = 'fake-oauth-token-never-printed'

function which(bin) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

const PWSH = process.env.PWSH || which('pwsh')

// The fake CLI: logs `databricks <args>` and answers the calls the wrappers make.
// FAKE_DB_FAIL="<word>" makes any call whose arguments contain <word> exit 1.
const FAKE_DATABRICKS = `#!/bin/bash
echo "databricks $*" >> "$FAKE_LOG"
if [ -n "$FAKE_DB_FAIL" ] && [[ " $* " == *" $FAKE_DB_FAIL "* ]]; then echo "fake failure: $*" >&2; exit 1; fi
case "$1 $2" in
  "postgres get-project") exit 1 ;;
  "bundle summary") echo '{"workspace":{"file_path":"/Workspace/Users/op@example.com/.bundle/ai-prism/dev/files"},"resources":{"jobs":{"ai_prism_auto_config":{"id":"42"}}}}' ;;
  "apps get") echo '{"name":"ai-prism","url":"${APP_URL}"}' ;;
  "auth token") echo '{"access_token":"${FAKE_TOKEN}","token_type":"Bearer","expires_in":3599,"expiry":"2099-01-01T00:00:00Z"}' ;;
esac
exit 0
`

// The fake npm: logs the script name, the APP_URL it got and whether a token was
// passed (never the token itself). FAKE_NPM_FAIL="<script>" makes that script fail.
const FAKE_NPM = `#!/bin/bash
if [ -n "$DATABRICKS_TOKEN" ]; then tok=set; else tok=unset; fi
if [ "$DATABRICKS_TOKEN" = "${FAKE_TOKEN}" ]; then tok=expected; fi
echo "npm $* APP_URL=\${APP_URL:-} TOKEN=$tok" >> "$FAKE_LOG"
if [ -n "$FAKE_NPM_FAIL" ] && [ "$2" = "$FAKE_NPM_FAIL" ]; then echo "fake npm failure: $2" >&2; exit 1; fi
exit 0
`

const SYSTEM_TOOLS = ['bash', 'sh', 'sed', 'awk', 'mktemp', 'rm', 'dirname', 'cat', 'env', 'python3', 'mkdir', 'grep', 'tr', 'head']

function sandbox(script, { npm = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-prism-deploy-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  for (const tool of SYSTEM_TOOLS) {
    const p = which(tool)
    if (p) symlinkSync(realpathSync(p), path.join(bin, tool))
  }
  writeFileSync(path.join(bin, 'databricks'), FAKE_DATABRICKS)
  chmodSync(path.join(bin, 'databricks'), 0o755)
  if (npm) {
    writeFileSync(path.join(bin, 'npm'), FAKE_NPM)
    chmodSync(path.join(bin, 'npm'), 0o755)
  }
  copyFileSync(path.join(ROOT, script), path.join(dir, script))
  copyFileSync(path.join(ROOT, 'app.yaml'), path.join(dir, 'app.yaml'))
  const log = path.join(dir, 'calls.log')
  writeFileSync(log, '')
  return { dir, bin, log }
}

function cleanEnv(extra) {
  const env = {}
  for (const k of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[k]) env[k] = process.env[k]
  return { ...env, ...extra }
}

function runSh(args = [], { env = {}, npm = true } = {}) {
  const box = sandbox('deploy.sh', { npm })
  const r = spawnSync(path.join(box.bin, 'bash'), [path.join(box.dir, 'deploy.sh'), ...args], {
    cwd: box.dir,
    encoding: 'utf8',
    env: cleanEnv({ PATH: box.bin, FAKE_LOG: box.log, ...env }),
    timeout: 60_000,
  })
  return finish(box, r)
}

function runPs1(args = [], { env = {}, npm = true } = {}) {
  const box = sandbox('deploy.ps1', { npm })
  const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', path.join(box.dir, 'deploy.ps1'), ...args], {
    cwd: box.dir,
    encoding: 'utf8',
    env: cleanEnv({ PATH: box.bin, FAKE_LOG: box.log, ...env }),
    timeout: 120_000,
  })
  return finish(box, r)
}

function finish(box, r) {
  const calls = readFileSync(box.log, 'utf8').split('\n').filter(Boolean)
  rmSync(box.dir, { recursive: true, force: true })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, calls }
}

/** Index of the first logged call that starts with `prefix` (-1 when absent). */
function at(calls, prefix) {
  return calls.findIndex((c) => c.startsWith(prefix))
}

function assertBuildDeploySmokeOrder(res) {
  assert.equal(res.code, 0, res.out)
  const build = at(res.calls, 'npm run bundle')
  const deploy = at(res.calls, 'databricks bundle deploy')
  const appsDeploy = at(res.calls, 'databricks apps deploy')
  const autoConfig = at(res.calls, 'databricks bundle run')
  const smoke = at(res.calls, 'npm run smoke')
  assert.ok(build >= 0, `npm run bundle never ran:\n${res.calls.join('\n')}`)
  assert.ok(build < deploy, 'the build must run before bundle deploy')
  assert.ok(deploy < appsDeploy && appsDeploy < autoConfig, 'deploy order changed')
  assert.ok(smoke > autoConfig, 'the smoke must run after the auto-config job')
  assert.match(res.calls[smoke], new RegExp(`APP_URL=${APP_URL.replace(/[.]/g, '\\.')} TOKEN=expected`))
  assert.ok(!res.out.includes(FAKE_TOKEN), 'the OAuth token must never be printed')
}

const SHELLS = [
  { name: 'deploy.sh', run: runSh, skipBuild: ['--skip-build'], skipSmoke: ['--skip-smoke'], skip: false },
  { name: 'deploy.ps1', run: runPs1, skipBuild: ['-SkipBuild'], skipSmoke: ['-SkipSmoke'], skip: !PWSH && 'pwsh not installed (set PWSH=/path/to/pwsh)' },
]

for (const sh of SHELLS) {
  const t = (name, fn) => test(`${sh.name}: ${name}`, { skip: sh.skip }, fn)

  t('builds before bundle deploy and runs the smoke against the app URL after the auto-config', () => {
    assertBuildDeploySmokeOrder(sh.run(['DEV']))
  })

  t('a failed build stops the run before anything is deployed', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NPM_FAIL: 'bundle' } })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'databricks bundle deploy'), -1, 'bundle deploy ran after a failed build')
    assert.match(res.out, /skip-?build/i)
  })

  t('a failed smoke makes the run exit non-zero after the deploy', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NPM_FAIL: 'smoke' } })
    assert.notEqual(res.code, 0, res.out)
    assert.ok(at(res.calls, 'databricks bundle run') >= 0, 'the deploy should have completed')
    assert.match(res.out, /smoke/i)
    assert.match(res.out, /skip-?smoke/i)
  })

  t('the skip flags turn off the build and the smoke', () => {
    const res = sh.run([...sh.skipBuild, ...sh.skipSmoke, 'DEV'])
    assert.equal(res.code, 0, res.out)
    assert.equal(at(res.calls, 'npm '), -1, `npm ran:\n${res.calls.join('\n')}`)
    assert.ok(at(res.calls, 'databricks bundle deploy') >= 0)
  })

  t('AI_PRISM_SKIP_BUILD=1 and AI_PRISM_SKIP_SMOKE=1 work like the flags', () => {
    const res = sh.run(['DEV'], { env: { AI_PRISM_SKIP_BUILD: '1', AI_PRISM_SKIP_SMOKE: '1' } })
    assert.equal(res.code, 0, res.out)
    assert.equal(at(res.calls, 'npm '), -1, `npm ran:\n${res.calls.join('\n')}`)
  })

  t('without npm on PATH it fails before deploying and names the escape flags', () => {
    const res = sh.run(['DEV'], { npm: false })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'databricks bundle deploy'), -1)
    assert.match(res.out, /npm/)
    assert.match(res.out, /skip-?build/i)
  })

  t('without npm, skipping both steps still deploys', () => {
    const res = sh.run([...sh.skipBuild, ...sh.skipSmoke, 'DEV'], { npm: false })
    assert.equal(res.code, 0, res.out)
    assert.ok(at(res.calls, 'databricks bundle run') >= 0)
  })

  t('no OAuth token for the smoke is a failure, not a silent pass', () => {
    const res = sh.run(['DEV'], { env: { FAKE_DB_FAIL: 'token' } })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'npm run smoke'), -1)
    assert.match(res.out, /skip-?smoke/i)
  })
}

test('deploy.sh --help documents --skip-build and --skip-smoke', () => {
  const res = runSh(['--help'])
  assert.equal(res.code, 0, res.out)
  assert.match(res.out, /--skip-build/)
  assert.match(res.out, /--skip-smoke/)
  assert.match(res.out, /AI_PRISM_SKIP_BUILD/)
  assert.match(res.out, /AI_PRISM_SKIP_SMOKE/)
  assert.equal(res.calls.length, 0, '--help must not call anything')
})

test('CI has pwsh, so the deploy.ps1 tests never skip there', () => {
  if (!process.env.CI) return
  assert.ok(PWSH && existsSync(PWSH), 'CI must run the deploy.ps1 tests: install PowerShell 7 or set PWSH')
})
