// The auto-config job (bundle/auto_config.py) never replaces a function that is not its own.
//
// `ai_prism_python_exec` may already exist in the user's schema, created by another project (a
// fork ships the same name and the same descriptive COMMENT), by another AI Prism deployment, or by
// an earlier AI Prism release. Ownership is therefore a RECORD kept with the function, not the
// description: the COMMENT ends with `[ai-prism-owner v1 app=… target=… install=<random> fn=<UC name>]`,
// compared exactly before any replace. A function with no record is adopted only when its signature
// AND body are ones AI Prism shipped; anything else FAILS the job with the operator's decision and
// nothing is changed. Because a replace can drop the direct grants of the function, they are read
// before and re-applied after (GRANT only, never REVOKE); if they cannot be read it is not replaced.
//
// provision_python_udf is extracted from auto_config.py and run for real in python3 against a fake
// `spark` and a fake `databricks.sdk`; bundle/python_udf_ddl.py is also checked against the JS source.
// The app never creates or replaces the function at runtime (server/tools.ts): checked statically.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PYTHON_UDF_COMMENT, pythonUdfDDL } from '../shared/pythonUdf.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = readFileSync(path.join(ROOT, 'bundle/auto_config.py'), 'utf8')
const FQ = 'c.s.ai_prism_python_exec'
const TAG_RE = /\[ai-prism-owner v1 app=([\w.-]+) target=([\w.-]+) install=([0-9a-f]{32}) fn=([\w.-]+)\]$/

describe('provision_python_udf: never replaces a function that is not this deployment\'s (run for real)', () => {
  // from the imports of the generated module through provision_python_udf, up to the call site
  const m = /from python_udf_ddl import \([\s\S]*?(?=\n\nfq_name = )/.exec(src)
  assert.ok(m, 'provision_python_udf not found in bundle/auto_config.py')

  const SCRIPT = `
import sys, json, re, types
import re as _re, uuid as _uuid
sys.path.insert(0, sys.argv[1])
import python_udf_ddl as gen
spec = json.loads(sys.argv[2])
issued = []

# --- fake databricks.sdk: functions.get returns the spec'd FunctionInfo, NotFound when absent ---
class NotFound(Exception): pass
class PermissionDenied(Exception): pass
ns = lambda **kw: types.SimpleNamespace(**kw)
class Functions:
    def get(self, name):
        issued.append("GET " + name)
        if spec.get("get_error") == "permission": raise PermissionDenied("not allowed to read the function")
        i = spec.get("info")
        if i is None: raise NotFound("does not exist")
        body = gen._BODY if i.get("body") == "current" else i.get("body")
        return ns(comment=i.get("comment"), owner=i.get("owner", "someone"), created_by=i.get("created_by", "someone"),
                  function_id=i.get("function_id", "fid-1"), routine_definition=body,
                  input_params=ns(parameters=[ns(name=n, type_text=t) for n, t in i.get("params", [["code", "string"]])]),
                  data_type=i.get("data_type", "STRING"), external_language=i.get("language", "Python"))
sdk = types.ModuleType("databricks.sdk"); errors = types.ModuleType("databricks.sdk.errors")
sdk.WorkspaceClient = lambda: ns(functions=Functions()); errors.NotFound = NotFound
sys.modules.update({"databricks": types.ModuleType("databricks"), "databricks.sdk": sdk, "databricks.sdk.errors": errors})

class Row(list): pass
class R:
    def __init__(s, rows): s.rows = rows
    def collect(s): return s.rows
class Spark:
    def __init__(s): s.grants = {("group-x", "EXECUTE"), ("other", "MANAGE")} if spec.get("info") else set()
    def sql(s, q):
        issued.append(q)
        if q.startswith("SHOW GRANTS"):
            if spec.get("grants_fail"): raise RuntimeError("no permission on grants")
            return R([Row([p, a, "FUNCTION", "x"]) for p, a in sorted(s.grants)] + [Row(["owner", "OWN", "FUNCTION", "x"]), Row(["inherited", "EXECUTE", "SCHEMA", "c.s"])])
        if q.startswith("CREATE OR REPLACE"):
            s.grants = set()  # worst case: the replace drops the direct grants
        if q.startswith("GRANT"):
            g = re.match(r"GRANT (\\w+) ON FUNCTION \\S+ TO (.*)", q)
            s.grants.add((g.group(2).strip(chr(96)), g.group(1)))
        return R([])
spark = Spark()
${m[0]}
try:
    provision_python_udf("c.s.ai_prism_python_exec", spec.get("app", "ai-prism"), spec.get("target", "dev"))
    out = "ok"
except Exception as e:
    out = type(e).__name__ + ": " + str(e)
ddl = [q for q in issued if q.startswith("CREATE")]
print(json.dumps({"out": out, "ddl": ddl, "heads": [q.split("(")[0] for q in ddl], "n_ddl": len(ddl),
                  "grants": sorted(spark.grants), "grant_stmts": [q for q in issued if q.startswith("GRANT")],
                  "revokes": [q for q in issued if "REVOKE" in q.upper()]}))
`
  const run = (spec) => {
    const r = spawnSync('python3', ['-I', '-c', SCRIPT, path.join(ROOT, 'bundle'), JSON.stringify(spec)], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  }
  // the COMMENT the DDL carries: what follows `COMMENT '` on the function's own COMMENT line
  const commentOf = (ddl) => /\n COMMENT '([\s\S]*?)'\n AS /.exec(ddl)?.[1] ?? ''
  const ours = (extra = {}) => ({ app: 'ai-prism', target: 'dev', ...extra })
  const tagFor = (app, target, install = 'a'.repeat(32), fn = FQ) => `[ai-prism-owner v1 app=${app} target=${target} install=${install} fn=${fn}]`
  const refused = (r) => {
    assert.match(r.out, /^RuntimeError: a function c\.s\.ai_prism_python_exec already exists and /, r.out)
    assert.match(r.out, /nothing was changed/)
    assert.match(r.out, /DROP FUNCTION c\.s\.ai_prism_python_exec/, 'tells the operator what to decide')
    assert.equal(r.n_ddl, 0, 'no DDL may be issued')
    assert.deepEqual(r.grant_stmts, [])
  }

  test('does not exist: CREATE FUNCTION (no OR REPLACE) that records this deployment with a random install id', () => {
    const r = run(ours())
    assert.equal(r.out, 'ok')
    assert.deepEqual(r.heads, [`CREATE FUNCTION ${FQ}`])
    const tag = TAG_RE.exec(commentOf(r.ddl[0]))
    assert.ok(tag, commentOf(r.ddl[0]))
    assert.deepEqual([tag[1], tag[2], tag[4]], ['ai-prism', 'dev', FQ])
    const again = TAG_RE.exec(commentOf(run(ours()).ddl[0]))
    assert.notEqual(again[3], tag[3], 'the install id is random')
  })

  test('recorded for THIS deployment: CREATE OR REPLACE keeps the install id and the record; grants come back', () => {
    const install = '0123456789abcdef0123456789abcdef'
    const r = run(ours({ info: { comment: `${PYTHON_UDF_COMMENT} ${tagFor('ai-prism', 'dev', install)}`, body: 'old body, an upgrade replaces it' } }))
    assert.equal(r.out, 'ok')
    assert.deepEqual(r.heads, [`CREATE OR REPLACE FUNCTION ${FQ}`])
    assert.equal(TAG_RE.exec(commentOf(r.ddl[0]))[3], install)
    assert.deepEqual(r.grants, [['group-x', 'EXECUTE'], ['other', 'MANAGE']])
    assert.deepEqual(r.grant_stmts, [`GRANT EXECUTE ON FUNCTION ${FQ} TO \`group-x\``, `GRANT MANAGE ON FUNCTION ${FQ} TO \`other\``])
    assert.deepEqual(r.revokes, [])
  })

  test('ANOTHER deployment\'s function (same descriptive COMMENT, other app / target / function name) is NOT replaced', () => {
    for (const other of [tagFor('other-app', 'dev'), tagFor('ai-prism', 'prod'), tagFor('ai-prism', 'dev', 'b'.repeat(32), 'x.y.ai_prism_python_exec')]) {
      refused(run(ours({ info: { comment: `${PYTHON_UDF_COMMENT} ${other}`, body: 'current' } })))
    }
    const r = run(ours({ info: { comment: `${PYTHON_UDF_COMMENT} ${tagFor('other-app', 'dev', 'c'.repeat(32))}`, body: 'current' } }))
    assert.match(r.out, /recorded as belonging to another deployment \(app other-app, target dev/)
  })

  test('a function with exactly our descriptive COMMENT but no record and a different body (e.g. a fork\'s) is NOT replaced', () => {
    for (const comment of [PYTHON_UDF_COMMENT, `${PYTHON_UDF_COMMENT} (fork)`, 'Executa código Python', '']) {
      refused(run(ours({ info: { comment, body: "return 'the fork\\'s own implementation'" } })))
    }
    // a record that is not at the END of the COMMENT is not a record
    refused(run(ours({ info: { comment: `${tagFor('ai-prism', 'dev')} and more text`, body: 'other code' } })))
  })

  test('no record, our body but another signature / return type / language: NOT replaced', () => {
    for (const info of [
      { params: [['src', 'string']] }, { params: [['code', 'int']] }, { params: [['code', 'string'], ['x', 'string']] },
      { data_type: 'INT' }, { language: 'SQL' },
    ]) {
      refused(run(ours({ info: { comment: PYTHON_UDF_COMMENT, body: 'current', ...info } })))
    }
  })

  test('no record, AI Prism\'s signature AND a body it shipped: adopted (CREATE OR REPLACE with a NEW record), whitespace-insensitive', () => {
    const gen = spawnSync('python3', ['-I', '-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'bundle'))})\nimport python_udf_ddl as g\nprint(json.dumps(g._BODY))`], { encoding: 'utf8' })
    const current = JSON.parse(gen.stdout)
    const variants = [current, current.replace(/\n/g, '\r\n') + '\r\n', '\n\n' + current.split('\n').map((l) => l + '   ').join('\n') + '\n\n']
    for (const body of variants) {
      const r = run(ours({ info: { comment: 'an older comment', body } }))
      assert.equal(r.out, 'ok', JSON.stringify(body.slice(0, 40)))
      assert.deepEqual(r.heads, [`CREATE OR REPLACE FUNCTION ${FQ}`])
      assert.ok(TAG_RE.exec(commentOf(r.ddl[0])), 'the adopted function now carries this deployment\'s record')
      assert.deepEqual(r.grants, [['group-x', 'EXECUTE'], ['other', 'MANAGE']])
    }
    // a one-character change in the body is no longer a shipped definition
    refused(run(ours({ info: { comment: PYTHON_UDF_COMMENT, body: current.replace('_LIMIT = 200000', '_LIMIT = 200001') } })))
  })

  test('cannot read the existing function (permission, network): fails, absence is never assumed', () => {
    const r = run(ours({ get_error: 'permission', info: { comment: '', body: '' } }))
    assert.match(r.out, /^PermissionDenied: /)
    assert.equal(r.n_ddl, 0)
  })

  test('cannot read the grants of the function it owns: it does NOT replace (fails before any DDL)', () => {
    const r = run(ours({ grants_fail: true, info: { comment: `${PYTHON_UDF_COMMENT} ${tagFor('ai-prism', 'dev')}`, body: 'x' } }))
    assert.match(r.out, /^RuntimeError: no permission on grants/)
    assert.equal(r.n_ddl, 0)
  })

  test('names that cannot be recorded safely (quote, space) fail before any DDL', () => {
    for (const bad of [{ app: "ai'prism" }, { target: 'dev target' }, { app: '' }]) {
      const r = run({ ...ours(), ...bad })
      assert.match(r.out, /^RuntimeError: cannot record the ownership/, JSON.stringify(bad))
      assert.equal(r.n_ddl, 0)
    }
  })

  test('auto_config provisions the UDF only through provision_python_udf, and every DDL carries the record', () => {
    const body = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    const calls = body.match(/python_udf_ddl\([^\n]*\)/g) || []
    assert.equal(calls.length, 2, calls.join('\n'))
    for (const c of calls) assert.match(c, /owner_tag=tag/, c)
    assert.match(body, /\nprovision_python_udf\(fq_name, app_name, bundle_target\)/)
    assert.doesNotMatch(body, /OWNER_MARKER/, 'the descriptive-substring marker is gone')
    assert.match(readFileSync(path.join(ROOT, 'databricks.yml'), 'utf8'), /bundle_target: \$\{bundle\.target\}/)
  })
})

describe('the app never creates or replaces the UDF at runtime', () => {
  const tools = readFileSync(path.join(ROOT, 'server/tools.ts'), 'utf8')
  const code = tools.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  test('server/tools.ts has no CREATE [OR REPLACE] FUNCTION and does not import the DDL builder', () => {
    assert.doesNotMatch(code, /CREATE (OR REPLACE )?FUNCTION/)
    assert.doesNotMatch(code, /pythonUdfDDL/)
    assert.doesNotMatch(code, /from '\.\.\/shared\/pythonUdf/)
  })
  test('ensureBuiltinPythonTool only DESCRIBEs the function and points to the deploy when it is missing', () => {
    const fn = /export async function ensureBuiltinPythonTool[\s\S]*?\n}\n/.exec(code)?.[0] ?? ''
    assert.match(fn, /DESCRIBE FUNCTION \$\{fq\}/)
    assert.match(fn, /auto-config/)
    assert.match(fn, /deploy\.sh/)
    assert.doesNotMatch(fn, /\b(CREATE|REPLACE|GRANT|DROP|ALTER) /)
  })
  test('no other server module issues DDL on the function', () => {
    for (const f of ['server/turn.ts', 'server/imageStore.ts', 'server/costs.ts']) {
      const text = readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
      assert.doesNotMatch(text, /CREATE (OR REPLACE )?FUNCTION/, f)
    }
  })
})

describe('bundle/python_udf_ddl.py follows shared/pythonUdf.ts', () => {
  const py = (code) => {
    const r = spawnSync('python3', ['-I', '-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'bundle'))})\nimport python_udf_ddl as g\nfrom python_udf_ddl import python_udf_ddl\n${code}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  test('without a record the replace DDL is byte-for-byte the JS one; the plain one is the same with CREATE FUNCTION', () => {
    const out = py(`print(json.dumps({"r": python_udf_ddl("c.s.f", replace=True), "c": python_udf_ddl("c.s.f")}))`)
    assert.equal(out.r, pythonUdfDDL('c.s.f'), 'run `node scripts/gen-python-udf-ddl.mjs` to regenerate bundle/python_udf_ddl.py')
    assert.equal(out.c, pythonUdfDDL('c.s.f').replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION'))
  })
  test('the record is appended to the function COMMENT only', () => {
    const tag = `[ai-prism-owner v1 app=a target=t install=${'1'.repeat(32)} fn=c.s.f]`
    const { d } = py(`print(json.dumps({"d": python_udf_ddl("c.s.f", owner_tag=${JSON.stringify(tag)})}))`)
    assert.equal(d, pythonUdfDDL('c.s.f').replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION').replace(`COMMENT '${PYTHON_UDF_COMMENT}'`, `COMMENT '${PYTHON_UDF_COMMENT} ${tag}'`))
  })
  test('the digests of every body AI Prism has shipped are pinned (a changed body must append the previous digest in the generator)', () => {
    const { known, current, ok } = py(`print(json.dumps({"known": sorted(g.KNOWN_BODY_SHA256), "current": g.CURRENT_BODY_SHA256, "ok": g.body_sha256(g._BODY) == g.CURRENT_BODY_SHA256}))`)
    assert.ok(ok)
    assert.ok(known.includes(current))
    for (const legacy of [
      '525103845cdb9e217b209c99426c777447352691ac93971491f31f2e4b835fe7', // 7eb8ebf: first release (server/tools.js)
      '7e87dd7434cf7fb18f8d070a43e3dac15c8b9fdcd39684c19a93ab8f5a03f594', // 0513755: bundle-provisioned
      'cb34ff3579733b12a928848ecb3d3a161ddddfa90a27bc96f7e7041d65b9e9b8', // 71c9a86: per-call isolation
    ]) assert.ok(known.includes(legacy), legacy)
  })
})
