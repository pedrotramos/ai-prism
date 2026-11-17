// Tests for tests/run.mjs, the unit-test entry point CI and `npm test` use.
// It exists because `node --test` with an EMPTY file list silently falls back
// to its default glob, which also matches scripts/load-test.mjs (`*-test.mjs`).
//   node --test tests/runner.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverTestFiles, summarizeTap, evaluateRun, TEST_DIRS } from './run.mjs'

test('the suite covers server, shared, scripts, tests and client/src', () => {
  assert.deepEqual(TEST_DIRS, ['server', 'shared', 'scripts', 'tests', 'client/src'])
})

test('discoverTestFiles finds *.test.js/*.test.mjs only, sorted, skipping node_modules and *-test.mjs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-'))
  const files = [
    'server/a.test.js',
    'server/z.test.mjs',
    'scripts/load-test.mjs',
    'client/src/lib/b.test.js',
    'client/src/node_modules/pkg/c.test.js',
    'client/e2e/flows.spec.mjs',
    'shared/helper.js',
  ]
  for (const f of files) {
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true })
    writeFileSync(path.join(root, f), '')
  }
  assert.deepEqual(discoverTestFiles(root), ['client/src/lib/b.test.js', 'server/a.test.js', 'server/z.test.mjs'])
})

const TAP = `TAP version 13
# Subtest: one
ok 1 - one
  ---
  duration_ms: 1
  type: 'test'
  location: '/repo/server/isolation.test.js:10:1'
  ...
# Subtest: two
ok 2 - two # SKIP no database
  ---
  duration_ms: 1
  type: 'test'
  location: '/repo/server/isolation.test.js:20:1'
  ...
# Subtest: three
not ok 3 - three
  ---
  duration_ms: 1
  type: 'test'
  location: '/repo/tests/routes.test.mjs:5:1'
  ...
1..3
# tests 3
# pass 1
# fail 1
# skipped 1
# todo 0
`

test('summarizeTap reads the totals and counts pass/skip/fail per file from the location', () => {
  const s = summarizeTap(TAP, '/repo')
  assert.deepEqual(s.totals, { tests: 3, pass: 1, fail: 1, skipped: 1, todo: 0, cancelled: 0 })
  assert.deepEqual(s.byFile['server/isolation.test.js'], { pass: 1, fail: 0, skipped: 1 })
  assert.deepEqual(s.byFile['tests/routes.test.mjs'], { pass: 0, fail: 1, skipped: 0 })
})

test('evaluateRun: skips fail the run only with failOnSkip; expectations need exact passes', () => {
  const s = summarizeTap(TAP.replace('not ok 3', 'ok 3').replace('# pass 1', '# pass 2').replace('# fail 1', '# fail 0'), '/repo')
  assert.deepEqual(evaluateRun(s, { exitCode: 0 }).errors, [])
  assert.match(evaluateRun(s, { exitCode: 0, failOnSkip: true }).errors.join(' '), /1 skipped/)
  const exp = evaluateRun(s, { exitCode: 0, expect: { 'server/isolation.test.js': 2 } })
  assert.match(exp.errors.join(' '), /server\/isolation\.test\.js: expected 2 passing, got 1/)
  assert.deepEqual(evaluateRun(s, { exitCode: 0, expect: { 'tests/routes.test.mjs': 1 } }).errors, [])
  assert.match(evaluateRun(s, { exitCode: 1 }).errors.join(' '), /node --test exited 1/)
})

test('evaluateRun refuses an empty run', () => {
  const s = summarizeTap('TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n', '/repo')
  assert.match(evaluateRun(s, { exitCode: 0 }).errors.join(' '), /no tests ran/)
})
