// Tests for tests/ci/dist-drift-mode.sh, the CI decision "check that the
// committed client/dist and server-dist match the build, or skip it".
// Feature PRs must not commit dist (hashed file names make any two client PRs
// conflict), so the drift check runs only on release PRs: head branch
// release/* or the label "release". Everything else builds and skips.
//   node --test tests/distDriftMode.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./ci/dist-drift-mode.sh', import.meta.url))

function mode(env) {
  // a clean env: only what the workflow passes, plus PATH for the shell tools
  const r = spawnSync('bash', [SCRIPT], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('a PR from a release/* branch checks the drift', () => {
  assert.equal(mode({ EVENT_NAME: 'pull_request', HEAD_REF: 'release/1.5.0', PR_LABELS: '[]' }), 'check')
})

test('a PR labelled "release" checks the drift, whatever its branch', () => {
  assert.equal(mode({ EVENT_NAME: 'pull_request', HEAD_REF: 'feat/x', PR_LABELS: '["skip-changelog","release"]' }), 'check')
})

test('a feature PR skips the drift check', () => {
  assert.equal(mode({ EVENT_NAME: 'pull_request', HEAD_REF: 'megabrain/parity-ux/w0-5', PR_LABELS: '[]' }), 'skip')
})

test('look-alike branches and labels do not count as a release', () => {
  assert.equal(mode({ EVENT_NAME: 'pull_request', HEAD_REF: 'releases/1.5.0', PR_LABELS: '["release-notes"]' }), 'skip')
  assert.equal(mode({ EVENT_NAME: 'pull_request', HEAD_REF: 'fix/release/1.5.0', PR_LABELS: '["pre-release"]' }), 'skip')
})

test('a push to main skips it (feature merges leave dist stale by design)', () => {
  assert.equal(mode({ EVENT_NAME: 'push', HEAD_REF: '', PR_LABELS: 'null' }), 'skip')
})

test('missing inputs default to skip', () => {
  assert.equal(mode({}), 'skip')
})
