// Tests for the installer notebook generator (scripts/build-installer-notebook.py)
// and the committed output "Install AI Prism.py". Needs python3 (no Databricks calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'Install AI Prism.py'
const LEGACY = 'Instalar AI Prism.py'
const read = () => readFileSync(path.join(ROOT, NAME), 'utf8')

test('AC1: notebook has the English name, the legacy file is gone, regeneration is byte-identical', () => {
  assert.ok(existsSync(path.join(ROOT, NAME)))
  assert.ok(!existsSync(path.join(ROOT, LEGACY)))
  const dir = mkdtempSync(path.join(tmpdir(), 'w311-'))
  try {
    const out = path.join(dir, NAME)
    const r = spawnSync('python3', ['scripts/build-installer-notebook.py', out], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(out, 'utf8'), read())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC2: no Portuguese left in the generated notebook (except the legacy self-skip literal)', () => {
  const text = read().split('\n').filter((l) => !l.includes('"Instalar AI Prism"')).join('\n')
  const markers = ['verificar', 'instalar', 'catálogo', 'catalogo', 'origem', 'não', 'Troque', 'Corrija',
    'Preencha', 'Ação', 'Pasta', 'projeto pronto', 'usuário', 'sem serverless', 'Tudo certo', 'faltando']
  for (const m of markers) assert.ok(!text.toLowerCase().includes(m.toLowerCase()), `Portuguese marker found: ${m}`)
  assert.doesNotMatch(text, /[áàâãéêíóôõúç]/i, 'accented Portuguese letters found')
  assert.equal(
    spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: '', encoding: 'utf8' }).status, 0)
})

test('AC3: widgets use the exact English names/defaults/choices and are read under those names', () => {
  const t = read()
  const expected = [
    'dbutils.widgets.text("catalog", "ai_prism", "1. Unity Catalog catalog")',
    'dbutils.widgets.dropdown("action", "check", ["check", "install"], "2. Action")',
    'dbutils.widgets.text("source", "", "3. Project folder or .zip (optional)")',
    'dbutils.widgets.text("cli_zip", "", "4. CLI zip (offline clusters only)")',
    'dbutils.widgets.dropdown("serverless", "yes", ["yes", "no"], "5. Workspace has serverless?")',
    'dbutils.widgets.text("lakebase_minutes_until_sleep", "", "6. Lakebase: idle minutes before sleep (optional)")',
    'dbutils.widgets.text("usage_policy_id", "", "7. Serverless usage policy id (optional)")',
    'dbutils.widgets.text("tags", "", "8. Resource tags (key=value, comma-separated)")',
  ]
  for (const e of expected) assert.ok(t.includes(e), `missing widget: ${e}`)
  const defined = [...t.matchAll(/dbutils\.widgets\.(?:text|dropdown)\("([^"]+)"/g)].map((m) => m[1])
  const read_ = [...t.matchAll(/dbutils\.widgets\.get\("([^"]+)"\)/g)].map((m) => m[1])
  assert.deepEqual(defined, ['catalog', 'action', 'source', 'cli_zip', 'serverless', 'lakebase_minutes_until_sleep', 'usage_policy_id', 'tags'])
  assert.deepEqual([...new Set(read_)].sort(), [...defined].sort())
  assert.match(t, /ACTION != "install"/)
  assert.match(t, /== "yes"/)
})

test('AC4: export self-skip ignores both the new and the legacy notebook name', () => {
  const t = read()
  const m = t.match(/^INSTALLER_NOTEBOOK_PREFIXES = .*\ndef is_installer_notebook\(name\):\n.*$/m)
  assert.ok(m, 'is_installer_notebook predicate not found')
  const probe = `${m[0]}
assert is_installer_notebook("Install AI Prism")
assert is_installer_notebook("Instalar AI Prism")
assert not is_installer_notebook("deploy")
assert not is_installer_notebook("auto_config")
print("ok")`
  const r = spawnSync('python3', ['-I', '-c', probe], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(t, /if is_installer_notebook\(name\): continue/)
})
