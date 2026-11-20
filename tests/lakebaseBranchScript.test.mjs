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

// ---- the TLS / identity bridge the suites connect through ------------------------
import { buildStartup, parseStartup, passwordMessage, rewriteStartup } from '../scripts/ci/pg-tls-proxy.mjs'

test('proxy: a login as role X becomes the owner with role=X and self-grant set', () => {
  const msg = buildStartup([['user', 'ai_prism_app'], ['database', 'ai_prism_ci'], ['client_encoding', 'utf8']])
  const out = Object.fromEntries(parseStartup(rewriteStartup(msg, 'owner@example.com')))
  assert.equal(out.user, 'owner@example.com')
  assert.equal(out.database, 'ai_prism_ci')
  assert.match(out.options, /-c role=ai_prism_app/)
  assert.match(out.options, /-c createrole_self_grant=set,inherit/)
})

test('proxy: the owner itself is not mapped to a role, and existing options are kept', () => {
  const msg = buildStartup([['user', 'owner@example.com'], ['options', '-c search_path=x']])
  const out = Object.fromEntries(parseStartup(rewriteStartup(msg, 'owner@example.com')))
  assert.doesNotMatch(out.options, /role=/)
  assert.match(out.options, /^-c search_path=x /)
})

test('proxy: passwordMessage frames the token as a PasswordMessage', () => {
  const m = passwordMessage('tok')
  assert.equal(String.fromCharCode(m[0]), 'p')
  assert.equal(m.readInt32BE(1), 4 + 4)
  assert.equal(m.subarray(5).toString(), 'tok\0')
})

test('AC3: run attempts branch cleanup when create-branch returns an error', { skip: !bash }, () => {
  const sb = sandbox()
  const r = spawnSync('bash', [SCRIPT, 'run'], {
    encoding: 'utf8',
    env: {
      PATH: `${sb.dir}:${process.env.PATH}`,
      HOME: sb.dir,
      SECRETS_PRESENT: '1',
      LB_PROFILE: 'qa-test',
      LB_SUFFIX: 'create-failure',
      FAKE_DATABRICKS_EXIT: '1',
    },
  })
  const calls = existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : ''
  rmSync(sb.dir, { recursive: true, force: true })
  assert.match(calls, /^postgres delete-branch projects\/ai-prism\/branches\/w3-1-create-failure/m, calls)
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /does not exist|already gone|is gone/)
})

// ---- workflow secret scoping and action pinning (QA round 1) ----------------------
// A small indentation walker instead of a YAML dependency (none is a direct dependency).
test('workflow: no secret at workflow/job level or on a `uses:` step; every action pinned to a SHA', () => {
  const lines = readFileSync(path.join(REPO, '.github', 'workflows', 'lakebase-branch.yml'), 'utf8').split('\n')
  const indent = (l) => l.length - l.trimStart().length
  const code = lines.map((l) => l.replace(/\s+#.*$/, ''))
  let steps = 0
  let jobEnvIndent = null // indentation of the `env:` key while inside a workflow/job-level env block
  let step = null // { start, indent }
  const blocks = []
  code.forEach((l, i) => {
    if (!l.trim() || l.trimStart().startsWith('#')) return
    const ind = indent(l)
    if (/^\s*- /.test(l) && ind >= 6 && /^\s{6}- /.test(l)) {
      step = { lines: [l] }
      blocks.push(step)
      steps++
    } else if (step && ind > 6) step.lines.push(l)
    else if (ind <= 6 && !/^\s{6}- /.test(l)) step = null
    // workflow (indent 0) and job (indent 4) env blocks
    if (/^(env:|    env:)\s*$/.test(l)) jobEnvIndent = ind
    else if (jobEnvIndent !== null && ind <= jobEnvIndent) jobEnvIndent = null
    else if (jobEnvIndent !== null) assert.doesNotMatch(l, /secrets\./, `secret in workflow/job-level env (line ${i + 1}): ${l.trim()}`)
  })
  assert.ok(steps >= 5, `expected to find the steps, got ${steps}`)
  const uses = []
  for (const b of blocks) {
    const text = b.lines.join('\n')
    const u = b.lines.map((l) => l.match(/\buses:\s*(\S+)/)).find(Boolean)
    if (u) {
      uses.push(u[1])
      assert.doesNotMatch(text, /secrets\./, `secret on a uses: step (${u[1]})`)
      assert.doesNotMatch(text, /DATABRICKS_(HOST|CLIENT)/, `credentials on a uses: step (${u[1]})`)
      assert.match(u[1], /@[0-9a-f]{40}$/, `${u[1]} is not pinned to a full commit SHA`)
    }
  }
  assert.ok(uses.length >= 4, `expected the uses: steps, found ${uses.length}`)
})
