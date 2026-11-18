#!/usr/bin/env node
// Unit-test entry point for `npm test` and CI. Discovers every *.test.js /
// *.test.mjs under server, shared, scripts, tests and client/src, runs them in
// ONE `node --test` call with an explicit file list, and checks the result.
//
// Why not plain `node --test`: with no file arguments (or an empty list from a
// shell that lacks `mapfile`) Node falls back to its default glob, which also
// matches scripts/load-test.mjs (`*-test.mjs`) and runs it as a "test".
//
//   node tests/run.mjs                         # local: skips are reported, not fatal
//   node tests/run.mjs --fail-on-skip \
//     --expect server/isolation.test.js=19     # CI: no skips, isolation 19/19 (+ rls 16)
//   node tests/run.mjs --list                  # print the discovered files
//
// Files run one at a time (--test-concurrency=1): the isolation and route
// suites both create the schema on a fresh database, and two concurrent
// CREATE TABLE IF NOT EXISTS can race on pg_type.
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEST_DIRS = ['server', 'shared', 'scripts', 'tests', 'client/src']
const TEST_FILE_RE = /\.test\.m?js$/
const RUN_TIMEOUT_MS = Number(process.env.TEST_RUN_TIMEOUT_MS || 15 * 60 * 1000)

/** Repo-relative, sorted test files under TEST_DIRS (node_modules excluded). */
export function discoverTestFiles(root, dirs = TEST_DIRS) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(child)
      else if (e.isFile() && TEST_FILE_RE.test(e.name)) out.push(child)
    }
  }
  for (const d of dirs) walk(d)
  return out.sort()
}

/**
 * Totals and per-file pass/fail/skip/todo from tests/summary-reporter.mjs
 * output (one JSON object per line). Suites (describe) are not counted as tests.
 */
export function summarizeEvents(text, root) {
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 }
  const byFile = {}
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'suite') continue
    const file = e.file ? path.relative(root, e.file).split(path.sep).join('/') : '(unknown)'
    const f = (byFile[file] ||= { pass: 0, fail: 0, skipped: 0, todo: 0 })
    totals.tests++
    const kind = e.event === 'fail' ? 'fail' : e.skip ? 'skipped' : e.todo ? 'todo' : 'pass'
    totals[kind]++
    f[kind]++
  }
  return { totals, byFile }
}

/** Gate rules; returns { ok, errors }. */
export function evaluateRun(summary, { exitCode, failOnSkip = false, expect = {} }) {
  const errors = []
  if (exitCode !== 0) errors.push(`node --test exited ${exitCode}`)
  if (!summary.totals.tests) errors.push('no tests ran')
  if (failOnSkip && summary.totals.skipped) errors.push(`${summary.totals.skipped} skipped test(s); CI requires 0 (is the Postgres service up?)`)
  if (failOnSkip && summary.totals.todo) errors.push(`${summary.totals.todo} todo test(s); CI requires 0`)
  for (const [file, n] of Object.entries(expect)) {
    const got = summary.byFile[file]?.pass ?? 0
    if (got !== n) errors.push(`${file}: expected ${n} passing, got ${got}`)
  }
  return { ok: errors.length === 0, errors }
}

function parseArgs(argv) {
  const out = { failOnSkip: false, expect: {}, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--fail-on-skip') out.failOnSkip = true
    else if (a === '--list') out.list = true
    else if (a === '--expect') {
      const [file, n] = String(argv[++i] || '').split('=')
      if (!file || !/^\d+$/.test(n || '')) throw new Error(`--expect needs <file>=<count>, got "${argv[i]}"`)
      out.expect[file] = Number(n)
    } else throw new Error(`unknown option ${a}`)
  }
  return out
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 2
  }
  const files = discoverTestFiles(root)
  if (args.list) {
    process.stdout.write(files.join('\n') + '\n')
    return 0
  }
  if (!files.length) {
    process.stderr.write('::error::no *.test.js / *.test.mjs files found\n')
    return 1
  }
  for (const [file] of Object.entries(args.expect)) {
    if (!files.includes(file)) {
      process.stderr.write(`::error::--expect names ${file}, which was not discovered\n`)
      return 1
    }
  }
  process.stdout.write(`Running ${files.length} test file(s):\n${files.map((f) => `  ${f}`).join('\n')}\n\n`)
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-prism-tests-'))
  const eventsFile = path.join(dir, 'events.jsonl')
  try {
    const run = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        `--test-reporter=${path.join(root, 'tests', 'summary-reporter.mjs')}`,
        `--test-reporter-destination=${eventsFile}`,
        ...files,
      ],
      // a hung DB connection must not eat the whole CI job budget
      { cwd: root, stdio: 'inherit', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' }
    )
    if (run.error?.code === 'ETIMEDOUT') process.stderr.write(`::error::node --test killed after ${RUN_TIMEOUT_MS / 60000} min\n`)
    const summary = summarizeEvents(readFileSync(eventsFile, 'utf8'), root)
    const { ok, errors } = evaluateRun(summary, { exitCode: run.status ?? 1, failOnSkip: args.failOnSkip, expect: args.expect })
    const t = summary.totals
    process.stdout.write(`\n${files.length} files · ${t.tests} tests · ${t.pass} pass · ${t.fail} fail · ${t.skipped} skipped · ${t.todo} todo\n`)
    if (!args.failOnSkip && t.skipped) process.stdout.write(`note: ${t.skipped} skipped (needs a local Postgres with pgvector: npm run local:up)\n`)
    for (const e of errors) process.stderr.write(`::error::${e}\n`)
    return ok ? 0 : 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
