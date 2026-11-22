// W4-4c lint (AC8, AC9): the scheduler identity and its clock live in one module.
//
//   AC8  `app.scheduler` appears (outside comments and tests) only in server/db/agentScheduler.ts:
//        nothing else can put a transaction on the scheduler identity.
//   AC9  the scheduler module takes its time from the database: no Date.now() / new Date() in the SQL path
//        (the caller's `$now` or now()); the only JS clock allowed is none.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..')
const OWNER = 'db/agentScheduler.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.test\.[mc]?[jt]s$/.test(e.name)) out.push(p)
  }
  return out
}
// a source file without its comments (string contents stay: a SQL text is code)
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

test('AC8 app.scheduler is set only in server/db/agentScheduler.ts', () => {
  const hits = walk(SERVER)
    .filter((f) => /app\.scheduler/.test(code(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SERVER, f).split(path.sep).join('/'))
  assert.deepEqual(hits, [OWNER])
})

test('AC8 the owner module sets it with a transaction-local set_config, behind the xact advisory lock', () => {
  const src = code(fs.readFileSync(path.join(SERVER, OWNER), 'utf8'))
  assert.match(src, /set_config\(\s*'app\.scheduler'\s*,\s*'on'\s*,\s*true\s*\)/)
  assert.doesNotMatch(src, /set_config\(\s*'app\.scheduler'\s*,\s*'on'\s*,\s*false/)
  assert.match(src, /pg_try_advisory_xact_lock/)
})

test('AC9 the scheduler\'s database module never reads the process clock', () => {
  const src = code(fs.readFileSync(path.join(SERVER, OWNER), 'utf8'))
  assert.doesNotMatch(src, /Date\.now\(|new Date\(\s*\)|performance\.now/)
})
