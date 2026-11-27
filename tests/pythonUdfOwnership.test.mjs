// The auto-config job (bundle/auto_config.py) never replaces a function it did not create.
//
// `ai_prism_python_exec` may already exist in the user's schema. The job creates it when it is
// missing (CREATE FUNCTION, no OR REPLACE) and replaces it (so an upgrade updates the code)
// only when its COMMENT carries the AI Prism ownership marker; a same-named function without the
// marker FAILS the job with a clear message and nothing is changed. Because a replace can drop the
// direct grants of the function, they are read before and re-applied after (GRANT only, never
// REVOKE); if they cannot be read the function is not replaced.
//
// provision_python_udf is extracted from auto_config.py and run for real in python3 against a
// fake `spark`; bundle/python_udf_ddl.py is also checked against the JS source of the UDF.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PYTHON_UDF_COMMENT, pythonUdfDDL } from '../shared/pythonUdf.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = readFileSync(path.join(ROOT, 'bundle/auto_config.py'), 'utf8')
const FQ = 'c.s.ai_prism_python_exec'

describe('provision_python_udf: never replaces a function that is not AI Prism\'s (run for real)', () => {
  // from the grants helper through provision_python_udf, up to the call site
  const m = /def _udf_direct_grants[\s\S]*?(?=\n\nfq_name = )/.exec(src)
  assert.ok(m, 'provision_python_udf not found in bundle/auto_config.py')

  const SCRIPT = `
import sys, json, re
sys.path.insert(0, sys.argv[1])
from python_udf_ddl import python_udf_ddl, OWNER_MARKER
mode, comment = sys.argv[2], sys.argv[3]
issued = []
class Row(list):
    pass
class R:
    def __init__(s, rows): s.rows = rows
    def collect(s): return s.rows
class Spark:
    def __init__(s): s.grants = {("group-x", "EXECUTE"), ("other", "MANAGE")} if mode.startswith("exists") else set()
    def sql(s, q):
        issued.append(q)
        if q.startswith("SHOW USER FUNCTIONS"):
            return R([] if mode == "missing" else [Row(["c.s.ai_prism_python_exec"])])
        if q.startswith("DESCRIBE FUNCTION EXTENDED"):
            if mode == "describe_fails": raise RuntimeError("no permission")
            return R([Row(["Function: c.s.ai_prism_python_exec"]), Row(["Comment: " + comment]), Row(["Body: ..."])])
        if q.startswith("SHOW GRANTS"):
            if mode == "grants_fail": raise RuntimeError("no permission on grants")
            return R([Row([p, a, "FUNCTION", "c.s.ai_prism_python_exec"]) for p, a in sorted(s.grants)] + [Row(["owner", "OWN", "FUNCTION", "x"]), Row(["inherited", "EXECUTE", "SCHEMA", "c.s"])])
        if q.startswith("CREATE OR REPLACE"):
            s.grants = set()  # worst case: the replace drops the direct grants
        if q.startswith("GRANT"):
            g = re.match(r"GRANT (\\w+) ON FUNCTION \\S+ TO (.*)", q)
            s.grants.add((g.group(2).strip(chr(96)), g.group(1)))
        return R([])
spark = Spark()
${m[0]}
try:
    provision_python_udf("c.s.ai_prism_python_exec")
    out = "ok"
except RuntimeError as e:
    out = "error: " + str(e)
ddl = [q for q in issued if q.startswith("CREATE")]
print(json.dumps({"out": out, "ddl": [q.split("(")[0] for q in ddl], "n_ddl": len(ddl),
                  "grants": sorted(spark.grants), "grant_stmts": [q for q in issued if q.startswith("GRANT")],
                  "revokes": [q for q in issued if "REVOKE" in q.upper()]}))
`
  const run = (mode, comment = '') => {
    const r = spawnSync('python3', ['-I', '-c', SCRIPT, path.join(ROOT, 'bundle'), mode, comment], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  }
  const OURS = 'Executa código Python (math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json, datetime disponíveis) e retorna a variável result como texto.'

  test('does not exist: CREATE FUNCTION (no OR REPLACE)', () => {
    const r = run('missing')
    assert.equal(r.out, 'ok')
    assert.deepEqual(r.ddl, [`CREATE FUNCTION ${FQ}`])
  })
  test('exists and is ours (ownership COMMENT, also the one earlier versions wrote): CREATE OR REPLACE, so an upgrade updates the code', () => {
    const r = run('exists', OURS)
    assert.equal(r.out, 'ok')
    assert.deepEqual(r.ddl, [`CREATE OR REPLACE FUNCTION ${FQ}`])
  })
  test('exists and is NOT ours: FAILS with a clear message and no DDL is issued', () => {
    for (const comment of ['', 'Somebody else\'s function', 'Executa código Python']) {
      const r = run('exists', comment)
      assert.match(r.out, /^error: a function c\.s\.ai_prism_python_exec already exists and is NOT AI Prism's/)
      assert.match(r.out, /nothing was changed/)
      assert.equal(r.n_ddl, 0, `comment ${JSON.stringify(comment)}`)
      assert.deepEqual(r.grant_stmts, [])
    }
  })
  test('cannot read the existing function: fails (it does not replace blindly)', () => {
    const r = run('describe_fails', OURS)
    assert.match(r.out, /^error: no permission/)
    assert.equal(r.n_ddl, 0)
  })
  test('a replace drops the direct grants? They are re-applied (GRANT only, never REVOKE; OWN and inherited are left out)', () => {
    const r = run('exists', OURS)
    assert.equal(r.out, 'ok')
    assert.deepEqual(r.grants, [['group-x', 'EXECUTE'], ['other', 'MANAGE']])
    assert.deepEqual(r.grant_stmts, [`GRANT EXECUTE ON FUNCTION ${FQ} TO \`group-x\``, `GRANT MANAGE ON FUNCTION ${FQ} TO \`other\``])
    assert.deepEqual(r.revokes, [])
  })
  test('cannot read the grants of the existing function: it does NOT replace (fails before any DDL)', () => {
    const r = run('grants_fail', OURS)
    assert.match(r.out, /^error: no permission on grants/)
    assert.equal(r.n_ddl, 0)
  })
  test('auto_config provisions the UDF only through provision_python_udf (never python_udf_ddl directly at the call site)', () => {
    const body = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    assert.equal((body.match(/python_udf_ddl\(/g) || []).length, 2, 'calls: replace=False + replace=True')
    assert.match(body, /\nprovision_python_udf\(fq_name\)/)
    assert.doesNotMatch(body, /spark\.sql\(python_udf_ddl\(fq_name\)\)/)
  })
})

describe('bundle/python_udf_ddl.py follows shared/pythonUdf.ts', () => {
  const py = (code) => {
    const r = spawnSync('python3', ['-I', '-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'bundle'))})\nfrom python_udf_ddl import python_udf_ddl, OWNER_MARKER\n${code}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  test('the replace DDL is byte-for-byte the one the app uses at runtime; the plain one is the same with CREATE FUNCTION', () => {
    const out = py(`print(json.dumps({"r": python_udf_ddl("c.s.f", replace=True), "c": python_udf_ddl("c.s.f")}))`)
    assert.equal(out.r, pythonUdfDDL('c.s.f'), 'run `node scripts/gen-python-udf-ddl.mjs` to regenerate bundle/python_udf_ddl.py')
    assert.equal(out.c, pythonUdfDDL('c.s.f').replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION'))
  })
  test('the ownership marker is the head of the COMMENT the deploy writes on the UDF', () => {
    const { m } = py(`print(json.dumps({"m": OWNER_MARKER}))`)
    assert.ok(m.length > 40 && PYTHON_UDF_COMMENT.startsWith(m), 'the UDF COMMENT changed: regenerate bundle/python_udf_ddl.py and keep the old text recognisable')
  })
})
