// scripts/telemetry/enable.sh turns on Unity Catalog telemetry export for ONE named
// app. Guard rails under test (AC5): it never falls back to a default profile, it
// needs an explicit app name, it never targets the live `ai-prism` app, it validates
// identifiers, and it prints no secret. A stub `databricks` on PATH records the calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'enable.sh')

function run(args, { env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'enable-sh-'))
  const log = path.join(dir, 'calls.log')
  const stub = path.join(dir, 'databricks')
  const appJson = JSON.stringify({
    name: 'aiprism-w3-5-abc',
    description: 'keep me',
    resources: [{ name: 'sql-warehouse', sql_warehouse: { id: 'wh1', permission: 'CAN_USE' } }],
    effective_user_api_scopes: ['iam.access-control:read', 'iam.current-user:read', 'serving.serving-endpoints'],
  })
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1 $2" = "apps get" ]; then echo '${appJson}'; else echo '{"ok":true}'; fi\n`,
  )
  chmodSync(stub, 0o755)
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, DATABRICKS_TOKEN: 'dapi-SECRET-VALUE', ...env },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  rmSync(dir, { recursive: true, force: true })
  return { ...r, calls, out: `${r.stdout}${r.stderr}` }
}

const OK = ['--profile', 'p1', '--app', 'aiprism-w3-5-abc', '--catalog', 'main', '--schema', 'aiprism_tel']

test('refuses without --profile (no default profile fallback)', () => {
  const r = run(['--app', 'aiprism-w3-5-abc', '--catalog', 'main', '--schema', 's'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /--profile/)
  assert.deepEqual(r.calls, [])
})

test('refuses without an explicit app name', () => {
  const r = run(['--profile', 'p1', '--catalog', 'main', '--schema', 's'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /--app/)
  assert.deepEqual(r.calls, [])
})

test('never targets the live ai-prism app, in any spelling', () => {
  for (const name of ['ai-prism', 'AI-Prism', ' ai-prism ']) {
    const r = run(['--profile', 'p1', '--app', name, '--catalog', 'main', '--schema', 's'])
    assert.notEqual(r.status, 0, name)
    assert.match(r.out, /ai-prism/, name)
    assert.deepEqual(r.calls, [], name)
  }
})

test('rejects catalog/schema/app values that are not plain identifiers', () => {
  for (const bad of [['--catalog', 'a;drop'], ['--schema', 'x y'], ['--schema', 'a.b'], ['--app', 'x"y']]) {
    const args = [...OK]
    args[args.indexOf(bad[0]) + 1] = bad[1]
    const r = run(args)
    assert.equal(r.status, 2, bad.join('='))
    assert.match(r.out, /enable\.sh:/, bad.join('='))
    assert.deepEqual(r.calls, [], bad.join('='))
  }
})

test('--dry-run prints the update payload and calls nothing', () => {
  const r = run([...OK, '--dry-run'])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(r.calls, [])
  assert.match(r.stdout, /"traces_table":"main\.aiprism_tel\.otel_spans"/)
  assert.match(r.stdout, /"logs_table":"main\.aiprism_tel\.otel_logs"/)
  assert.match(r.stdout, /"metrics_table":"main\.aiprism_tel\.otel_metrics"/)
})

test('applies the destination with apps update on the named app and profile', () => {
  const r = run(OK)
  assert.equal(r.status, 0, r.out)
  const update = r.calls.filter((c) => c.startsWith('apps update'))
  assert.equal(update.length, 1)
  assert.match(update[0], /^apps update aiprism-w3-5-abc /)
  assert.match(update[0], /(-p|--profile) p1/)
  assert.match(update[0], /telemetry_export_destinations/)
})

test('accepts Databricks profile names that contain dots (host-style profiles are real)', () => {
  const args = [...OK]
  args[args.indexOf('--profile') + 1] = 'omni.workspace.cloud.databricks.com'
  const r = run(args)
  assert.equal(r.status, 0, r.out)
  const update = r.calls.find((c) => c.startsWith('apps update'))
  assert.match(update, /-p omni\.workspace\.cloud\.databricks\.com/)
})

test('accepts profile names with underscores and dashes', () => {
  for (const name of ['my_profile', 'fe-vm-x_1.v2']) {
    const args = [...OK]
    args[args.indexOf('--profile') + 1] = name
    const r = run(args)
    assert.equal(r.status, 0, `${name}: ${r.out}`)
  }
})

test('still rejects an empty profile and shell metacharacters in it', () => {
  for (const bad of ['', 'p1;rm -rf x', 'p1 p2', '$(id)', 'p`id`', 'p|q', '-p', '--x']) {
    const args = [...OK]
    args[args.indexOf('--profile') + 1] = bad
    const r = run(args)
    assert.equal(r.status, 2, `${JSON.stringify(bad)}: ${r.out}`)
    assert.match(r.out, /profile/, JSON.stringify(bad))
    assert.deepEqual(r.calls, [], JSON.stringify(bad))
  }
})

test('update is read-modify-write: apps update replaces the whole spec, so resources and scopes are carried over', () => {
  const r = run(OK)
  assert.equal(r.status, 0, r.out)
  assert.match(r.calls[0], /^apps get aiprism-w3-5-abc /)
  const update = r.calls.find((c) => c.startsWith('apps update'))
  assert.match(update, /sql_warehouse/)
  assert.match(update, /serving\.serving-endpoints/)
  assert.match(update, /keep me/)
  assert.doesNotMatch(update, /iam\./) // platform-added defaults are not requested scopes
})

test('prints no secret from the environment', () => {
  const r = run(OK)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /telemetry export enabled/)
  assert.doesNotMatch(r.out, /dapi-SECRET-VALUE/)
  const d = run([...OK, '--dry-run'])
  assert.doesNotMatch(d.out, /dapi-SECRET-VALUE/)
})

test('--help exits 0 and documents the flags', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  for (const f of ['--profile', '--app', '--catalog', '--schema', '--dry-run']) assert.match(r.out, new RegExp(f))
})
