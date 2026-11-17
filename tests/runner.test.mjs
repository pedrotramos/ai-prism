// Tests for tests/run.mjs, the unit-test entry point CI and `npm test` use.
// It exists because `node --test` with an EMPTY file list silently falls back
// to its default glob, which also matches scripts/load-test.mjs (`*-test.mjs`).
//   node --test tests/runner.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverTestFiles, summarizeEvents, evaluateRun, TEST_DIRS } from './run.mjs'

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

// One JSON line per finished test, as tests/summary-reporter.mjs writes them.
const ev = (event, file, extra = {}) => JSON.stringify({ event, file, name: 'x', nesting: 0, type: 'test', skip: false, todo: false, ...extra })
const EVENTS = [
  ev('pass', '/repo/server/isolation.test.js'),
  ev('pass', '/repo/server/isolation.test.js', { skip: true }),
  ev('fail', '/repo/tests/routes.test.mjs'),
  ev('pass', '/repo/tests/routes.test.mjs', { type: 'suite' }), // a describe() is not a test
  ev('pass', '/repo/tests/routes.test.mjs', { todo: true, nesting: 1 }),
].join('\n')

test('summarizeEvents counts tests (not suites) overall and per file, including skips and todos', () => {
  const s = summarizeEvents(EVENTS, '/repo')
  assert.deepEqual(s.totals, { tests: 4, pass: 1, fail: 1, skipped: 1, todo: 1 })
  assert.deepEqual(s.byFile['server/isolation.test.js'], { pass: 1, fail: 0, skipped: 1, todo: 0 })
  assert.deepEqual(s.byFile['tests/routes.test.mjs'], { pass: 0, fail: 1, skipped: 0, todo: 1 })
})

test('evaluateRun: skips fail the run only with failOnSkip; expectations need exact passes', () => {
  const s = summarizeEvents(EVENTS.replace('"event":"fail"', '"event":"pass"').split('\n').filter((l) => !l.includes('"todo":true')).join('\n'), '/repo')
  assert.deepEqual(evaluateRun(s, { exitCode: 0 }).errors, [])
  assert.match(evaluateRun(s, { exitCode: 0, failOnSkip: true }).errors.join(' '), /1 skipped/)
  const exp = evaluateRun(s, { exitCode: 0, expect: { 'server/isolation.test.js': 2 } })
  assert.match(exp.errors.join(' '), /server\/isolation\.test\.js: expected 2 passing, got 1/)
  assert.deepEqual(evaluateRun(s, { exitCode: 0, expect: { 'tests/routes.test.mjs': 1 } }).errors, [])
  assert.match(evaluateRun(s, { exitCode: 1 }).errors.join(' '), /node --test exited 1/)
})

test('evaluateRun refuses an empty run', () => {
  const s = summarizeEvents('', '/repo')
  assert.match(evaluateRun(s, { exitCode: 0 }).errors.join(' '), /no tests ran/)
})
