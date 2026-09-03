#!/usr/bin/env node
// Offline QA for the built-in Python execution UDF (shared/pythonUdf.js).
//
//   node scripts/python-udf-qa.mjs
//
// The UDF body is the Python that runs inside Databricks for every Python tool
// call. The guarantee we care about here is EXPLICIT ISOLATION: one invocation
// must never see state left by another — neither user bindings (variables /
// imports / defs) nor the mutable global state of the pre-imported modules
// (the `random` RNG, the `decimal` context). In production each call is a
// separate SQL statement, but the warehouse can REUSE the same Python worker
// across calls, so isolation has to come from the UDF body itself, not from a
// fresh process.
//
// This harness reproduces that worst case: it wraps the REAL UDF body in a
// `run(code)` function and invokes it several times inside ONE python3 process
// (a stand-in for a reused worker). If state leaks between calls, it leaks here.
import { spawnSync } from 'node:child_process'
import { PYTHON_UDF_BODY } from '../shared/pythonUdf.js'

let failures = 0
const assert = (cond, msg) => {
  if (cond) { console.log('ok  -', msg); return }
  failures++
  console.error('FAIL:', msg)
}

// Indent the UDF body one level so it becomes the suite of a `def run(code):`.
// The body uses bare `return`, which is only legal inside a function — exactly
// how Databricks wraps a LANGUAGE PYTHON UDF — so we mirror that here.
const indented = PYTHON_UDF_BODY.split('\n').map((l) => (l ? '    ' + l : l)).join('\n')

// The driver: define run(), then execute a sequence of calls in the SAME
// interpreter and print each result on its own line for the JS side to compare.
const CALLS = [
  // 1. a variable set in one call must not exist in the next (user-binding isolation)
  'result = 41 + 1',
  "result = str('leaked' if 'x_from_prev' in dir() else 'clean')\nx_from_prev = 1",
  "result = str('leaked' if 'x_from_prev' in dir() else 'clean')",
  // 2. an import in one call must not carry into the next
  'import os\nresult = os.getcwd()[:0] + "imported-ok"',
  "result = str('leaked' if 'os' in dir() else 'clean')",
  // 3. random: seeding + drawing in one call must not bias a later draw
  'random.seed(123)\nresult = random.random()',
  'result = random.random()',            // must NOT equal the seed(123) first-draw
  'random.seed(123)\nresult = random.random()',  // re-seed reproduces call #6 exactly
  // 4. decimal: mangling the context in one call must not affect a later call
  'import decimal\ndecimal.getcontext().prec = 2\nresult = str(decimal.Decimal(1) / decimal.Decimal(3))',
  'import decimal\nresult = str(decimal.Decimal(1) / decimal.Decimal(3))', // default prec (28)
]

const driver = `
import json, sys
def run(code):
${indented}

_calls = json.loads(sys.stdin.read())
for _c in _calls:
    print(json.dumps(run(_c)))
`

const proc = spawnSync('python3', ['-c', driver], { input: JSON.stringify(CALLS), encoding: 'utf8' })
if (proc.status !== 0) {
  console.error('python3 failed to run the UDF body:\n', proc.stderr || proc.stdout)
  process.exit(1)
}
const out = proc.stdout.trim().split('\n').map((l) => JSON.parse(l))

assert(out[0] === '42', 'a call returns its own `result` (42)')
assert(out[1] === 'clean', 'a fresh call does not see a later-defined variable')
assert(out[2] === 'clean', 'a variable defined in one call does NOT leak into the next (fresh ns)')
assert(out[3] === 'imported-ok', 'a call can import a stdlib module it needs')
assert(out[4] === 'clean', 'an import in one call does NOT leak into the next')
assert(out[5] !== out[6], 'random: a later call is not stuck on the previous call\'s seeded draw')
assert(out[5] === out[7], 'random: re-seeding with the same seed reproduces the draw (RNG reset per call)')
assert(out[8] === '0.33', 'decimal: a call that lowers precision to 2 digits gets 0.33')
assert(out[9] === '0.3333333333333333333333333333', 'decimal: a later call runs at the DEFAULT precision (context reset per call)')

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\npython-udf QA passed')
