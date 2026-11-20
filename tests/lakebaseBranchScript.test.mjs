// scripts/ci/lakebase-branch.sh: unit tests of its guards, with fake `databricks`
// and `psql` binaries on PATH (nothing here touches a workspace).
//   AC1 no secrets -> visible notice, exit 0     AC3 delete refuses `production`
//   AC4 role guard fails on rolbypassrls / rolsuper
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'lakebase-branch.sh')
const bash = spawnSync('bash', ['--version']).status === 0

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lbb-test-'))
  const log = path.join(dir, 'databricks.log')
  writeFileSync(path.join(dir, 'databricks'), `#!/bin/sh\necho "$@" >> "${log}"\nexit "\${FAKE_DATABRICKS_EXIT:-0}"\n`)
  writeFileSync(path.join(dir, 'psql'), `#!/bin/sh\nprintf '%s\\n' "$FAKE_PSQL_OUT"\n`)
  chmodSync(path.join(dir, 'databricks'), 0o755)
  chmodSync(path.join(dir, 'psql'), 0o755)
  return { dir, log }
}

function run(args, env = {}, sb = sandbox()) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${sb.dir}:/usr/bin:/bin`, HOME: sb.dir, ...env },
  })
  const calls = existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : ''
  rmSync(sb.dir, { recursive: true, force: true })
  return { ...r, calls }
}

test('AC1: without secrets the run skips with a visible notice and exits 0', { skip: !bash }, () => {
  for (const v of [{ SECRETS_PRESENT: '0' }, {}]) {
    const r = run(['run'], v)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /::notice::.*skipp?ed/i)
    assert.equal(r.calls, '', 'no workspace call may happen')
  }
})

test('AC3: delete-branch refuses any path containing production', { skip: !bash }, () => {
  for (const p of [
    'projects/ai-prism/branches/production',
    'projects/ai-prism/branches/production/',
    'projects/production/branches/w3-1-abc',
    'projects/ai-prism/branches/w3-1-production',
    'PROJECTS/ai-prism/branches/Production',
  ]) {
    const r = run(['delete-branch', p])
    assert.notEqual(r.status, 0, p)
    assert.match(r.stderr, /refus/i, p)
    assert.equal(r.calls, '', `${p} must not reach the CLI`)
  }
})

test('AC3: delete-branch refuses paths that are not this job\'s own branch', { skip: !bash }, () => {
  for (const p of ['', 'projects/ai-prism', 'projects/ai-prism/branches/w3-5-xyz', 'projects/ai-prism/branches/main', 'projects/ai-prism/branches/w3-1-a b', 'projects/ai-prism/branches/w3-1-a;rm']) {
    const r = run(['delete-branch', p])
    assert.notEqual(r.status, 0, JSON.stringify(p))
    assert.equal(r.calls, '')
  }
})

test('AC3: delete-branch deletes the literal path of an own branch, with the profile', { skip: !bash }, () => {
  const r = run(['delete-branch', 'projects/ai-prism/branches/w3-1-ci-123-abcd'], { LB_PROFILE: 'p1' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.calls, /^postgres delete-branch projects\/ai-prism\/branches\/w3-1-ci-123-abcd --profile p1$/m)
})

test('AC4: check-role passes for a plain role', { skip: !bash }, () => {
  const r = run(['check-role'], { FAKE_PSQL_OUT: 'ai_prism_app|f|f' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /current_user=ai_prism_app rolsuper=f rolbypassrls=f/)
})

test('AC4: check-role fails when rolbypassrls or rolsuper is true, or the output is unusable', { skip: !bash }, () => {
  for (const out of ['x|f|t', 'x|t|f', 'x|t|t', '', 'garbage', 'x|f']) {
    const r = run(['check-role'], { FAKE_PSQL_OUT: out })
    assert.notEqual(r.status, 0, out)
    assert.match(r.stdout + r.stderr, /::error::/)
  }
})
