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
import pg from 'pg'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = 'https://ai-prism-1234.aws.databricksapps.com'
const FAKE_TOKEN = 'fake-oauth-token-never-printed'
const FAKE_PG_TOKEN = 'fake-pg-credential-never-printed'
const FAKE_SP = '00000000-1111-2222-3333-444444444444'

function which(bin) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

const PWSH = process.env.PWSH || which('pwsh')

// The fake CLI: logs `databricks <args>` and answers the calls the wrappers make.
// FAKE_DB_FAIL="<word>" makes any call whose arguments contain <word> exit 1.
const CLEAN_PLAN = '{"plan_version":2,"plan":{"resources.apps.ai_prism":{"action":"update"},"resources.jobs.ai_prism_auto_config":{"action":"skip"}}}'
const FAKE_DATABRICKS = `#!/bin/bash
# the plan gate: capability probes (--help, not logged) answer like a CLI >= 1.17 (FAKE_OLD_CLI=1: an older one);
# \`bundle plan\` returns a clean direct-engine plan (FAKE_PLAN='<text>' overrides it, FAKE_PLAN_2 is the
# 2nd plan of a run, FAKE_PLAN_FAIL=1 makes the command fail); \`bundle deploy\` must be given the saved
# plan (--plan <file>) and logs that file's content; FAKE_DEPLOY_ERR_FIRST makes the 1st deploy fail with
# that message.
if [[ " $* " == *" --help "* ]]; then
  case "$1 $2" in
    "bundle deploy") [ -n "$FAKE_OLD_CLI" ] || echo "      --plan string   Path to a saved plan file" ;;
    "bundle plan") [ -n "$FAKE_OLD_CLI" ] && exit 1 ;;
  esac
  exit 0
fi
echo "databricks $*" >> "$FAKE_LOG"
if [ -n "$FAKE_DB_FAIL" ] && [[ " $* " == *" $FAKE_DB_FAIL "* ]]; then echo "fake failure: $*" >&2; exit 1; fi
count() { local n=0; [ -f "$FAKE_LOG.$1" ] && n=$(cat "$FAKE_LOG.$1"); n=$((n+1)); echo "$n" > "$FAKE_LOG.$1"; echo "$n"; }
case "$1 $2" in
  "bundle plan")
    [ -n "$FAKE_PLAN_FAIL" ] && { echo "fake plan failure" >&2; exit 1; }
    n=$(count plan)
    if [ "$n" = 2 ] && [ -n "$FAKE_PLAN_2" ]; then echo "$FAKE_PLAN_2"
    elif [ -n "$FAKE_PLAN" ]; then echo "$FAKE_PLAN"
    else echo '${CLEAN_PLAN}'; fi ;;
  "bundle deploy")
    pf=""; prev=""; for a in "$@"; do [ "$prev" = "--plan" ] && pf="$a"; prev="$a"; done
    [ -n "$pf" ] || { echo "fake: bundle deploy without --plan" >&2; exit 1; }
    n=$(count deploy)
    echo "plan-used $n: $(tr -d '\\n' < "$pf")" >> "$FAKE_LOG"
    if [ "$n" = 1 ] && [ -n "$FAKE_DEPLOY_ERR_FIRST" ]; then echo "$FAKE_DEPLOY_ERR_FIRST"; exit 1; fi
    if [ -n "$FAKE_DEPLOY_ERR_ALWAYS" ]; then echo "$FAKE_DEPLOY_ERR_ALWAYS"; exit 1; fi ;;
  "postgres get-project") exit 1 ;;
  "bundle summary") echo '{"workspace":{"file_path":"/Workspace/Users/op@example.com/.bundle/ai-prism/dev/files"},"resources":{"jobs":{"ai_prism_auto_config":{"id":"42"}}}}' ;;
  "apps get") echo '{"name":"ai-prism","url":"${APP_URL}","service_principal_client_id":"'"\${FAKE_SP_ID:-${FAKE_SP}}"'"}' ;;
  "auth token") echo '{"access_token":"${FAKE_TOKEN}","token_type":"Bearer","expires_in":3599,"expiry":"2099-01-01T00:00:00Z"}' ;;
  "postgres get-endpoint") echo '{"status":{"current_state":"'"\${FAKE_EP_STATE:-ACTIVE}"'","hosts":{"host":"fake-pg-host.example"}}}' ;;
  "postgres generate-database-credential") echo '{"token":"${FAKE_PG_TOKEN}","expire_time":"2099-01-01T00:00:00Z"}' ;;
  "current-user me") echo '{"userName":"op@example.com"}' ;;
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

// The fake node: logs its arguments and the Postgres connection it was given
// (whether the password is the minted credential, never the value itself).
// FAKE_NODE_FAIL="<subcommand> [...]" makes `node scripts/migrate.mjs <subcommand>`
// exit FAKE_NODE_EXIT (default 1) without doing anything.
// With REAL_NODE set, every other call runs the REAL scripts/migrate.mjs against
// the REAL_PG* database (QA round 2 harness), and FAKE_NODE_FAIL_AFTER="<subcommand>"
// makes that subcommand exit 1 AFTER the real one has committed its work.
// FAKE_NODE_KILL_PARENT="<subcommand>" sends SIGTERM to the wrapper after running it.
const FAKE_NODE = `#!/bin/bash
if [ "$PGPASSWORD" = "${FAKE_PG_TOKEN}" ]; then pw=expected; elif [ -n "$PGPASSWORD" ]; then pw=set; else pw=unset; fi
echo "node $* PGHOST=\${PGHOST:-} PGUSER=\${PGUSER:-} PGDATABASE=\${PGDATABASE:-} PGSSLMODE=\${PGSSLMODE:-} PGPASSWORD=$pw" >> "$FAKE_LOG"
if [ -n "$FAKE_NODE_FAIL" ] && [[ " $FAKE_NODE_FAIL " == *" $2 "* ]]; then echo "fake node failure: $2" >&2; exit \${FAKE_NODE_EXIT:-1}; fi
rc=0
if [ -n "$REAL_NODE" ]; then
  PGHOST="$REAL_PGHOST" PGPORT="$REAL_PGPORT" PGUSER="$REAL_PGUSER" PGPASSWORD="$REAL_PGPASSWORD" \\
    PGDATABASE="$REAL_PGDATABASE" PGSSLMODE=disable AI_PRISM_OWNER_ROLE="$REAL_OWNER_ROLE" "$REAL_NODE" "$@" || rc=$?
fi
if [ -n "$FAKE_NODE_KILL_PARENT" ] && [ "$2" = "$FAKE_NODE_KILL_PARENT" ]; then kill -TERM "$PPID"; fi
if [ -n "$FAKE_NODE_FAIL_AFTER" ] && [ "$2" = "$FAKE_NODE_FAIL_AFTER" ]; then echo "fake failure after $2 committed" >&2; exit 1; fi
exit $rc
`

const SYSTEM_TOOLS = ['bash', 'sh', 'sed', 'awk', 'mktemp', 'rm', 'dirname', 'cat', 'env', 'python3', 'mkdir', 'grep', 'tr', 'head', 'tee', 'sleep', 'git']

function sandbox(script, { npm = true, node = true } = {}) {
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
  if (node) {
    writeFileSync(path.join(bin, 'node'), FAKE_NODE)
    chmodSync(path.join(bin, 'node'), 0o755)
  }
  copyFileSync(path.join(ROOT, script), path.join(dir, script))
  copyFileSync(path.join(ROOT, 'app.yaml'), path.join(dir, 'app.yaml'))
  symlinkSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'))
  // the folder guard (deploy.sh / deploy.ps1) needs a git checkout or the ZIP manifest: make the sandbox a git
  // checkout (its untracked files are allowed through AI_PRISM_ALLOW_UNTRACKED=1, see cleanEnv)
  spawnSync('git', ['init', '-q'], { cwd: dir })
  const log = path.join(dir, 'calls.log')
  writeFileSync(log, '')
  return { dir, bin, log }
}

function cleanEnv(extra) {
  const env = {}
  for (const k of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[k]) env[k] = process.env[k]
  return { AI_PRISM_ALLOW_UNTRACKED: '1', ...env, ...extra }
}

function runSh(args = [], { env = {}, npm = true, node = true } = {}) {
  const box = sandbox('deploy.sh', { npm, node })
  const r = spawnSync(path.join(box.bin, 'bash'), [path.join(box.dir, 'deploy.sh'), ...args], {
    cwd: box.dir,
    encoding: 'utf8',
    env: cleanEnv({ PATH: box.bin, FAKE_LOG: box.log, ...env }),
    timeout: 60_000,
  })
  return finish(box, r)
}

function runPs1(args = [], { env = {}, npm = true, node = true } = {}) {
  const box = sandbox('deploy.ps1', { npm, node })
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
  return { code: r.status, out: unwrap(`${r.stdout || ''}${r.stderr || ''}`), calls }
}

// pwsh renders an uncaught `throw` as a colored, width-wrapped error block ("  | text"
// lines); join it back so the assertions read the message, not its line breaks.
function unwrap(text) {
  if (!text.includes('\x1B[')) return text
  return text.replace(/\x1B\[[0-9;]*m/g, '').replace(/\s*\n\s*\|\s*/g, ' ')
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
  // W1-5: the auto-config (SP role + owner hand-off) runs BEFORE the new code is
  // published, so the first request of the new code can move the schema
  assert.ok(deploy < autoConfig && autoConfig < appsDeploy, 'deploy order changed')
  assert.ok(smoke > appsDeploy, 'the smoke must run after the code is published')
  // QA round 1: success requires the owner hand-off opened right before the code
  // is published and closed (grants) after the smoke; a skipped step cannot pass
  const prepare = at(res.calls, 'node scripts/migrate.mjs prepare')
  const close = at(res.calls, 'node scripts/migrate.mjs up')
  assert.ok(prepare > autoConfig && prepare < appsDeploy, `prepare must open the hand-off before apps deploy:\n${res.calls.join('\n')}`)
  assert.ok(close > smoke, `migrate up --role must close the hand-off after the smoke:\n${res.calls.join('\n')}`)
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

  // ---- plan gate: never delete or recreate; fail closed; apply exactly the checked plan ----
  const planOf = (actions, extra = { plan_version: 2 }) =>
    JSON.stringify({ ...extra, plan: Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, { action: a }])) })
  const OK_ACTIONS = { 'resources.apps.ai_prism': 'update', 'resources.jobs.ai_prism_auto_config': 'create', 'resources.dashboards.costs': 'skip' }
  const GRANT_ERR = 'Error: cannot create apps.ai_prism: Failed to grant permissions for SP 1234-abcd on database projects/ai-prism/branches/production/databases/databricks-postgres: deadline exceeded after 998000000ns'
  // after the gate aborts, no workspace write happened: no deploy, start, auto-config, publish, hand-off
  const assertNoWrites = (res) => {
    for (const w of ['databricks bundle deploy', 'databricks apps start', 'databricks bundle run', 'databricks apps deploy', 'databricks jobs', 'databricks secrets', 'node ', 'npm run smoke']) {
      assert.equal(at(res.calls, w), -1, `${w} ran after the gate aborted:\n${res.calls.join('\n')}`)
    }
    assert.doesNotMatch(res.out, /Done:/)
  }

  t('plan gate: a clean plan is checked BEFORE the deploy and applied exactly (--plan <file>), never with --auto-approve/--force', () => {
    const res = sh.run(['DEV'], { env: { FAKE_PLAN: planOf(OK_ACTIONS) } })
    assert.equal(res.code, 0, res.out)
    const plan = at(res.calls, 'databricks bundle plan')
    const deploy = at(res.calls, 'databricks bundle deploy')
    assert.ok(plan >= 0 && plan < deploy, `the plan must come before the deploy:\n${res.calls.join('\n')}`)
    assert.match(res.calls[plan], / -o json/)
    assert.match(res.calls[deploy], / --plan \S+/)
    assert.doesNotMatch(res.calls.join('\n'), /--auto-approve|--force/)
    assert.match(res.out, /plan: 1 create, 1 skip, 1 update/)
    assert.match(res.out, /ok: no resource will be deleted or recreated/)
    assert.equal(at(res.calls, 'plan-used 1: ') >= 0, true)
    assert.match(res.calls.find((c) => c.startsWith('plan-used 1: ')), /resources\.apps\.ai_prism/, 'the deploy applies the file the gate checked')
  })

  t('plan gate: a plan that deletes or recreates a resource aborts before ANY workspace write', () => {
    for (const bad of ['delete', 'recreate']) {
      const res = sh.run(['DEV'], { env: { FAKE_PLAN: planOf({ ...OK_ACTIONS, 'resources.postgres_projects.ai_prism_db': bad }) } })
      assert.notEqual(res.code, 0, `${bad}\n${res.out}`)
      assert.match(res.out, new RegExp(`resources\\.postgres_projects\\.ai_prism_db \\(${bad}\\)`))
      assert.match(res.out, /never deletes or recreates an existing resource/)
      assert.match(res.out, /nothing was changed in the workspace/)
      assertNoWrites(res)
    }
  })

  t('plan gate FAILS CLOSED: the plan command fails, is not JSON, or has an unexpected shape → abort, no writes', () => {
    const failed = sh.run(['DEV'], { env: { FAKE_PLAN_FAIL: '1' } })
    assert.notEqual(failed.code, 0, failed.out)
    assert.match(failed.out, /could not get the bundle plan/)
    assert.match(failed.out, /fake plan failure/)
    assertNoWrites(failed)
    for (const bad of ['this is not json', '[]', '{}', '{"plan": {}}', '{"plan": null}', '{"plan_version":2,"plan":{"resources.apps.a":{}}}',
      '{"plan_version":2,"plan":{"resources.apps.a":{"action":1}}}', '{"plan_version":2,"plan":{"apps.a":{"action":"update"}}}']) {
      const res = sh.run(['DEV'], { env: { FAKE_PLAN: bad } })
      assert.notEqual(res.code, 0, `${bad}\n${res.out}`)
      assert.match(res.out, /empty, unreadable or has an unexpected shape/, bad)
      assertNoWrites(res)
    }
  })

  t('plan gate: a plan without plan_version (Terraform state) aborts and prints the migrate command with the same --var', () => {
    const res = sh.run(['DEV', 'my_catalog'], { env: { FAKE_PLAN: planOf(OK_ACTIONS, {}) } })
    assert.notEqual(res.code, 0, res.out)
    assert.match(res.out, /still uses Terraform state/)
    assert.match(res.out, /databricks bundle deployment migrate .*-t.*dev.*-p.*DEV.*tools_catalog=my_catalog/)
    assert.match(res.out, /nothing was changed in the workspace/i)
    assertNoWrites(res)
  })

  t('plan gate: a CLI without `bundle plan` / `bundle deploy --plan` aborts at the start with a clear message', () => {
    const res = sh.run(['DEV'], { env: { FAKE_OLD_CLI: '1' } })
    assert.notEqual(res.code, 0, res.out)
    assert.match(res.out, /no `bundle plan` and `bundle deploy --plan`/)
    assert.match(res.out, /1\.17/)
    // nothing but the version probe reached the CLI
    assert.deepEqual(res.calls.filter((c) => c !== 'databricks --version'), [])
  })

  t('cold Lakebase: the deploy hits "Failed to grant permissions ... deadline exceeded" → wake, REDO the plan and the gate, retry ONCE with the new plan', () => {
    const res = sh.run(['DEV'], {
      env: { FAKE_DEPLOY_ERR_FIRST: GRANT_ERR, FAKE_PLAN: planOf({ ...OK_ACTIONS, 'resources.jobs.first': 'update' }), FAKE_PLAN_2: planOf({ ...OK_ACTIONS, 'resources.jobs.second': 'update' }) },
    })
    assert.equal(res.code, 0, res.out)
    assert.equal(res.calls.filter((c) => c.startsWith('databricks bundle deploy')).length, 2, 'exactly one retry')
    assert.equal(res.calls.filter((c) => c.startsWith('databricks bundle plan')).length, 2, 'the plan is redone')
    assert.match(res.out, /hit the deadline granting the database permission/)
    assert.match(res.calls.find((c) => c.startsWith('plan-used 1: ')), /resources\.jobs\.first/)
    const second = res.calls.find((c) => c.startsWith('plan-used 2: '))
    assert.match(second, /resources\.jobs\.second/, 'the retry applies the new checked plan')
    assert.doesNotMatch(second, /resources\.jobs\.first/)
    assert.doesNotMatch(res.calls.join('\n'), /--auto-approve|--force/)
  })

  t('cold Lakebase: the retry goes through the gate again (a new plan with delete/recreate aborts; no 2nd deploy)', () => {
    for (const bad of ['delete', 'recreate']) {
      const res = sh.run(['DEV'], {
        env: { FAKE_DEPLOY_ERR_FIRST: GRANT_ERR, FAKE_PLAN_2: planOf({ ...OK_ACTIONS, 'resources.postgres_projects.ai_prism_db': bad }) },
      })
      assert.notEqual(res.code, 0, `${bad}\n${res.out}`)
      assert.equal(res.calls.filter((c) => c.startsWith('databricks bundle deploy')).length, 1, 'the gate stopped the retry')
      assert.match(res.out, new RegExp(`ai_prism_db \\(${bad}\\)`))
      // the 1st deploy may have been applied in part: the message must not claim nothing changed
      assert.match(res.out, /may have been partly applied/)
      assert.doesNotMatch(res.out, /nothing was changed in the workspace/)
      assert.equal(at(res.calls, 'databricks apps deploy'), -1)
    }
    for (const bad of ['not json', planOf(OK_ACTIONS, {})]) {
      const res = sh.run(['DEV'], { env: { FAKE_DEPLOY_ERR_FIRST: GRANT_ERR, FAKE_PLAN_2: bad } })
      assert.notEqual(res.code, 0, res.out)
      assert.equal(res.calls.filter((c) => c.startsWith('databricks bundle deploy')).length, 1)
      assert.match(res.out, /may have been partly applied/)
    }
  })

  t('cold Lakebase: only ONE retry, and only for that exact error', () => {
    const twice = sh.run(['DEV'], { env: { FAKE_DEPLOY_ERR_ALWAYS: GRANT_ERR } })
    assert.notEqual(twice.code, 0, twice.out)
    assert.equal(twice.calls.filter((c) => c.startsWith('databricks bundle deploy')).length, 2)
    assert.match(twice.out, /failed again after the retry/)
    assert.equal(at(twice.calls, 'databricks apps deploy'), -1)
    for (const other of ['Error: permission denied', 'Error: deadline exceeded after 998000000ns', 'Failed to grant permissions for SP x on catalog main: PERMISSION_DENIED']) {
      const res = sh.run(['DEV'], { env: { FAKE_DEPLOY_ERR_FIRST: other } })
      assert.notEqual(res.code, 0, other)
      assert.equal(res.calls.filter((c) => c.startsWith('databricks bundle deploy')).length, 1, `${other}: no retry`)
      assert.equal(res.calls.filter((c) => c.startsWith('databricks bundle plan')).length, 1, `${other}: no new plan`)
    }
  })

  t('cold Lakebase: an ACTIVE endpoint is not touched; an idle one is woken (read-only) and a failure to wake only warns', () => {
    const active = sh.run(['DEV'])
    assert.equal(active.code, 0, active.out)
    assert.match(active.out, /Lakebase: endpoint ACTIVE/)
    const deployIdx = at(active.calls, 'databricks bundle deploy')
    assert.equal(active.calls.slice(0, deployIdx).some((c) => c.includes('generate-database-credential')), false, 'no credential before the deploy when ACTIVE')

    const idle = sh.run(['DEV'], { env: { FAKE_EP_STATE: 'IDLE', AI_PRISM_LAKEBASE_WAKE_TIMEOUT: '1', AI_PRISM_PG_PORT: '1' } })
    assert.equal(idle.code, 0, idle.out)
    assert.match(idle.out, /Lakebase: endpoint IDLE; waking it/)
    assert.match(idle.out, /WARNING:? .*(could not wake Lakebase|still not ACTIVE)/)
    const before = idle.calls.slice(0, at(idle.calls, 'databricks bundle deploy'))
    assert.ok(before.some((c) => c.startsWith('databricks postgres generate-database-credential')), 'the wake mints your OAuth database credential')
    assert.ok(!idle.out.includes(FAKE_PG_TOKEN), 'the credential is never printed')
    // read-only: before the deploy only reads, the plan and the wake's own calls
    for (const c of before) assert.match(c, /^(npm run bundle|databricks (--version|bundle plan|postgres (get-project|list-projects|get-endpoint|generate-database-credential)|current-user me))/)
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

  // W1-5: after the smoke, the deploying identity (the table owner) runs
  // `migrate.mjs up --role <app SP>`, which applies the least-privilege grants
  // and closes the owner hand-off. Credentials are minted with the CLI and only
  // reach node's environment.
  // W1-5 / QA round 1: the wrapper owns the whole hand-off lifecycle. It opens
  // the SP's membership (migrate.mjs prepare) right before publishing the code
  // and, on every path after that, closes it (migrate.mjs up --role: grants, or
  // the revoke alone when 0002 is still deferred). Success only when closed.
  t('opens the hand-off before apps deploy and closes it after the smoke, without printing the credential', () => {
    const res = sh.run(['DEV'])
    assert.equal(res.code, 0, res.out)
    const prepare = at(res.calls, 'node scripts/migrate.mjs prepare')
    const close = at(res.calls, 'node scripts/migrate.mjs up')
    for (const i of [prepare, close]) {
      const call = res.calls[i]
      assert.match(call, new RegExp(`--role ${FAKE_SP}`))
      assert.match(call, /PGHOST=fake-pg-host\.example /)
      assert.match(call, /PGUSER=op@example\.com /)
      assert.match(call, /PGDATABASE=databricks_postgres /)
      assert.match(call, /PGSSLMODE=require /)
      assert.match(call, /PGPASSWORD=expected/)
    }
    assert.ok(
      res.calls.some((c) => c.startsWith('databricks postgres generate-database-credential projects/ai-prism/branches/production/endpoints/primary')),
      res.calls.join('\n')
    )
    assert.ok(!res.out.includes(FAKE_PG_TOKEN), 'the database credential must never be printed')
    assert.ok(!res.out.includes(FAKE_TOKEN))
    assert.match(res.out, /Done:/)
  })

  t('migrate up --role exit 3 (0002 deferred, hand-off closed) is a failure, not a warning', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NODE_FAIL: 'up', FAKE_NODE_EXIT: '3' } })
    assert.notEqual(res.code, 0, res.out)
    assert.match(res.out, /deferred/)
    assert.match(res.out, /deploy\.(sh|ps1)/)
    assert.doesNotMatch(res.out, /Done:/)
  })

  t('migrate up --role exit 4 (hand-off could not be closed) is a failure naming the recovery', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NODE_FAIL: 'up', FAKE_NODE_EXIT: '4' } })
    assert.notEqual(res.code, 0, res.out)
    assert.match(res.out, /hand-off/)
    assert.match(res.out, /migrate\.mjs up --role/)
    assert.doesNotMatch(res.out, /Done:/)
  })

  t('a failed migrate up --role makes the run exit non-zero and names the manual command', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NODE_FAIL: 'up' } })
    assert.notEqual(res.code, 0, res.out)
    assert.match(res.out, /migrate\.mjs up --role/)
    assert.ok(!res.out.includes(FAKE_PG_TOKEN))
  })

  // QA round 2: prepare may have committed the membership before it failed (or
  // before its success reached the wrapper), so the cleanup is armed BEFORE it runs.
  // Before the code is published the cleanup only revokes (`close`): `up` could move
  // the schema under the old release that is still serving.
  t('a failed prepare stops before publishing and still attempts the revoke', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NODE_FAIL: 'prepare' } })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'databricks apps deploy'), -1, 'apps deploy ran after a failed prepare')
    assert.ok(at(res.calls, 'node scripts/migrate.mjs close') > at(res.calls, 'node scripts/migrate.mjs prepare'), res.calls.join('\n'))
    assert.equal(at(res.calls, 'node scripts/migrate.mjs up'), -1, 'no migration before the new code is published')
    assert.doesNotMatch(res.out, /Done:/)
  })

  t('a failed prepare whose revoke also fails is a failure naming the recovery', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NODE_FAIL: 'prepare close', FAKE_NODE_EXIT: '4' } })
    assert.notEqual(res.code, 0, res.out)
    assert.match(res.out, /still OPEN|may still be open/)
    assert.match(res.out, /migrate\.mjs close --role/)
  })

  t('no database credential: stops before opening the hand-off and before publishing', () => {
    const res = sh.run(['DEV'], { env: { FAKE_DB_FAIL: 'generate-database-credential' } })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'node '), -1)
    assert.equal(at(res.calls, 'databricks apps deploy'), -1)
  })

  t('a failed apps deploy after prepare still closes the hand-off, then fails', () => {
    const res = sh.run(['DEV'], { env: { FAKE_DB_FAIL: '--source-code-path' } })
    assert.notEqual(res.code, 0, res.out)
    assert.ok(at(res.calls, 'node scripts/migrate.mjs prepare') >= 0)
    assert.ok(at(res.calls, 'node scripts/migrate.mjs close') > at(res.calls, 'databricks apps deploy'), res.calls.join('\n'))
    assert.equal(at(res.calls, 'node scripts/migrate.mjs up'), -1, 'the old release is still serving: revoke only')
    assert.doesNotMatch(res.out, /Done:/)
  })

  if (sh.name === 'deploy.sh') {
    // an interrupt (SIGTERM) right after prepare committed: the EXIT path still revokes
    t('an interrupt right after prepare still attempts the revoke', () => {
      const res = sh.run(['DEV'], { env: { FAKE_NODE_KILL_PARENT: 'prepare' } })
      assert.notEqual(res.code, 0, res.out)
      assert.ok(at(res.calls, 'node scripts/migrate.mjs close') > at(res.calls, 'node scripts/migrate.mjs prepare'), res.calls.join('\n'))
      assert.equal(at(res.calls, 'databricks apps deploy'), -1)
    })
  }

  t('a failed smoke still closes the hand-off, then fails', () => {
    const res = sh.run(['DEV'], { env: { FAKE_NPM_FAIL: 'smoke' } })
    assert.notEqual(res.code, 0, res.out)
    assert.ok(at(res.calls, 'node scripts/migrate.mjs up') > at(res.calls, 'npm run smoke'), res.calls.join('\n'))
    assert.match(res.out, /smoke/i)
    assert.doesNotMatch(res.out, /Done:/)
  })

  t('without node the hand-off is never opened and the run fails after the deploy, naming the recovery', () => {
    const res = sh.run(['DEV'], { node: false })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'node '), -1)
    assert.ok(at(res.calls, 'databricks apps deploy') >= 0, 'the app is still deployed (it runs on public)')
    assert.match(res.out, /node/i)
    assert.match(res.out, /public/)
    assert.match(res.out, /deploy\.(sh|ps1)/)
    assert.doesNotMatch(res.out, /Done:/)
  })

  t('no OAuth token for the smoke is a failure, not a silent pass', () => {
    const res = sh.run(['DEV'], { env: { FAKE_DB_FAIL: 'token' } })
    assert.notEqual(res.code, 0, res.out)
    assert.equal(at(res.calls, 'npm run smoke'), -1)
    assert.ok(at(res.calls, 'node scripts/migrate.mjs up') >= 0, 'the hand-off is closed even when the smoke cannot run')
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

// ---- QA round 2: the real prepare commits, then node reports failure ------------
// The fake node runs the REAL scripts/migrate.mjs against a scratch database, so
// the membership really is committed before the failure the wrapper sees. Same
// local Postgres as server/schemaAiPrism.test.js (skipped without one).
const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55432),
  user: process.env.PGUSER || 'ai_prism',
  password: process.env.PGPASSWORD || 'ai_prism',
  database: process.env.PGDATABASE || 'ai_prism',
}
async function pgQuery(sql, database = PG.database) {
  const c = new pg.Client({ ...PG, database, ssl: false, connectionTimeoutMillis: 10_000 })
  await c.connect()
  try {
    return await c.query(sql)
  } finally {
    await c.end().catch(() => {})
  }
}
const PG_SKIP = await (async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(PG.host) && process.env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${PG.host} is not local`
  // one retry: this file starts many wrapper processes, a busy machine can be slow to accept
  for (let attempt = 1; ; attempt++) {
    try {
      await pgQuery('SELECT 1')
      return false
    } catch (e) {
      if (attempt >= 2) return `no Postgres at ${PG.host}:${PG.port} (${e.code || e.message})`
    }
  }
})()
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
let dbSeq = 0

// deployer (database owner, CREATEROLE), app SP and owner role names are stamped
async function handoffFixture() {
  const n = `${stamp}_${++dbSeq}`
  const f = { dep: `w15w_dep_${n}`, sp: `w15w_sp_${n}`, owner: `w15w_owner_${n}`, db: `w15w_db_${n}` }
  await pgQuery(`CREATE ROLE ${f.dep} LOGIN CREATEROLE PASSWORD '${PG.password}'`)
  await pgQuery(`CREATE ROLE ${f.sp} LOGIN`)
  await pgQuery(`CREATE DATABASE ${f.db} OWNER ${f.dep}`)
  f.env = {
    REAL_NODE: process.execPath,
    REAL_PGHOST: PG.host,
    REAL_PGPORT: String(PG.port),
    REAL_PGUSER: f.dep,
    REAL_PGPASSWORD: PG.password,
    REAL_PGDATABASE: f.db,
    REAL_OWNER_ROLE: f.owner,
    FAKE_SP_ID: f.sp,
  }
  f.member = async () => (await pgQuery(`SELECT pg_has_role('${f.sp}', oid, 'MEMBER') AS m FROM pg_roles WHERE rolname = '${f.owner}'`)).rows[0]?.m ?? false
  f.drop = async () => {
    await pgQuery(`DROP DATABASE IF EXISTS ${f.db} WITH (FORCE)`).catch(() => {})
    for (const r of [f.owner, f.sp, f.dep]) await pgQuery(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
  }
  return f
}

for (const sh of SHELLS) {
  const skip = sh.skip || PG_SKIP
  test(`${sh.name}: prepare commits then reports failure → the wrapper revokes; the SP is not left a member`, { skip }, async () => {
    const f = await handoffFixture()
    try {
      const res = sh.run(['DEV'], { env: { ...f.env, FAKE_NODE_FAIL_AFTER: 'prepare' } })
      assert.notEqual(res.code, 0, res.out)
      assert.ok(at(res.calls, 'node scripts/migrate.mjs close') >= 0, `no revoke attempted:\n${res.calls.join('\n')}`)
      assert.equal(at(res.calls, 'databricks apps deploy'), -1)
      assert.equal(await f.member(), false, 'the SP is still a member of the owner role')
    } finally {
      await f.drop()
    }
  })

  test(`${sh.name}: prepare commits, then the revoke cannot run → non-zero, residual state reported`, { skip }, async () => {
    const f = await handoffFixture()
    try {
      const res = sh.run(['DEV'], { env: { ...f.env, FAKE_NODE_FAIL_AFTER: 'prepare', FAKE_NODE_FAIL: 'close', FAKE_NODE_EXIT: '1' } })
      assert.notEqual(res.code, 0, res.out)
      assert.match(res.out, /may still be open|still OPEN/)
      assert.match(res.out, /migrate\.mjs close --role/)
      assert.equal(await f.member(), true, 'precondition of this case: the membership was really committed')
    } finally {
      await f.drop()
    }
  })
}

test('CI has pwsh, so the deploy.ps1 tests never skip there', () => {
  if (!process.env.CI) return
  assert.ok(PWSH && existsSync(PWSH), 'CI must run the deploy.ps1 tests: install PowerShell 7 or set PWSH')
})
