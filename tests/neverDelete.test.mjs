// The deploy NEVER deletes a resource of the user and NEVER replaces/recreates an existing one.
//  - `bundle plan -o json` (read-only) is checked BEFORE any workspace write and the deploy
//    applies exactly that plan (`bundle deploy --plan`): a delete/recreate, an unreadable plan or a
//    failing plan command aborts (fail closed, no opt-out);
//  - no --auto-approve / --force / destroy / purge anywhere executable;
//  - the auto-config job never drops or truncates anything, and replaces the Python UDF only
//    when it is AI Prism's (see tests/pythonUdfOwnership.test.mjs).
// The gate segment of deploy.sh is executed for real against a fake CLI fed with fixture plans;
// deploy.ps1 (pwsh is not on every dev host) is pinned by static parity checks here, and run
// end to end in tests/deployWrappers.test.mjs when pwsh is installed (CI has it).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8')
// executable lines only: whole-line comments (# ...) may quote the forbidden commands
const code = (f) => read(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

const sh = read('deploy.sh')
const ps = read('deploy.ps1')

describe('deploy scripts: nothing destructive, nothing approved silently', () => {
  test('no --auto-approve / --force / --purge / bundle destroy is ever executed', () => {
    for (const f of ['deploy.sh', 'deploy.ps1']) {
      const c = code(f)
      assert.doesNotMatch(c, /--auto-approve/, `${f}: --auto-approve`)
      assert.doesNotMatch(c, /^\s*(?:& )?databricks\s+bundle\s+destroy/m, `${f}: bundle destroy`)
      // --purge only inside the guidance text of the soft-deleted-project check (printed, never run)
      for (const m of c.matchAll(/^.*--purge.*$/gm)) assert.match(m[0], /delete-project projects\/.*--purge/, `${f}: --purge outside guidance text: ${m[0]}`)
      // --force only inside a message or a variable (the saved plan never gets it)
      for (const m of c.matchAll(/^.*--force.*$/gm)) assert.doesNotMatch(m[0], /bundle (deploy|plan)/, `${f}: --force on a bundle command`)
    }
  })

  test('every `bundle deploy` applies the checked plan (--plan <file>); there is no plain deploy', () => {
    const shDeploys = [...code('deploy.sh').matchAll(/^\s*databricks bundle deploy .*$/gm)].map((m) => m[0])
    assert.ok(shDeploys.length >= 1)
    for (const l of shDeploys) assert.match(l, /--plan "\$PLAN_OUT"/, l)
    const psDeploys = [...code('deploy.ps1').matchAll(/^\s*& databricks bundle deploy .*$/gm)].map((m) => m[0])
    assert.ok(psDeploys.length >= 1)
    for (const l of psDeploys) assert.match(l, /--plan \$planFile/, l)
    assert.doesNotMatch(code('deploy.ps1'), /Invoke-Db bundle deploy/)
  })

  test('the gate has no opt-out and runs BEFORE the deploy and every other workspace write (sh and ps1)', () => {
    for (const f of [sh, ps]) assert.doesNotMatch(f, /SKIP_PLAN|SKIP_GATE|NO_PLAN|SkipPlan|SkipGate/i, 'there must be no way to skip the gate')
    const iPlan = sh.indexOf('databricks bundle plan -p "$PROFILE"')
    const iDeploy = sh.indexOf('databricks bundle deploy -p "$PROFILE"')
    assert.ok(iPlan > 0 && iPlan < iDeploy)
    const shCode = code('deploy.sh')
    const shGate = shCode.indexOf('\nrun_plan_gate\n')
    assert.ok(shGate > 0, 'deploy.sh: the gate call was not found')
    for (const w of ['databricks apps start', 'databricks bundle run', 'databricks apps deploy', 'databricks jobs submit', 'databricks secrets', 'databricks bundle deploy', 'databricks bundle deployment']) {
      for (const m of shCode.matchAll(new RegExp(w.replace(/ /g, '\\s+'), 'g'))) {
        // `bundle deployment migrate` appears only inside the hint the gate prints
        // the capability probes (`bundle deploy --help`) are read-only and run first on purpose
        const rest = shCode.slice(m.index + w.length, m.index + w.length + 12)
        if (w === 'databricks bundle deployment' || (w === 'databricks bundle deploy' && (/^ment/.test(rest) || /^ --help/.test(rest)))) continue
        assert.ok(m.index > shGate, `deploy.sh: ${w} at offset ${m.index} comes before the gate (${shGate})`)
      }
    }
    assert.ok(shCode.includes('databricks apps start'), 'sanity: the search found the writes it guards')
    const pPlan = ps.indexOf('bundle plan -p $Perfil')
    const pDeploy = ps.indexOf('databricks bundle deploy -p $Perfil')
    assert.ok(pPlan > 0 && pPlan < pDeploy)
    const pGate = ps.search(/^\. \$InvokePlanGate$/m)
    assert.ok(pGate > 0 && pGate < pDeploy, 'ps1: the gate call comes right before the deploy section')
    for (const w of ['databricks apps start', 'bundle run $Job', 'databricks apps deploy', 'databricks jobs submit']) {
      assert.ok(pGate < ps.indexOf(w), `deploy.ps1: ${w} before the gate`)
    }
  })

  test('the CLI must have `bundle plan` and `bundle deploy --plan`, checked first (sh and ps1)', () => {
    assert.ok(sh.indexOf('bundle plan --help') > 0 && sh.indexOf('bundle plan --help') < sh.indexOf('check_lakebase_project "$APP"\n'))
    assert.ok(ps.indexOf('bundle plan --help') > 0 && ps.indexOf('bundle plan --help') < ps.indexOf('Test-LakebaseProject $App $Perfil'))
    assert.match(sh, /Update the CLI \(>= 1\.17\)/)
    assert.match(ps, /Update the CLI \(>= 1\.17\)/)
  })

  test('sh and ps1 share the same gate vocabulary (delete/recreate, plan_version, migrate command, retry error)', () => {
    for (const f of [sh, ps]) {
      assert.match(f, /delete.*recreate|'delete', 'recreate'|"delete", "recreate"/)
      assert.match(f, /plan_version/)
      assert.match(f, /deployment.{1,6}migrate/)
      assert.match(f, /Failed to grant permissions for \.\* on database projects\//)
      assert.match(f, /AI_PRISM_LAKEBASE_WAKE_TIMEOUT/)
      assert.match(f, /AI_PRISM_PG_PORT/)
      assert.match(f, /generate-database-credential/)
      assert.doesNotMatch(f, /NATURA|Natura|natura/, 'no Natura text')
    }
  })

  test('the gate is an ALLOWLIST in both shells: create/skip/update/update_id/resize, explicit checks (no assert), supported plan_version', () => {
    for (const f of [sh, ps]) {
      for (const a of ['create', 'skip', 'update', 'update_id', 'resize']) assert.match(f, new RegExp(`['"]${a}['"]`), a)
      assert.match(f, /plan_version/)
      assert.match(f, /SUPPORTED_PLAN_VERSIONS|supportedPlanVersions/)
    }
    assert.match(sh, /SAFE_ACTIONS = \("create", "skip", "update", "update_id", "resize"\)/)
    assert.match(ps, /\$safeActions = @\('create', 'skip', 'update', 'update_id', 'resize'\)/)
    assert.doesNotMatch(code('deploy.sh'), /^\s*assert\b/m, 'deploy.sh: `assert` is skipped under python -O; use explicit checks')
    // the denylist is gone: nothing may pass just because it is not one of two forbidden strings
    assert.doesNotMatch(sh, /\.lower\(\) in \("delete", "recreate"\)/)
  })

  test('the retry is ONE retry: it redoes the plan AND the gate, then deploys the new plan', () => {
    assert.equal([...code('deploy.sh').matchAll(/run_plan_gate$/gm)].length, 2, 'sh: the gate runs at the start and once on the retry')
    assert.equal([...code('deploy.ps1').matchAll(/^\s*\. \$InvokePlanGate$/gm)].length, 2, 'ps1: the gate runs at the start and once on the retry')
    assert.equal([...code('deploy.sh').matchAll(/^\s*if ! run_deploy; then$/gm)].length, 2)
  })
})

describe('bundle/*.py: the auto-config job never deletes or recreates', () => {
  const bundlePy = readdirSync(path.join(ROOT, 'bundle')).filter((f) => f.endsWith('.py')).map((f) => `bundle/${f}`)
  const DESTRUCTIVE = [
    /\bDROP\s+(CATALOG|SCHEMA|VOLUME|TABLE|VIEW|FUNCTION|ROLE|DATABASE|MATERIALIZED|STREAMING|SHARE|CONNECTION)/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bREVOKE\b/i,
    /\bOVERWRITE\b/i,
    /\bCREATE\s+OR\s+REPLACE\s+(?:TEMP(?:ORARY)?\s+)?(CATALOG|SCHEMA|VOLUME|TABLE|VIEW|MATERIALIZED|STREAMING)/i,
  ]
  test('there are files to scan (auto_config.py and python_udf_ddl.py)', () => {
    assert.ok(bundlePy.includes('bundle/auto_config.py') && bundlePy.includes('bundle/python_udf_ddl.py'))
  })
  test('no DROP / DELETE FROM / TRUNCATE / REVOKE / OVERWRITE / CREATE OR REPLACE of anything but the guarded UDF', () => {
    for (const f of bundlePy) {
      // the only DROP in the file is the advice an error message gives to the OPERATOR (never executed)
      const c = code(f).replace(/^\s*f"[^\n]*`DROP FUNCTION \{fq_name\}`[^\n]*$/m, '')
      for (const re of DESTRUCTIVE) assert.doesNotMatch(c, re, `${f} matches ${re}`)
    }
  })
  test('the only CREATE OR REPLACE FUNCTION is in python_udf_ddl.py, and only when replace=True', () => {
    for (const f of bundlePy) {
      const has = /CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(code(f))
      assert.equal(has, f === 'bundle/python_udf_ddl.py', `${f}: CREATE OR REPLACE FUNCTION ${has ? 'present' : 'absent'}`)
    }
    const ddl = read('bundle/python_udf_ddl.py')
    assert.match(ddl, /verb = "CREATE OR REPLACE FUNCTION" if replace else "CREATE FUNCTION"/)
    assert.match(ddl, /def python_udf_ddl\(fq_name: str, replace: bool = False, owner_tag: str = ""\)/)
  })
  test('catalog, schema and volume are only created with IF NOT EXISTS', () => {
    const py = code('bundle/auto_config.py')
    assert.doesNotMatch(py, /\bCREATE\s+CATALOG\s+(?!IF NOT EXISTS)/i)
    for (const m of py.matchAll(/CREATE\s+(SCHEMA|VOLUME)\s+(?!IF NOT EXISTS)/gi)) assert.fail(`CREATE ${m[1]} without IF NOT EXISTS`)
  })
})

describe('the plan gate of deploy.sh, executed for real against a fake CLI fed with fixture plans', () => {
  const start = sh.indexOf('DB_EP="projects/$APP/branches/production/endpoints/primary"')
  const endMarker = 'rm -f "$PLAN_OUT" "$DEPLOY_LOG"\n'
  const end = sh.lastIndexOf(endMarker) + endMarker.length
  assert.ok(start > 0 && end > start, 'gate segment not found in deploy.sh')
  const SEGMENT = sh.slice(start, end)

  // fake `databricks`: `bundle plan` answers plan.<n> (the n-th call) or FAKE_PLAN, or fails with FAKE_RC;
  // `bundle deploy` records its arguments and the CONTENT of the --plan file, and answers deploy.<n>.{rc,out};
  // `postgres get-endpoint` answers FAKE_EP (without it: no endpoint yet = first deploy). Everything is logged.
  const run = ({ plan = null, rc = 0, plans = [], deployResults = [], endpoint = null, env = {} }) => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'gate-'))
    const bin = path.join(d, 'databricks')
    writeFileSync(bin, `#!/usr/bin/env bash
bump() { local n=0; [ -f "$FAKE_DIR/$1" ] && n=$(cat "$FAKE_DIR/$1"); n=$((n+1)); echo "$n" > "$FAKE_DIR/$1"; echo "$n"; }
if [ "$1 $2" = "bundle plan" ]; then
  echo "$@" >> "$FAKE_LOG"
  [ "$FAKE_RC" != 0 ] && { echo "boom from plan" >&2; exit "$FAKE_RC"; }
  n=$(bump plan.count)
  if [ -f "$FAKE_DIR/plan.$n" ]; then cat "$FAKE_DIR/plan.$n"; exit 0; fi
  [ -n "$FAKE_PLAN" ] && cat "$FAKE_PLAN"
  exit 0
fi
if [ "$1 $2" = "bundle deploy" ]; then
  echo "$@" >> "$FAKE_LOG"
  n=$(bump deploy.count)
  pf=""; prev=""; for a in "$@"; do [ "$prev" = "--plan" ] && pf="$a"; prev="$a"; done
  { echo "deploy $n:"; cat "$pf" 2>/dev/null; echo; } >> "$FAKE_DIR/plans-used"
  [ -f "$FAKE_DIR/deploy.$n.out" ] && cat "$FAKE_DIR/deploy.$n.out"
  [ -f "$FAKE_DIR/deploy.$n.rc" ] && exit "$(cat "$FAKE_DIR/deploy.$n.rc")"
  exit 0
fi
if [ "$1 $2" = "postgres get-endpoint" ]; then
  echo "$@" >> "$FAKE_LOG"
  [ -n "$FAKE_EP" ] && { echo "$FAKE_EP"; exit 0; }
  echo "not found" >&2; exit 1
fi
echo "$@" >> "$FAKE_LOG"
`)
    chmodSync(bin, 0o755)
    const planFile = path.join(d, 'plan.json')
    if (plan !== null) writeFileSync(planFile, plan)
    plans.forEach((p, i) => writeFileSync(path.join(d, `plan.${i + 1}`), p))
    deployResults.forEach((x, i) => {
      writeFileSync(path.join(d, `deploy.${i + 1}.rc`), String(x.rc))
      writeFileSync(path.join(d, `deploy.${i + 1}.out`), x.out ?? '')
    })
    const log = path.join(d, 'log')
    writeFileSync(log, '')
    const script = `set -euo pipefail\nPROFILE=p\nAPP=ai-prism\nTARGET=dev\nVARS=(--var a=b)\n${SEGMENT}\necho FOLLOWED\n`
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${d}:${process.env.PATH}`, FAKE_RC: String(rc), FAKE_PLAN: plan !== null ? planFile : '', FAKE_LOG: log, FAKE_DIR: d, FAKE_EP: endpoint ?? '', ...env },
    })
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    const deploys = calls.filter((c) => c.startsWith('bundle deploy'))
    const plansUsed = existsSync(path.join(d, 'plans-used')) ? readFileSync(path.join(d, 'plans-used'), 'utf8') : ''
    rmSync(d, { recursive: true, force: true })
    return { ...r, deploys, calls, plansUsed }
  }
  const plan = (actions, extra = { plan_version: 2 }) =>
    JSON.stringify({ ...extra, plan: Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, { action: a }])) })
  const OK = { 'resources.apps.ai_prism': 'update', 'resources.jobs.x': 'create', 'resources.dashboards.d': 'skip' }

  test('create/update/skip (direct engine): proceeds and applies EXACTLY the checked plan (--plan <file>)', () => {
    const r = run({ plan: plan(OK) })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /FOLLOWED/)
    assert.match(r.stdout, /ok: no resource will be deleted or recreated/)
    assert.equal(r.deploys.length, 1)
    assert.match(r.deploys[0], /^bundle deploy -p p -t dev --var a=b --plan \S+$/)
    assert.doesNotMatch(r.deploys[0], /--auto-approve|--force/)
    assert.match(r.plansUsed, /resources\.apps\.ai_prism/)
  })
  test('delete: STOPS, lists the resource, no deploy', () => {
    const r = run({ plan: plan({ ...OK, 'resources.sql_warehouses.ai_prism_wh': 'delete' }) })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /resources\.sql_warehouses\.ai_prism_wh \(delete\)/)
    assert.match(r.stderr, /never deletes or recreates an existing resource/)
    assert.match(r.stderr, /nothing was changed in the workspace/)
    assert.doesNotMatch(r.stderr, /partly applied/)
    assert.deepEqual(r.deploys, [])
    assert.doesNotMatch(r.stdout, /FOLLOWED/)
  })
  test('recreate (e.g. a Lakebase pg_version change): STOPS, no deploy', () => {
    const r = run({ plan: plan({ 'resources.postgres_projects.ai_prism_db': 'recreate' }) })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /ai_prism_db \(recreate\)/)
    assert.deepEqual(r.deploys, [])
  })
  test('every delete/recreate is listed, not only the first', () => {
    const r = run({ plan: plan({ ...OK, 'resources.apps.a': 'delete', 'resources.jobs.b': 'recreate' }) })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /resources\.apps\.a \(delete\)/)
    assert.match(r.stderr, /resources\.jobs\.b \(recreate\)/)
  })
  test('a plan without plan_version (Terraform state) ABORTS with the migrate command; there is never a deploy without a checked plan', () => {
    const r = run({ plan: plan(OK, {}) })
    assert.notEqual(r.status, 0)
    assert.doesNotMatch(r.stdout, /FOLLOWED/)
    assert.match(r.stderr, /still uses Terraform state/)
    assert.match(r.stderr, /^ {4}databricks bundle deployment migrate -t dev -p p --var a=b$/m, 'the migrate command is complete, with the same --var')
    assert.match(r.stderr, /Nothing was changed in the workspace/)
    assert.deepEqual(r.deploys, [])
  })
  test('FAILS CLOSED: the plan command fails → abort, no deploy', () => {
    const r = run({ rc: 3 })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /could not get the bundle plan/)
    assert.match(r.stderr, /boom from plan/)
    assert.deepEqual(r.deploys, [])
  })
  test('FAILS CLOSED: output that is not JSON (or empty) → abort, no deploy', () => {
    for (const bad of ['this is not json', '']) {
      const r = run({ plan: bad })
      assert.notEqual(r.status, 0, `output ${JSON.stringify(bad)}`)
      assert.match(r.stderr, /empty, unreadable or has an unexpected shape/)
      assert.deepEqual(r.deploys, [])
    }
  })
  test('FAILS CLOSED: unexpected shape ({}, no plan, no resources, missing action) → abort, no deploy', () => {
    for (const bad of ['{}', '[]', '{"plan": {}}', '{"plan": null}', '{"plan": {"resources.apps.a": {}}}', '{"plan": {"resources.apps.a": {"action": 1}}}', '{"plan": {"apps.a": {"action": "update"}}}']) {
      const r = run({ plan: bad })
      assert.notEqual(r.status, 0, bad)
      assert.deepEqual(r.deploys, [], bad)
    }
  })

  test('ALLOWLIST: the in-place actions the CLI defines (resize, update_id) go through; counted in the summary', () => {
    const r = run({ plan: plan({ ...OK, 'resources.sql_warehouses.w': 'resize', 'resources.schemas.s': 'update_id' }) })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /plan: 1 create, 1 resize, 1 skip, 1 update, 1 update_id/)
    assert.equal(r.deploys.length, 1)
  })
  test('ALLOWLIST: an unknown, empty or differently-cased action STOPS (alone or mixed with valid ones), nothing is deployed', () => {
    for (const action of ['upgrade', 'replace', 'delete_and_create', '', 'DELETE', 'Recreate', ' update', 'update ', 'Update']) {
      const r = run({ plan: plan({ ...OK, 'resources.postgres_projects.ai_prism_db': action }) })
      assert.notEqual(r.status, 0, JSON.stringify(action))
      assert.match(r.stderr, /does not recognise as safe/, JSON.stringify(action))
      assert.ok(r.stderr.includes(`resources.postgres_projects.ai_prism_db (${JSON.stringify(action).replace(/^"|"$/g, "'")})`), `${JSON.stringify(action)}\n${r.stderr}`)
      assert.match(r.stderr, /nothing was changed in the workspace/)
      assert.doesNotMatch(r.stdout, /ok: no resource will be deleted or recreated|FOLLOWED/)
      assert.deepEqual(r.deploys, [], JSON.stringify(action))
    }
    const many = run({ plan: plan({ ...OK, 'resources.a.x': 'upgrade', 'resources.b.y': 'weird', 'resources.c.z': 'delete' }) })
    assert.notEqual(many.status, 0)
    assert.match(many.stderr, /resources\.c\.z \(delete\)/, 'a destructive action keeps its own message')
    const unknown = run({ plan: plan({ ...OK, 'resources.a.x': 'upgrade', 'resources.b.y': 'weird' }) })
    assert.match(unknown.stderr, /resources\.a\.x \('upgrade'\)/)
    assert.match(unknown.stderr, /resources\.b\.y \('weird'\)/)
    assert.doesNotMatch(unknown.stderr, /resources\.jobs\.x/, 'the valid entries are not listed as unsafe')
  })
  test('ALLOWLIST: an unsupported or invalid plan_version (null, string, bool, 0, 1, 3, 2.5, list, object) STOPS and is not mistaken for Terraform state', () => {
    for (const version of ['null', '"2"', 'true', '0', '1', '3', '2.5', '[2]', '{}', '-2']) {
      const r = run({ plan: `{"plan_version":${version},"plan":{"resources.apps.a":{"action":"update"}}}` })
      assert.notEqual(r.status, 0, version)
      assert.match(r.stderr, /plan_version .* which this deploy does not support \(supported: 2\)/, version)
      assert.doesNotMatch(r.stderr, /Terraform state/, version)
      assert.match(r.stderr, /nothing was changed in the workspace/)
      assert.deepEqual(r.deploys, [], version)
    }
    // 2 is the only supported version (CLI 1.17 .. 1.24 all emit currentPlanVersion = 2)
    assert.equal(run({ plan: `{"plan_version":2,"plan":{"resources.apps.a":{"action":"update"}}}` }).status, 0)
  })
  test('ALLOWLIST: a non-resource entry in `plan` is an unexpected shape, not silently filtered out', () => {
    const r = run({ plan: '{"plan_version":2,"plan":{"resources.apps.a":{"action":"update"},"something.else":{"action":"delete"}}}' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /unexpected shape \(unexpected entry "something\.else"\)/)
    assert.deepEqual(r.deploys, [])
  })

  describe('cold Lakebase: the deploy that hit "Failed to grant permissions ... deadline exceeded"', () => {
    const GRANT_ERR = 'Error: cannot create apps.ai_prism: Failed to grant permissions for SP 1234-abcd on database projects/ai-prism/branches/production/databases/databricks-postgres: deadline exceeded after 998000000ns'
    const PLAN1 = plan({ ...OK, 'resources.jobs.first': 'update' })
    const PLAN2 = plan({ ...OK, 'resources.jobs.second': 'update' })
    test('redoes the plan and the gate and retries ONCE with the NEW plan', () => {
      const r = run({ plans: [PLAN1, PLAN2], deployResults: [{ rc: 1, out: GRANT_ERR + '\n' }, { rc: 0, out: 'ok\n' }] })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /FOLLOWED/)
      assert.equal(r.deploys.length, 2)
      assert.equal(r.calls.filter((c) => c.startsWith('bundle plan')).length, 2)
      assert.match(r.stderr, /hit the deadline granting the database permission/)
      assert.match(r.plansUsed, /deploy 1:[\s\S]*resources\.jobs\.first[\s\S]*deploy 2:[\s\S]*resources\.jobs\.second/)
      assert.doesNotMatch(r.plansUsed.split('deploy 2:')[1], /first/)
    })
    test('the retry passes through the gate again: a new plan with delete/recreate aborts, no second deploy', () => {
      for (const bad of ['delete', 'recreate']) {
        const r = run({ plans: [PLAN1, plan({ ...OK, 'resources.postgres_projects.ai_prism_db': bad })], deployResults: [{ rc: 1, out: GRANT_ERR }, { rc: 0 }] })
        assert.notEqual(r.status, 0, bad)
        assert.doesNotMatch(r.stdout, /FOLLOWED/)
        assert.match(r.stderr, new RegExp(`ai_prism_db \\(${bad}\\)`))
        assert.equal(r.deploys.length, 1)
        assert.match(r.stderr, /first deploy may have been partly applied/, 'on the retry it does not claim nothing changed')
        assert.doesNotMatch(r.stderr, /nothing was changed in the workspace/)
      }
    })
    test('an unknown action or an invalid plan_version on the retry aborts as well', () => {
      for (const bad of [plan({ ...OK, 'resources.a.x': 'upgrade' }), JSON.stringify({ plan_version: null, plan: { 'resources.apps.a': { action: 'update' } } })]) {
        const r = run({ plans: [PLAN1, bad], deployResults: [{ rc: 1, out: GRANT_ERR }, { rc: 0 }] })
        assert.notEqual(r.status, 0)
        assert.equal(r.deploys.length, 1)
        assert.match(r.stderr, /partly applied/)
      }
    })
    test('an unreadable or Terraform plan on the retry aborts as well', () => {
      for (const bad of ['this is not json', plan(OK, {})]) {
        const r = run({ plans: [PLAN1, bad], deployResults: [{ rc: 1, out: GRANT_ERR }, { rc: 0 }] })
        assert.notEqual(r.status, 0)
        assert.equal(r.deploys.length, 1)
        assert.match(r.stderr, /partly applied/)
      }
    })
    test('the retry fails too → abort (a single retry, never a loop)', () => {
      const r = run({ plans: [PLAN1, PLAN2], deployResults: [{ rc: 1, out: GRANT_ERR }, { rc: 1, out: GRANT_ERR }, { rc: 0 }] })
      assert.notEqual(r.status, 0)
      assert.doesNotMatch(r.stdout, /FOLLOWED/)
      assert.equal(r.deploys.length, 2)
      assert.match(r.stderr, /failed again after the retry/)
    })
    test('any OTHER deploy error (even another "deadline exceeded") aborts without retrying', () => {
      for (const out of ['Error: permission denied\n', 'Error: deadline exceeded after 998000000ns\n', 'Failed to grant permissions for SP x on catalog main: PERMISSION_DENIED\n']) {
        const r = run({ plans: [PLAN1, PLAN2], deployResults: [{ rc: 1, out }, { rc: 0 }] })
        assert.notEqual(r.status, 0, out)
        assert.equal(r.deploys.length, 1, out)
        assert.equal(r.calls.filter((c) => c.startsWith('bundle plan')).length, 1, 'no new plan')
      }
    })
    test('a deploy that works the first time: one plan, one deploy', () => {
      const r = run({ plans: [PLAN1], deployResults: [{ rc: 0, out: 'ok\n' }] })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.deploys.length, 1)
      assert.equal(r.calls.filter((c) => c.startsWith('bundle plan')).length, 1)
    })
  })

  describe('wake the Lakebase endpoint before the deploy (read-only, best effort)', () => {
    const EP = (state, extra = {}) => JSON.stringify({ name: 'projects/ai-prism/branches/production/endpoints/primary', status: { current_state: state, hosts: { host: '127.0.0.1' }, ...extra } })
    const SLOW = { AI_PRISM_LAKEBASE_WAKE_TIMEOUT: '1', AI_PRISM_PG_PORT: '1' }
    test('first deploy (the endpoint does not exist yet): nothing to wake, goes on', () => {
      const r = run({ plan: plan(OK) })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.calls.join('\n'), /postgres get-endpoint projects\/ai-prism\/branches\/production\/endpoints\/primary -p p -o json/)
      assert.doesNotMatch(r.calls.join('\n'), /generate-database-credential/)
      assert.equal(r.deploys.length, 1)
    })
    test('ACTIVE endpoint: no connection is opened', () => {
      const r = run({ plan: plan(OK), endpoint: EP('ACTIVE') })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /Lakebase: endpoint ACTIVE/)
      assert.doesNotMatch(r.calls.join('\n'), /generate-database-credential|current-user/)
    })
    test('endpoint turned off on purpose (disabled): untouched', () => {
      const r = run({ plan: plan(OK), endpoint: EP('IDLE', { disabled: true }) })
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.calls.join('\n'), /generate-database-credential/)
    })
    test('IDLE endpoint: tries to wake it; if it cannot, it only WARNS and the deploy goes on (bounded wait)', () => {
      const r = run({ plan: plan(OK), endpoint: EP('IDLE'), env: SLOW })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /Lakebase: endpoint IDLE; waking it/)
      assert.match(r.stderr, /WARNING: (could not wake Lakebase|the Lakebase endpoint is still not ACTIVE)/)
      assert.equal(r.deploys.length, 1)
    })
    test('waking only READS: nothing beyond get-endpoint, generate-database-credential and current-user', () => {
      const r = run({ plan: plan(OK), endpoint: EP('IDLE'), env: SLOW })
      const others = r.calls.filter((c) => !/^(bundle |postgres get-endpoint|postgres generate-database-credential|current-user me)/.test(c))
      assert.deepEqual(others, [])
    })
  })
})
