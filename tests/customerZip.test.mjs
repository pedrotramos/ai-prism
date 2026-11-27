// The customer ZIP and the folder it is deployed from.
//
// `bundle deploy` uploads the WHOLE folder to the workspace and to the App, and in a folder WITHOUT git
// its sync does not apply .gitignore. So:
//   - databricks.yml excludes by itself what is not the app (sync.exclude), checked with a real
//     `bundle sync --dry-run` in a folder without git and in a git checkout;
//   - scripts/build-customer-zip.sh builds dist/ai-prism-<version>.zip (reproducible, folder entries,
//     manifest format 2 with the sha256 of every file);
//   - deploy.sh / deploy.ps1 refuse any folder that is not exactly that tree (or a clean git
//     checkout) before any workspace call; `--check-tree` / `-CheckTree` runs only that guard.
// The ZIP tests build the real ZIP from HEAD (about 10 s; skipped without node_modules or unzip).
// deploy.ps1 is executed with `pwsh` when it is installed (CI has it) and checked statically otherwise.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import http from 'node:http'
import { promisify } from 'node:util'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8')
const which = (bin) => { const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : '' }
const PWSH = process.env.PWSH || which('pwsh')
const version = JSON.parse(read('package.json')).version
const deploySh = read('deploy.sh')
const deployPs1 = read('deploy.ps1')
const tmpDirs = []
const mktmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d }
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------------------------
// databricks.yml: sync.exclude
// ---------------------------------------------------------------------------------------------

// The bundle's sync patterns are gitignore style: without a leading `/` they match at any level.
function excludePatterns() {
  const m = read('databricks.yml').match(/\nsync:\n([\s\S]*?)\n\nvariables:/)
  assert.ok(m, 'sync block not found')
  const block = m[1]
  return [...block.slice(block.indexOf('  exclude:\n')).matchAll(/^ {4}- ('?)(.+?)\1\s*$/gm)].map((x) => x[2])
}
// Matches a path like the CLI: the pattern is a whole path COMPONENT at any level (`x/**` also matches a file called x);
// `/x` anchors at the root; `*` does not cross `/`; `!x` re-admits what an EARLIER pattern excluded (the last match wins).
// The truth is the real dry-run below; this matcher only keeps the static tests fast.
function isExcluded(patterns, file) {
  let out = false
  for (const raw of patterns) {
    const neg = raw.startsWith('!')
    let pat = neg ? raw.slice(1) : raw
    const anchored = pat.startsWith('/')
    if (anchored) pat = pat.slice(1)
    if (pat.endsWith('/**')) pat = pat.slice(0, -3)
    const re = new RegExp(`${anchored ? '^' : '(^|/)'}${[...pat].map((c) => (c === '*' ? '[^/]*' : c.replace(/[.+^${}()|\\/\[\]]/g, '\\$&'))).join('')}(/|$)`)
    if (re.test(file)) out = !neg
  }
  return out
}

describe('databricks.yml: sync.exclude for a folder without git (the customer ZIP)', () => {
  const pats = excludePatterns()
  const excluded = (f) => isExcluded(pats, f)

  test('excludes EVERY hidden item at any depth and re-admits ONLY the root .npmrc and .nvmrc', () => {
    for (const f of [
      'node_modules/foo/index.js', 'client/node_modules/x/y.js', 'server/__pycache__/a.cpython-310.pyc', 'x.pyc', '.DS_Store', 'client/dist/.DS_Store',
      '.env', '.env.local', 'a/b/.env.prod', 'coverage/lcov.info', 'a/coverage/x', 'scratch/n.txt', 'logs/a.log', 'run.log', 'ai-prism.zip',
      'dist/ai-prism-1.4.0.zip', 'old.tar.gz', 'x.tgz', '.vscode/settings.json', '.github/ci.yml', '.idea/workspace.xml', '.venv/bin/python', '.cache/x/y',
      '.eslintcache', '.gitignore', '.aws/credentials', '.ssh/id_rsa', '.npm/_cacache/x', '.nvm/versions/a', '.zshrc', '.-x', 'a/.hidden/b',
      '.npmrc.local', '.npmignore', '.np-secret', '.nvmrc.backup', '..hidden-secret', '.秘密', 'client/.npmrc.local', 'nested/.np-private/file',
      'client/.npmrc', 'nested/.nvmrc', 'a/b/c/.nvmrc', '.n', '.np', '.nv', '.npm', '.nvm', 'Thumbs.db', 'a/Thumbs.db', 'desktop.ini', 'ai-prism-manifest.txt',
      '.claude/settings.json', '.isaac/x',
    ]) assert.ok(excluded(f), `should be excluded: ${f}`)
    assert.ok(!excluded('.npmrc') && !excluded('.nvmrc'), 'only the root ones')
    for (const f of ['.npmrc/private.txt', '.npmrc/nested/a', '.npmrc/.hidden-inner/token.txt', '.nvmrc/private.txt', '.nvmrc/nested/a', '.nvmrc/.hidden-inner/token.txt'])
      assert.ok(excluded(f), `a FOLDER named like an allowed file: ${f}`)
  })

  test('order matters: `.*` comes before the two root-anchored negations, and nothing else is negated', () => {
    const i = pats.indexOf('.*')
    assert.ok(i >= 0, 'the `.*` pattern is missing')
    assert.deepEqual(pats.filter((p) => p.startsWith('!')), ['!/.npmrc', '!/.nvmrc'])
    assert.ok(pats.indexOf('!/.npmrc') > i && pats.indexOf('!/.nvmrc') > i)
    // a FOLDER .npmrc/.nvmrc would be re-admitted with everything inside: `/.npmrc/*` (not `/**`, which would match the file) comes after
    assert.ok(pats.indexOf('/.npmrc/*') > pats.indexOf('!/.npmrc') && pats.indexOf('/.nvmrc/*') > pats.indexOf('!/.nvmrc'))
    assert.ok(!pats.includes('/.npmrc/**') && !pats.includes('/.nvmrc/**'))
    assert.ok(!pats.some((p) => /\[/.test(p)), 'no character classes (they leaked hidden names)')
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.'
    for (const a of alphabet) for (const b of alphabet) assert.ok(excluded(`.${a}${b}`) && excluded(`x/.${a}${b}/y`), `.${a}${b}`)
  })

  test('does NOT exclude what the App and the job need (server-dist, client/dist, bundle, server, dashboards...)', () => {
    for (const f of [
      'server-dist/index.cjs', 'server-dist/appkit-chunk-ABC.mjs', 'client/dist/index.html', 'client/dist/assets/index-BAQtRQXr.js', 'client/dist/starter-kit/README.md',
      'bundle/auto_config.py', 'bundle/python_udf_ddl.py', 'dashboards/ai-costs.lvdash.json', 'server/index.js', 'server/migrations/0001_baseline.up.sql',
      'shared/pythonUdf.js', 'scripts/migrate.mjs', 'app.yaml', 'package.json', 'package-lock.json', '.npmrc', '.nvmrc', 'deploy.sh', 'deploy.ps1',
      'databricks.yml', 'Install AI Prism.py',
    ]) assert.ok(!excluded(f), `must NOT be excluded: ${f}`)
    assert.ok(!pats.some((p) => /(^|\/)dist(\/|$)/.test(p.replace(/^\//, ''))), 'a `dist/**` pattern (even with a leading `/`) would exclude client/dist')
    assert.ok(!pats.some((p) => /server-dist|client\/dist/.test(p)))
  })

  test('no tracked file the App uses is hit by the patterns (git ls-files)', () => {
    const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    if (r.status !== 0) return
    const NEEDED = /^(client\/dist|bundle|dashboards|server|shared|scripts\/(migrate|smoke)\.mjs|app\.yaml|package(-lock)?\.json|deploy\.(sh|ps1)|databricks\.yml|\.npmrc|\.nvmrc)(\/|$)|^Install AI Prism\.py$/
    assert.deepEqual(r.stdout.split('\n').filter(Boolean).filter((f) => NEEDED.test(f) && excluded(f)), [])
  })
})

// A real `bundle sync --dry-run` with the CLI on PATH (and the 1.17.0 the notebook pins, when AI_PRISM_CLI_117 or /tmp/cli117bin has it).
// The `sync:` block is the real one from databricks.yml; the rest of the bundle is minimal, with a fake local server for `GET /Me`
// (no network access).
const execFileP = promisify(execFile)
const CLIS = [
  ['PATH', spawnSync('databricks', ['--version']).status === 0 ? 'databricks' : null],
  ['1.17.0', [process.env.AI_PRISM_CLI_117, '/tmp/cli117bin/databricks'].find((c) => c && existsSync(c)) ?? null],
].filter(([, bin]) => bin)
const HIDDEN_LEAKS = [
  '.npmrc.local', '.npmignore', '.np-secret', '.nv-secret', '.nvmrc.backup', '..hidden-secret', '.秘密', '.env', '.env.local', '.git-credentials',
  '.DS_Store', '.eslintcache', '.idea/w.xml', '.venv/bin/python', '.cache/c', '.npm/_cacache/x', '.nvm/v/x', '.n/z', '.nA/a', '.n0/b',
  'client/.npmrc', 'client/.npmrc.local', 'client/.nvmrc', 'nested/.np-private/file', 'nested/.nvmrc', 'a/b/c/.env',
]
const JUNK = ['node_modules/a/b.js', 'client/node_modules/x/y.js', '__pycache__/a.pyc', 'coverage/l', 'scratch/n', 'logs/x.log', 'a.log', 'x.zip', 'Thumbs.db', 'desktop.ini', 'ai-prism-manifest.txt']
const NEEDED = ['server-dist/index.cjs', 'server-dist/appkit-chunk-ABC.mjs', 'client/dist/index.html', 'client/dist/assets/a.js', 'bundle/auto_config.py', 'server/index.js', 'dashboards/ai-costs.lvdash.json', 'app.yaml', 'package.json', 'deploy.sh', '.npmrc', '.nvmrc']
const DIR_LEAKS = ['.npmrc/private.txt', '.npmrc/nested/a', '.npmrc/.hidden-inner/token.txt', '.nvmrc/private.txt', '.nvmrc/nested/a', '.nvmrc/.hidden-inner/token.txt']

async function dryRunPut({ bin, git, dirs = false }) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(/scim/.test(req.url) ? { userName: 'test@example.com', id: '1' } : /get-status/.test(req.url) ? { object_type: 'DIRECTORY', object_id: 1, path: '/Users/test@example.com/mini/files' } : {}))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const d = mkdtempSync(path.join(os.tmpdir(), 'ai-prism-sync-'))
  try {
    const block = read('databricks.yml').match(/\nsync:\n[\s\S]*?\n\nvariables:/)[0].replace(/\n\nvariables:$/, '')
    const put = (rel, body = 'x') => { const f = path.join(d, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, body) }
    writeFileSync(path.join(d, 'databricks.yml'), `bundle:\n  name: mini\n\ntargets:\n  dev:\n    default: true\n    workspace:\n      host: http://127.0.0.1:${server.address().port}\n      root_path: /Users/test@example.com/mini\n${block}\n`)
    // dirs: .npmrc and .nvmrc are FOLDERS (with nested and hidden files inside) instead of files
    for (const f of [...NEEDED.filter((x) => !(dirs && ['.npmrc', '.nvmrc'].includes(x))), ...HIDDEN_LEAKS, ...JUNK, ...(dirs ? DIR_LEAKS : [])]) put(f)
    if (git) {
      // git checkout: the repository's .gitignore does not cover local copies of credentials
      put('.gitignore', 'node_modules/\n.env\n')
      spawnSync('git', ['init', '-q'], { cwd: d })
    }
    const env = { PATH: process.env.PATH, HOME: d, DATABRICKS_TOKEN: 'x', DATABRICKS_CONFIG_FILE: path.join(d, 'none.cfg') }
    const { stdout } = await execFileP(bin, ['bundle', 'sync', '--dry-run', '--full', '-t', 'dev', '-o', 'json'], { cwd: d, env, timeout: 120000, maxBuffer: 1 << 26 })
    const files = new Set()
    for (const l of stdout.split('\n')) { try { for (const f of JSON.parse(l).put ?? []) files.add(f) } catch { /* a line that is not JSON */ } }
    return [...files].sort()
  } finally {
    server.close()
    rmSync(d, { recursive: true, force: true })
  }
}

describe('databricks.yml: a real `bundle sync --dry-run` (folder without git and git checkout)', { skip: CLIS.length === 0 && 'no Databricks CLI on PATH' }, () => {
  for (const [label, bin] of CLIS) {
    for (const git of [false, true]) {
      test(`CLI ${label}, ${git ? 'git checkout' : 'folder without git (the ZIP)'}: no hidden item is uploaded, except the root .npmrc and .nvmrc; server-dist/ and client/dist/ are`, async () => {
        const put = await dryRunPut({ bin, git })
        const hidden = put.filter((f) => f.split('/').some((c) => c.startsWith('.')))
        assert.deepEqual(hidden, ['.npmrc', '.nvmrc'], `hidden items uploaded: ${hidden}`)
        for (const f of HIDDEN_LEAKS.filter((x) => !['.npmrc', '.nvmrc'].includes(x))) assert.ok(!put.includes(f), `must not be uploaded: ${f}`)
        assert.deepEqual(put.filter((f) => JUNK.includes(f)), [], 'dev junk that must not be uploaded')
        for (const f of NEEDED) assert.ok(put.includes(f), `must be uploaded: ${f}`)
      })
      test(`CLI ${label}, ${git ? 'git checkout' : 'folder without git'}: a FOLDER named .npmrc/.nvmrc (and what is inside, even hidden) is NOT uploaded`, async () => {
        const put = await dryRunPut({ bin, git, dirs: true })
        const hidden = put.filter((f) => f.split('/').some((c) => c.startsWith('.')))
        assert.deepEqual(hidden, [], `hidden items uploaded: ${hidden}`)
        for (const f of NEEDED.filter((x) => !['.npmrc', '.nvmrc'].includes(x))) assert.ok(put.includes(f), `must be uploaded: ${f}`)
      })
    }
  }
})

// ---------------------------------------------------------------------------------------------
// scripts/build-customer-zip.sh (static)
// ---------------------------------------------------------------------------------------------

describe('scripts/build-customer-zip.sh', () => {
  const sh = read('scripts/build-customer-zip.sh')

  test('is executable, fails early, and the ZIP is not tracked by git', () => {
    assert.ok(statSync(path.join(ROOT, 'scripts/build-customer-zip.sh')).mode & 0o111, 'no execute bit')
    assert.match(sh, /^set -euo pipefail$/m)
    assert.match(read('.gitignore'), /^\/dist\/$/m)
    assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'scripts/build-customer-zip.sh')]).status, 0)
  })

  test('asks for `npm ci --include=dev` (.npmrc omits devDependencies, where vite/esbuild live) and checks the tools', () => {
    assert.match(sh, /for tool in vite esbuild; do/)
    for (const l of sh.split('\n').filter((l) => /npm ci/.test(l) && !/^\s*#/.test(l))) assert.match(l, /npm ci --include=dev/, l.trim())
    assert.match(read('.npmrc'), /^omit=dev$/m)
  })

  test('the KEEP allow-list has what the customer needs and nothing dev-only; the build outputs are rebuilt', () => {
    const keep = sh.match(/^KEEP=\(\n([\s\S]*?)\n\)$/m)[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).map((l) => l.replace(/^"|"$/g, ''))
    for (const must of ['databricks.yml', 'app.yaml', 'package.json', 'package-lock.json', '.npmrc', '.nvmrc', 'deploy.sh', 'deploy.ps1', 'Install AI Prism.py', 'bundle', 'dashboards', 'server', 'shared', 'docs',
      'README.md', 'CHANGELOG.md', 'LICENSE', 'scripts/migrate.mjs', 'scripts/smoke.mjs'])
      assert.ok(keep.includes(must), `missing from KEEP: ${must}`)
    for (const bad of ['tests', 'node_modules', '.git', '.github', '.claude', 'client/src', 'client/e2e', '.gitignore', 'scripts'])
      assert.ok(!keep.includes(bad), `must not be in KEEP: ${bad}`)
    assert.match(sh, /^BUILT=\(server-dist client\/dist\)$/m)
  })

  test('the FORBIDDEN_RE filter catches dev junk at any level and lets what ships through', () => {
    const re = sh.match(/^FORBIDDEN_RE='(.*)'$/m)[1]
    const grep = (f) => spawnSync('grep', ['-E', re], { input: `${f}\n`, encoding: 'utf8' }).status === 0
    for (const f of ['node_modules/a/b.js', 'x/node_modules/y', '.git/HEAD', '.github/ci.yml', '.claude/s.json', '.isaac/x', 'tests/a.mjs', 'client/e2e/a.mjs', 'coverage/x', 'scratch/n', 'logs/a',
      'a/__pycache__/b', 'x.pyc', '.DS_Store', 'a/.DS_Store', '.env', 'a/.env.local', 'run.log', 'ai-prism.zip', 'b.tar.gz', 'client/src/main.tsx', 'client/dev/a.jsx', 'server/a.test.ts',
      'server/x/b.test.mjs', 'docs/a.patch', '.vscode/s', 'docs/pt-BR/.llm-prompt.md', 'docs/i18n-pending/a.md', 'server/__fixtures__/a.json'])
      assert.ok(grep(f), `should be blocked: ${f}`)
    for (const f of ['databricks.yml', 'deploy.sh', 'server-dist/index.cjs', 'client/dist/index.html', 'client/dist/assets/index-BAQtRQXr.js', 'bundle/auto_config.py', 'server/index.ts', 'server/migrations/0001_baseline.up.sql',
      'docs/tags.md', 'docs/pt-BR/onboarding-deployment.md', 'Install AI Prism.py', '.npmrc', '.nvmrc', 'scripts/migrate.mjs'])
      assert.ok(!grep(f), `must not be blocked: ${f}`)
  })

  test('there is no --skip-build (a stale server-dist from the working tree must never reach the customer)', () => {
    assert.doesNotMatch(sh, /skip-build|SKIP_BUILD/)
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/build-customer-zip.sh'), '--skip-build'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown argument/)
  })
})

// ---------------------------------------------------------------------------------------------
// the real ZIP
// ---------------------------------------------------------------------------------------------

const canRun = existsSync(path.join(ROOT, 'node_modules')) && spawnSync('unzip', ['-v']).status === 0 && spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).status === 0
describe('the real customer ZIP: ai-prism/ root folder, manifest, folder guard, --check-tree', { skip: !canRun }, () => {
  const out = mktmp('ai-prism-zip-test-')
  const ext = mktmp('ai-prism-zip-ext-')
  const zip = path.join(out, `ai-prism-${version}.zip`)
  const cleanEnv = (env = {}) => { const e = { ...process.env, ...env }; if (!('SOURCE_DATE_EPOCH' in env)) delete e.SOURCE_DATE_EPOCH; return e }
  const build = spawnSync('bash', [path.join(ROOT, 'scripts/build-customer-zip.sh'), '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: cleanEnv() })
  const entries = build.status === 0 ? spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean) : []
  const files = entries.filter((f) => !f.endsWith('/')).map((f) => f.replace(/^ai-prism\//, ''))
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

  // Extracts the ZIP and puts the working tree's deploy.sh/deploy.ps1/notebook in it (the ZIP comes from HEAD), with their hashes in the manifest.
  const extract = (d) => {
    spawnSync('unzip', ['-q', '-o', zip, '-d', d])
    const tree = path.join(d, 'ai-prism')
    const mf = path.join(tree, 'ai-prism-manifest.txt')
    let text = readFileSync(mf, 'utf8')
    for (const f of ['deploy.sh', 'deploy.ps1']) {
      const cur = readFileSync(path.join(ROOT, f))
      writeFileSync(path.join(tree, f), cur, { mode: f === 'deploy.sh' ? 0o755 : 0o644 })
      text = text.replace(new RegExp(`^[0-9a-f]{64}( {2}${f.replace('.', '\\.')})$`, 'm'), `${sha256(cur)}$1`)
    }
    writeFileSync(mf, text)
    return tree
  }
  const tree = () => { const t = extract(mktmp('ai-prism-tree-')); return t }
  const ENV = (d) => ({ PATH: '/usr/bin:/bin', HOME: d, LC_ALL: 'C' }) // no Databricks CLI on PATH: --check-tree must not need it
  const checkSh = (t, extraEnv = {}) => spawnSync('bash', [path.join(t, 'deploy.sh'), '--check-tree'], { cwd: t, encoding: 'utf8', env: { ...ENV(path.dirname(t)), ...extraEnv } })
  const checkPs1 = (t, extraEnv = {}) => spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', path.join(t, 'deploy.ps1'), '-CheckTree'], { cwd: t, encoding: 'utf8', env: { ...process.env, ...extraEnv } })
  // pwsh renders an uncaught `throw` as a colored, width-wrapped block: join it back so assertions read the message
  const flat = (text) => text.replace(/\x1B\[[0-9;]*m/g, '').replace(/\s*\n\s*\|?\s*/g, ' ')
  // Both wrappers must reach the SAME verdict on the same folder (ps1 only when pwsh exists)
  const both = (t, fn) => { fn('sh', (x) => checkSh(t, x), (s) => s); if (PWSH) fn('ps1', (x) => checkPs1(t, x), flat) }

  test('builds dist/ai-prism-<version>.zip with only what is needed (fresh server-dist and client/dist), ALL inside ai-prism/', () => {
    assert.equal(build.status, 0, build.stderr + build.stdout)
    assert.ok(existsSync(zip))
    assert.ok(entries.length > 100 && entries.every((f) => f.startsWith('ai-prism/')), 'every entry is inside the ai-prism/ root folder')
    for (const must of ['databricks.yml', 'deploy.sh', 'deploy.ps1', 'app.yaml', 'package.json', 'package-lock.json', 'Install AI Prism.py', 'bundle/auto_config.py', 'bundle/python_udf_ddl.py',
      'dashboards/ai-costs.lvdash.json', 'server-dist/index.cjs', 'client/dist/index.html', 'scripts/migrate.mjs', 'scripts/smoke.mjs', 'server/migrations/0001_baseline.up.sql', 'LICENSE', 'CHANGELOG.md',
      'README.md', 'README.pt-BR.md', 'README.es.md', 'docs/onboarding-deployment.md', 'docs/pt-BR/onboarding-deployment.md', 'docs/es/onboarding-deployment.md', 'ai-prism-manifest.txt'])
      assert.ok(files.includes(must), `missing from the ZIP: ${must}`)
    const re = new RegExp(read('scripts/build-customer-zip.sh').match(/^FORBIDDEN_RE='(.*)'$/m)[1])
    assert.deepEqual(files.filter((f) => re.test(f)), [])
    assert.deepEqual(files.filter((f) => /(^|\/)\./.test(f) && !['.npmrc', '.nvmrc'].includes(f)), [], 'only .npmrc/.nvmrc are hidden')
    assert.match(build.stdout, /files \(\+ \d+ folder entries\), .* — ai-prism-/)
    assert.match(build.stdout, /root of ai-prism/)
  })

  test('the ZIP has an entry for EVERY folder (the Workspace import needs the parent before the file), the folder before its content', () => {
    const dirs = new Set(entries.filter((e) => e.endsWith('/')))
    assert.equal(entries[0], 'ai-prism/')
    assert.ok(dirs.size >= 30, `folder entries: ${dirs.size}`)
    const seen = new Set()
    for (const e of entries) {
      const parts = e.replace(/\/$/, '').split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/') + '/'
        assert.ok(dirs.has(parent), `missing the folder entry ${parent} (parent of ${e})`)
        assert.ok(seen.has(parent), `${parent} must come before ${e}`)
      }
      seen.add(e)
    }
    for (const d of ['ai-prism/', 'ai-prism/server/', 'ai-prism/server-dist/', 'ai-prism/client/dist/assets/', 'ai-prism/docs/', 'ai-prism/docs/pt-BR/']) assert.ok(dirs.has(d), d)
    // folder entries are not in the manifest (it lists files only)
    const mf = spawnSync('unzip', ['-p', zip, 'ai-prism/ai-prism-manifest.txt'], { encoding: 'utf8' }).stdout
    assert.ok(!mf.split('\n').some((l) => l.endsWith('/')))
  })

  test('the folder-entry check of the build script rejects a ZIP without them (and accepts one with them)', () => {
    const py = read('scripts/build-customer-zip.sh').match(/python3 -I - "\$OUT" <<'PY'[^\n]*\n([\s\S]*?)\nPY\n/)[1]
    const d = mktmp('ai-prism-zipchk-')
    mkdirSync(path.join(d, 'ai-prism/sub/deep'), { recursive: true })
    writeFileSync(path.join(d, 'ai-prism/sub/deep/a.txt'), 'x')
    writeFileSync(path.join(d, 'ai-prism/.npmrc'), 'omit=dev\n')
    const mk = (name, list) => spawnSync('bash', ['-c', `cd "$1" && printf '%s\n' ${list} | zip -X -q "$2" -@`, 'x', d, path.join(d, name)])
    mk('without.zip', 'ai-prism/.npmrc ai-prism/sub/deep/a.txt')
    mk('with.zip', 'ai-prism ai-prism/.npmrc ai-prism/sub ai-prism/sub/deep ai-prism/sub/deep/a.txt')
    mk('late-parent.zip', 'ai-prism ai-prism/sub/deep/a.txt ai-prism/sub ai-prism/sub/deep')
    const run = (z) => spawnSync('python3', ['-I', '-', path.join(d, z)], { input: py, encoding: 'utf8' })
    const bad = run('without.zip')
    assert.notEqual(bad.status, 0)
    assert.match(bad.stderr, /zip without folder entries: ai-prism\/, ai-prism\/sub\//)
    assert.notEqual(run('late-parent.zip').status, 0, 'a parent entry that comes AFTER its content is refused too')
    assert.equal(run('with.zip').status, 0, run('with.zip').stderr)
  })

  test('the ZIP is reproducible: same commit, other time zone and umask => same sha256; the date is the commit\'s (even second); SOURCE_DATE_EPOCH wins', () => {
    const sha = (f) => sha256(readFileSync(f))
    const buildTo = (dir, env = {}, umask = '022') => {
      const r = spawnSync('bash', ['-c', `umask ${umask}; exec bash "$1" --out "$2"`, 'x', path.join(ROOT, 'scripts/build-customer-zip.sh'), dir], { cwd: ROOT, encoding: 'utf8', timeout: 240000, env: cleanEnv(env) })
      assert.equal(r.status, 0, r.stderr + r.stdout)
      return path.join(dir, `ai-prism-${version}.zip`)
    }
    const dates = (f) => [...new Set([...spawnSync('zipinfo', ['-T', f], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).stdout.matchAll(/ (\d{8}\.\d{6}) /g)].map((m) => m[1]))]
    const stamp = (epoch) => new Date(epoch * 1000).toISOString().replace(/[-:]/g, '').replace('T', '.').slice(0, 15) // 20231114.221358
    const dirs = [0, 1, 2, 3].map(() => mktmp('ai-prism-zip-det-'))
    // the describe's build (the environment's zone and umask, SOURCE_DATE_EPOCH cleared)
    assert.equal(sha(buildTo(dirs[0], { TZ: 'Asia/Tokyo' }, '077')), sha(zip), 'umask 077 + another zone: the same commit gives the same ZIP, byte for byte')
    assert.equal(sha(buildTo(dirs[1], { TZ: 'America/Sao_Paulo' }, '002')), sha(zip), 'umask 002')
    // every entry (file and folder) gets the commit date, in UTC, rounded DOWN to an even second
    const ct = Number(spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim())
    assert.deepEqual(dates(zip), [stamp(ct - (ct % 2))])
    // the executable bit of deploy.sh survives; everything else is rw-r--r-- / rwxr-xr-x
    const modes = spawnSync('zipinfo', [zip], { encoding: 'utf8' }).stdout
    assert.match(modes, /-rwxr-xr-x .* ai-prism\/deploy\.sh\n/)
    assert.match(modes, /-rw-r--r-- .* ai-prism\/package\.json\n/)
    assert.match(modes, /drwxr-xr-x .* ai-prism\/server\/\n/)
    assert.ok(!/-rw-rw|-rwxrwx|-rw------|drwx------/.test(modes))
    // SOURCE_DATE_EPOCH wins over the commit date: an odd epoch (…:59, which zip would round up to the next minute) lands on the even second below
    const c = buildTo(dirs[2], { SOURCE_DATE_EPOCH: '1700000039' })
    assert.deepEqual(dates(c), ['20231114.221358'])
    assert.notEqual(sha(c), sha(zip))
    assert.equal(spawnSync('unzip', ['-Z1', c], { encoding: 'utf8' }).stdout, spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout)
    assert.equal(sha(buildTo(dirs[3], { SOURCE_DATE_EPOCH: '1700000039' }, '077')), sha(c), 'the same epoch gives the same ZIP, with another umask too')
  })

  test('the ZIP\'s package-lock.json points at the public registry, not the internal npm proxy', () => {
    spawnSync('unzip', ['-q', '-o', zip, '-d', ext])
    const lock = readFileSync(path.join(ext, 'ai-prism/package-lock.json'), 'utf8')
    assert.doesNotMatch(lock, /npm-proxy/)
    assert.match(lock, /https:\/\/registry\.npmjs\.org\//)
    assert.doesNotMatch(readFileSync(path.join(ext, 'ai-prism/.npmrc'), 'utf8'), /https?:\/\/|registry\s*=/, '.npmrc without a registry/proxy')
  })

  test('ai-prism-manifest.txt (format 2) lists exactly the files of the ZIP (except itself), each with the sha256 of its content', () => {
    const lines = readFileSync(path.join(ext, 'ai-prism/ai-prism-manifest.txt'), 'utf8').split('\n').filter(Boolean)
    assert.equal(lines[0], '# ai-prism-manifest 2')
    assert.match(lines[1], /^# version \S+ commit [0-9a-f]+$/)
    const rows = lines.filter((l) => !l.startsWith('#')).map((l) => { const m = l.match(/^([0-9a-f]{64}) {2}(.+)$/); assert.ok(m, `line outside the format: ${l}`); return [m[2], m[1]] })
    // the installer notebook (the Workspace converts it on import) is in the ZIP but outside the check: "# optional", no hash
    assert.ok(lines.includes('# optional Install AI Prism.py'))
    assert.ok(files.includes('Install AI Prism.py'))
    assert.deepEqual(rows.map((r) => r[0]), files.filter((f) => f !== 'ai-prism-manifest.txt' && f !== 'Install AI Prism.py').sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
    for (const [rel, hash] of rows) assert.equal(sha256(readFileSync(path.join(ext, 'ai-prism', rel))), hash, rel)
  })

  test('every relative import of what deploy.sh runs in the ZIP (scripts/migrate.mjs, scripts/smoke.mjs) is in the ZIP', () => {
    const seen = new Set()
    const missing = []
    const visit = (rel) => {
      if (seen.has(rel)) return
      seen.add(rel)
      const abs = path.join(ext, 'ai-prism', rel)
      const text = readFileSync(abs, 'utf8')
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]))
        const cand = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.js`, `${target}.json`]
        const hit = cand.find((c) => existsSync(path.join(ext, 'ai-prism', c)) && statSync(path.join(ext, 'ai-prism', c)).isFile())
        if (!hit) { missing.push(`${rel} -> ${m[1]}`); continue }
        if (/\.(m?[jt]s|cjs)$/.test(hit)) visit(hit)
      }
    }
    for (const entry of ['scripts/migrate.mjs', 'scripts/smoke.mjs']) visit(entry)
    assert.deepEqual(missing, [])
    assert.ok(seen.size > 5, `traversed ${seen.size} files`)
  })

  describe('folder guard (deploy.sh --check-tree and deploy.ps1 -CheckTree reach the same verdict)', () => {
    test('a freshly extracted tree passes; the generated .databricks/, node_modules/ (npm ci) and OS junk are tolerated', () => {
      const t = tree()
      both(t, (name, run, norm) => {
        const r = run()
        assert.equal(r.status, 0, `${name}: ${r.stderr}${r.stdout}`)
        assert.match(norm(r.stdout), new RegExp(`==> AI Prism ${version.replace(/\./g, '\\.')} commit [0-9a-f]+`))
        assert.ok(norm(r.stdout).trimStart().startsWith('==> AI Prism'), `${name}: the version line is the first line`)
      })
      mkdirSync(path.join(t, '.databricks/bundle/dev'), { recursive: true })
      writeFileSync(path.join(t, '.databricks/bundle/dev/terraform.tfstate'), '{}')
      mkdirSync(path.join(t, 'node_modules/pg'), { recursive: true })
      writeFileSync(path.join(t, 'node_modules/pg/index.js'), 'x')
      writeFileSync(path.join(t, '.DS_Store'), 'x')
      writeFileSync(path.join(t, 'client/Thumbs.db'), 'x')
      writeFileSync(path.join(t, 'desktop.ini'), 'x')
      both(t, (name, run) => { const r = run(); assert.equal(r.status, 0, `${name}: ${r.stderr}`) })
    })

    test('a file OUTSIDE the manifest, or a folder link, is refused and listed; the message explains the import over an old folder', () => {
      const t = tree()
      for (const [rel, body] of [['My CV.pdf', 'x'], ['.env', 'S=1'], ['server/extra.js', 'x'], ['new/dir/a.txt', 'x'], ['.aws/credentials', 'k'], ['sub/.databricks/x', 'x'], ['package.json.bak', 'x'], ['sub/node_modules/x.js', 'x']]) {
        const f = path.join(t, rel)
        const topExisted = existsSync(path.join(t, rel.split('/')[0]))
        mkdirSync(path.dirname(f), { recursive: true })
        writeFileSync(f, body)
        both(t, (name, run, norm) => {
          const r = run()
          assert.notEqual(r.status, 0, `${name}: ${rel}`)
          const msg = norm(r.stderr + r.stdout)
          assert.match(msg, /file\(s\) that are not part of AI Prism/)
          assert.match(msg, /imported a new version of the ZIP .*over an ai-prism\/ folder that already existed.*NEW, empty folder/)
          assert.ok(msg.includes(rel), `${name} ${rel}: ${msg}`)
          assert.match(msg, /nothing was changed/i)
        })
        if (topExisted) rmSync(f, { force: true }); else rmSync(path.join(t, rel.split('/')[0]), { recursive: true, force: true })
      }
      symlinkSync(os.tmpdir(), path.join(t, 'docs-link'))
      both(t, (name, run, norm) => { const r = run(); assert.notEqual(r.status, 0, name); assert.ok(norm(r.stderr + r.stdout).includes('docs-link'), name) })
      rmSync(path.join(t, 'docs-link'))
      // a root node_modules that is a LINK is not exempt (its content would be invisible to the check)
      symlinkSync(os.tmpdir(), path.join(t, 'node_modules'))
      both(t, (name, run, norm) => { const r = run(); assert.notEqual(r.status, 0, name); assert.ok(norm(r.stderr + r.stdout).includes('node_modules'), name) })
      rmSync(path.join(t, 'node_modules'))
      both(t, (name, run) => assert.equal(run().status, 0, `${name}: passes again after cleaning`))
    })

    test('a new ZIP imported OVER an old folder (same list of files, old content, or a missing file) is refused by the hash; app.yaml may change', () => {
      const t = tree()
      const f = path.join(t, 'server/index.ts')
      const orig = readFileSync(f)
      writeFileSync(f, Buffer.concat([orig, Buffer.from('\n// old version\n')]))
      both(t, (name, run, norm) => {
        const r = run()
        assert.notEqual(r.status, 0, name)
        const msg = norm(r.stderr + r.stdout)
        assert.match(msg, /mixes versions of AI Prism: 1 file\(s\) differ from the ZIP \(server\/index\.ts\)/)
        assert.match(msg, /NEW, empty folder/)
        assert.match(msg, /imported \(Workspace -> Import\) over an ai-prism\/ folder that already existed/)
        assert.match(msg, /nothing was changed/)
      })
      writeFileSync(f, orig)
      const missingRel = 'shared/cron.ts'
      const keep = readFileSync(path.join(t, missingRel))
      rmSync(path.join(t, missingRel))
      both(t, (name, run, norm) => assert.match(norm(run().stderr), /shared\/cron\.ts \(missing\)/, name))
      writeFileSync(path.join(t, missingRel), keep)
      both(t, (name, run) => assert.equal(run().status, 0, `${name}: ${run().stderr}`))
      // app.yaml is rewritten by the deploy: it only has to exist
      writeFileSync(path.join(t, 'app.yaml'), readFileSync(path.join(t, 'app.yaml'), 'utf8') + '\n# rewritten by the deploy\n')
      both(t, (name, run) => assert.equal(run().status, 0, `${name}: ${run().stderr}`))
      rmSync(path.join(t, 'app.yaml'))
      both(t, (name, run, norm) => assert.match(norm(run().stderr), /app\.yaml \(missing\)/, name))
      assert.ok(existsSync(path.join(t, 'server/index.ts')), 'the guard deletes nothing when it refuses')
    })

    test('a symlinked file in place of a manifest file is refused (a link could point anywhere)', () => {
      const t = tree()
      const f = path.join(t, 'shared/cron.ts')
      rmSync(f)
      symlinkSync(path.join(t, 'shared/chartValue.ts'), f)
      both(t, (name, run, norm) => { const r = run(); assert.notEqual(r.status, 0, name); assert.match(norm(r.stderr), /shared\/cron\.ts/, name) })
    })

    test('after a Workspace import the installer notebook is converted and the export skips it: the guard PASSES without it, but old/extra/modified files are still refused', () => {
      const t = tree()
      const nbk = path.join(t, 'Install AI Prism.py')
      assert.ok(existsSync(nbk), 'the ZIP carries the notebook')
      const nbContent = readFileSync(nbk)
      rmSync(nbk)
      both(t, (name, run) => assert.equal(run().status, 0, `${name}: without the notebook: ${run().stderr}`))
      writeFileSync(nbk, '# changed\n')
      both(t, (name, run) => assert.equal(run().status, 0, `${name}: a changed notebook is outside the check: ${run().stderr}`))
      rmSync(nbk)
      writeFileSync(path.join(t, 'Install AI Prism 2.py'), nbContent)
      both(t, (name, run, norm) => assert.match(norm(run().stderr), /not part of AI Prism .*Install AI Prism 2\.py/, name))
      rmSync(path.join(t, 'Install AI Prism 2.py'))
      // the other files the import converts (auto_config.py and the dashboards) come back byte for byte on export: they are in the manifest, with a hash
      const mf = readFileSync(path.join(t, 'ai-prism-manifest.txt'), 'utf8')
      for (const f2 of ['bundle/auto_config.py', 'dashboards/ai-costs.lvdash.json']) assert.match(mf, new RegExp(`^[0-9a-f]{64} {2}${f2.replace(/[./]/g, '\\$&')}$`, 'm'))
    })

    test('--check-tree: the SAME guard, no CLI/profile/network, nothing written or deleted (sync snapshots stay)', () => {
      const t = tree()
      const snap = path.join(t, '.databricks/bundle/dev/sync-snapshots')
      mkdirSync(snap, { recursive: true })
      writeFileSync(path.join(snap, 'abc.json'), '{}')
      const before = readFileSync(path.join(t, 'app.yaml'), 'utf8')
      const r = checkSh(t)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /The folder matches the package \(folder guard: ok\)\. Nothing was changed\./)
      assert.ok(existsSync(path.join(snap, 'abc.json')), '--check-tree does not delete the sync snapshot')
      assert.equal(readFileSync(path.join(t, 'app.yaml'), 'utf8'), before)
      // no profile is needed (it is an error without --check-tree)
      const noArgs = spawnSync('bash', [path.join(t, 'deploy.sh')], { cwd: t, encoding: 'utf8', env: ENV(path.dirname(t)) })
      assert.notEqual(noArgs.status, 0)
      assert.match(noArgs.stderr, /usage: .*PROFILE/)
      // one guard function serves the deploy and --check-tree; the version line is printed after the guard
      assert.equal((deploySh.match(/^check_project_tree \|\| exit 1$/gm) || []).length, 1)
      assert.ok(deploySh.indexOf('check_project_tree || exit 1') < deploySh.indexOf('if [ "$CHECK_TREE" = 1 ]; then\n  echo "==> AI Prism'))
      // and it runs before the first CLI call, the Lakebase check and the build
      for (const later of ['command -v databricks', 'check_lakebase_project "$APP"', 'npm run bundle'])
        assert.ok(deploySh.indexOf('check_project_tree || exit 1') < deploySh.indexOf(later, deploySh.indexOf('check_project_tree || exit 1')), later)
    })

    test('a real deploy.sh run is refused by the guard BEFORE any workspace call (a fake CLI on PATH records nothing)', () => {
      const t = tree()
      const bin = mktmp('ai-prism-fakecli-')
      const log = path.join(bin, 'calls.log')
      writeFileSync(path.join(bin, 'databricks'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`)
      chmodSync(path.join(bin, 'databricks'), 0o755)
      writeFileSync(path.join(t, 'server/extra.js'), 'x')
      const r = spawnSync('bash', [path.join(t, 'deploy.sh'), 'someprofile', 'somecatalog'], { cwd: t, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: path.dirname(t), LC_ALL: 'C' } })
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /not part of AI Prism/)
      assert.equal(existsSync(log), false, 'no CLI call was made')
      assert.equal(existsSync(path.join(t, '.databricks')), false, 'nothing was written')
    })

    test('no manifest, a manifest of another format, the home folder: refused (manifest format 1 no longer counts)', () => {
      const d = mktmp('ai-prism-guard-')
      copyFileSync(path.join(ROOT, 'deploy.sh'), path.join(d, 'deploy.sh'))
      writeFileSync(path.join(d, 'a.txt'), 'x')
      const run = (extra = {}) => spawnSync('bash', [path.join(d, 'deploy.sh'), '--check-tree'], { cwd: d, encoding: 'utf8', env: { ...ENV(path.join(d, 'nohome')), ...extra } })
      let r = run()
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /ai-prism-manifest\.txt is missing/)
      for (const header of ['# ai-prism-manifest 9', '# ai-prism-manifest 1']) {
        writeFileSync(path.join(d, 'ai-prism-manifest.txt'), `${header}\na.txt\n`)
        r = run()
        assert.notEqual(r.status, 0)
        assert.match(r.stderr, /unreadable or not a version this script knows/)
      }
      writeFileSync(path.join(d, 'ai-prism-manifest.txt'), '# ai-prism-manifest 2\n# version 9.9.9 commit abc1234\nnot-a-hash  a.txt\n')
      assert.match(run().stderr, /unreadable \(unexpected line\)/)
      const ok = `# ai-prism-manifest 2\n# version 9.9.9 commit abc1234\n${sha256('x')}  a.txt\n${sha256(readFileSync(path.join(d, 'deploy.sh')))}  deploy.sh\n`
      writeFileSync(path.join(d, 'ai-prism-manifest.txt'), ok)
      r = run()
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /==> AI Prism 9\.9\.9 commit abc1234/)
      // the home folder (and, by the same test, the disk root) is refused even with a valid manifest
      r = run({ HOME: d })
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /does not run in .* \(a home folder or the disk root\)/)
      assert.match(deploySh, /\[ "\$here" = "\/" \]/)
    })

    test('the sync snapshots are deleted ONLY outside a git; a link at any component (.databricks, bundle, <target>, sync-snapshots) stops the deploy without deleting anything', () => {
      const d = mktmp('ai-prism-snap-')
      const prepFn = deploySh.match(/project_version\(\) \{[\s\S]*?\n\}\n/)[0] + deploySh.match(/prepare_project_tree\(\) \{[\s\S]*?\n\}\n/)[0]
      const run = (dir, mode = 'zip') => spawnSync('bash', ['-c', `set -uo pipefail\n${prepFn}\ncd "$1"\nPROJECT_MODE=${mode}\nprepare_project_tree`, 'x', dir], { cwd: dir, encoding: 'utf8' })
      const mkProject = (name) => {
        const t = path.join(d, name)
        mkdirSync(t, { recursive: true })
        writeFileSync(path.join(t, 'ai-prism-manifest.txt'), '# ai-prism-manifest 2\n# version 1.2.3 commit abc\n')
        return t
      }
      const mkVictim = (name) => { const v = path.join(d, name); mkdirSync(path.join(v, 'bundle/dev/sync-snapshots'), { recursive: true }); writeFileSync(path.join(v, 'bundle/dev/sync-snapshots/x.json'), '{}'); return v }
      // normal case: deletes the snapshot only
      const ok = mkProject('ok')
      mkdirSync(path.join(ok, '.databricks/bundle/dev/sync-snapshots'), { recursive: true })
      writeFileSync(path.join(ok, '.databricks/bundle/dev/sync-snapshots/a.json'), '{}')
      mkdirSync(path.join(ok, '.databricks/bundle/dev/state'), { recursive: true })
      let r = run(ok)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /==> AI Prism 1\.2\.3 commit abc/)
      assert.ok(!existsSync(path.join(ok, '.databricks/bundle/dev/sync-snapshots')))
      assert.ok(existsSync(path.join(ok, '.databricks/bundle/dev/state')), 'the rest of .databricks stays (deploy state)')
      // in a git checkout nothing is deleted
      const g = mkProject('gitco')
      mkdirSync(path.join(g, '.databricks/bundle/dev/sync-snapshots'), { recursive: true })
      writeFileSync(path.join(g, '.databricks/bundle/dev/sync-snapshots/a.json'), '{}')
      writeFileSync(path.join(g, 'package.json'), JSON.stringify({ version: '7.7.7' }))
      r = run(g, 'git')
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /==> AI Prism 7\.7\.7/)
      assert.ok(existsSync(path.join(g, '.databricks/bundle/dev/sync-snapshots/a.json')), 'in git the mtimes are the real ones: the snapshot stays')
      // 1) .databricks is a link to outside
      let v = mkVictim('victim1'); let t = mkProject('p1'); symlinkSync(v, path.join(t, '.databricks'))
      r = run(t); assert.notEqual(r.status, 0); assert.match(r.stderr, /is a link or is not inside this folder/)
      assert.ok(existsSync(path.join(v, 'bundle/dev/sync-snapshots/x.json')))
      // 2) .databricks/bundle is a link
      v = mkVictim('victim2'); t = mkProject('p2'); mkdirSync(path.join(t, '.databricks')); symlinkSync(path.join(v, 'bundle'), path.join(t, '.databricks/bundle'))
      r = run(t); assert.notEqual(r.status, 0); assert.ok(existsSync(path.join(v, 'bundle/dev/sync-snapshots/x.json')))
      // 3) .databricks/bundle/<target> is a link
      v = mkVictim('victim3'); t = mkProject('p3'); mkdirSync(path.join(t, '.databricks/bundle'), { recursive: true }); symlinkSync(path.join(v, 'bundle/dev'), path.join(t, '.databricks/bundle/dev'))
      r = run(t); assert.notEqual(r.status, 0); assert.ok(existsSync(path.join(v, 'bundle/dev/sync-snapshots/x.json')))
      // 4) sync-snapshots is a link
      v = mkVictim('victim4'); t = mkProject('p4'); mkdirSync(path.join(t, '.databricks/bundle/dev'), { recursive: true }); symlinkSync(path.join(v, 'bundle/dev/sync-snapshots'), path.join(t, '.databricks/bundle/dev/sync-snapshots'))
      r = run(t); assert.notEqual(r.status, 0); assert.ok(existsSync(path.join(v, 'bundle/dev/sync-snapshots/x.json')))
      // 5) the link points INSIDE the project: also refused (real folders only)
      t = mkProject('p5'); mkdirSync(path.join(t, 'real/bundle/dev/sync-snapshots'), { recursive: true }); symlinkSync(path.join(t, 'real'), path.join(t, '.databricks'))
      r = run(t); assert.notEqual(r.status, 0); assert.ok(existsSync(path.join(t, 'real/bundle/dev/sync-snapshots')))
      // 6) a broken link at sync-snapshots
      t = mkProject('p6'); mkdirSync(path.join(t, '.databricks/bundle/dev'), { recursive: true }); symlinkSync(path.join(d, 'does-not-exist'), path.join(t, '.databricks/bundle/dev/sync-snapshots'))
      r = run(t); assert.notEqual(r.status, 0)
    })

    test('in the ZIP mode the build is skipped (the ZIP ships the built artifacts and pins their hash)', () => {
      const i = deploySh.indexOf('if [ "$PROJECT_MODE" = zip ] && [ "$SKIP_BUILD" = 0 ]; then')
      assert.ok(i > deploySh.indexOf('check_project_tree || exit 1'))
      assert.ok(i < deploySh.indexOf('command -v npm'))
      assert.ok(deployPs1.indexOf("if ($script:ProjectMode -eq 'zip' -and -not $SkipBuild)") > 0)
      assert.ok(deployPs1.indexOf("if ($script:ProjectMode -eq 'zip' -and -not $SkipBuild)") < deployPs1.indexOf('Get-Command npm'))
    })
  })

  describe('the installer notebook in the ZIP flow', () => {
    const nb = read('Install AI Prism.py')
    const cells = nb.split('\n# COMMAND ----------\n')
    test('explains the one-upload flow: new empty folder, empty source, check then install, versions in new folders, Volume as an alternative', () => {
      const md = cells[1]
      assert.match(md, /new, empty\*\* folder in the Workspace/)
      assert.match(md, /⋮ → Import → File/)
      assert.match(md, /ai-prism\/Install AI Prism/)
      assert.match(md, /leave the \*\*source\*\* field empty/)
      assert.match(md, /new, empty folder\*\* \(or delete the old folder first\)/)
      assert.match(md, /ai-prism-manifest\.txt/)
      assert.match(md, /package version/)
      assert.match(md, /Alternative \(Volume\)/)
      assert.match(md, /`check` \(creates nothing; it also runs the folder guard, `deploy\.sh --check-tree`/)
    })
    test('shows the package version after building the project copy; ignores itself when exporting the folder', () => {
      assert.match(nb, /ai-prism-manifest\.txt/)
      assert.match(nb, /print\("package version:"/)
      assert.match(nb, /def is_installer_notebook\(name\): return name\.startswith\(INSTALLER_NOTEBOOK_PREFIXES\)/)
    })
    test('`check` runs deploy.sh --check-tree BEFORE any CLI call and records a refusal as a problem (the generated snippet is executed)', () => {
      const cell = cells.find((c) => c.includes('# 3) Checks'))
      assert.ok(cell)
      const a = cell.indexOf('problems = []')
      const b = cell.indexOf('def cli(args):')
      assert.ok(a > 0 && b > a && cell.slice(a, b).includes('"--check-tree"'))
      const snippet = cell.slice(a, b)
      const t = tree()
      const py = `
import subprocess
PROJ = ${JSON.stringify(t)}
def run(cmd, check=True, quiet=False):
    p = subprocess.run(cmd, cwd=PROJ, capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"})
    return p.returncode, p.stdout + p.stderr
${snippet}
print("PROBLEMS=" + repr(problems))
`
      const exec = () => spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8' })
      let r = exec()
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^ok {6}project folder \(manifest and hash of every file\)/m)
      assert.match(r.stdout, /==> AI Prism /)
      assert.match(r.stdout, /PROBLEMS=\[\]/)
      writeFileSync(path.join(t, 'server/index.ts'), 'old version\n')
      r = exec()
      assert.match(r.stdout, /^FAILED {2}project folder/m)
      assert.match(r.stdout, /mixes versions of AI Prism/)
      assert.match(r.stdout, /PROBLEMS=\['the project folder does not match the package/)
    })
    test('finds databricks.yml + deploy.sh inside the ZIP WITH its ai-prism/ root (source = a ZIP in a Volume) and in NB_DIR, NB_DIR/ai-prism, ~/ai-prism', () => {
      const extractFn = cells.find((c) => c.includes('def extract_zip('))
      assert.ok(extractFn)
      const m = extractFn.match(/def extract_zip\(zpath, dst\):[\s\S]*?\n\n/)[0]
      const d = mktmp('ai-prism-nbzip-')
      const py = `
import os, shutil, zipfile
${m}
extract_zip(${JSON.stringify(zip)}, ${JSON.stringify(path.join(d, 'proj'))})
assert os.path.exists(${JSON.stringify(path.join(d, 'proj'))} + "/databricks.yml") and os.path.exists(${JSON.stringify(path.join(d, 'proj'))} + "/deploy.sh")
print("OK")
`
      const r = spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /OK/)
      assert.match(nb, /candidates = \[NB_DIR, os\.path\.join\(NB_DIR, "ai-prism"\), os\.path\.join\(home, "ai-prism"\)\]/)
      // the extracted copy passes the guard
      const t = path.join(d, 'proj')
      assert.equal(spawnSync('bash', [path.join(t, 'deploy.sh'), '--check-tree'], { cwd: t, encoding: 'utf8', env: ENV(d) }).status, 0)
    })
  })

  describe('deploy.ps1 parity (executed with pwsh when available, static otherwise)', () => {
    test('same guard messages and rules as deploy.sh (static)', () => {
      for (const needle of [
        "'# ai-prism-manifest 2'", "'# optional '", "ai-prism-manifest.txt", 'not part of AI Prism', 'mixes versions of AI Prism', "$hashExempt = @('app.yaml', 'models.json')",
        "$exempt = @('.DS_Store', 'Thumbs.db', 'desktop.ini')", 'AI_PRISM_ALLOW_UNTRACKED', 'ls-files --others --exclude-standard', 'function Initialize-ProjectTree',
        'is a link or is not inside this folder', '[switch]$CheckTree', 'ReparsePoint', "'==> AI Prism $(Get-ProjectVersion",
      ]) assert.ok(deployPs1.includes(needle), `deploy.ps1 lacks: ${needle}`)
      assert.ok(deployPs1.indexOf('Test-ProjectTree $PSScriptRoot') < deployPs1.indexOf('Get-Command databricks'))
      assert.ok(deployPs1.indexOf('Test-ProjectTree $PSScriptRoot') < deployPs1.indexOf('Set-Location'))
      assert.ok(deployPs1.indexOf('if ($CheckTree)') > deployPs1.indexOf('function Initialize-ProjectTree'))
      assert.ok(deployPs1.indexOf('Initialize-ProjectTree $PSScriptRoot') > deployPs1.indexOf('if ($CheckTree)'))
    })
    test('the ps1 sync-exclude reader and the sh one read the same patterns (the block of databricks.yml)', () => {
      assert.match(deployPs1, /-ceq 'sync:'/)
      assert.match(deploySh, /line == 'sync:'/)
    })
    test('-CheckTree prints the version first and runs without a profile', { skip: !PWSH && 'pwsh not installed' }, () => {
      const t = tree()
      const r = checkPs1(t)
      assert.equal(r.status, 0, r.stderr + r.stdout)
      assert.match(r.stdout.trimStart(), new RegExp(`^==> AI Prism ${version.replace(/\./g, '\\.')} commit [0-9a-f]+`))
      assert.match(r.stdout, /Nothing was changed\./)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// git checkout (no ZIP needed)
// ---------------------------------------------------------------------------------------------

describe('folder guard in a git checkout: untracked files that the sync would upload', () => {
  const mkCheckout = () => {
    const d = mktmp('ai-prism-gitco-')
    for (const f of ['deploy.sh', 'deploy.ps1', 'databricks.yml', '.gitignore']) copyFileSync(path.join(ROOT, f), path.join(d, f))
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '7.7.7' }))
    spawnSync('git', ['init', '-q'], { cwd: d })
    spawnSync('git', ['add', 'deploy.sh', 'deploy.ps1', 'databricks.yml', '.gitignore', 'package.json'], { cwd: d })
    return d
  }
  const checkSh = (d, env = {}) => spawnSync('bash', [path.join(d, 'deploy.sh'), '--check-tree'], { cwd: d, encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: path.join(d, 'nohome'), LC_ALL: 'C', ...env } })
  const checkPs1 = (d, env = {}) => spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', path.join(d, 'deploy.ps1'), '-CheckTree'], { cwd: d, encoding: 'utf8', env: { ...process.env, ...env } })
  const flat = (text) => text.replace(/\x1B\[[0-9;]*m/g, '').replace(/\s*\n\s*\|?\s*/g, ' ')

  test('a clean checkout passes and prints the package version and commit-less git state', () => {
    const d = mkCheckout()
    const r = checkSh(d)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^==> AI Prism 7\.7\.7/)
    if (PWSH) { const p = checkPs1(d); assert.equal(p.status, 0, p.stderr + p.stdout); assert.match(p.stdout, /^==> AI Prism 7\.7\.7/) }
  })

  test('an untracked file outside .gitignore and the sync excludes (id_rsa, credentials.json, a PDF, server/token.txt) stops the deploy and is listed', () => {
    const d = mkCheckout()
    for (const rel of ['id_rsa', 'credentials.json', 'My CV.pdf', 'server/token.txt']) {
      mkdirSync(path.dirname(path.join(d, rel)), { recursive: true })
      writeFileSync(path.join(d, rel), 'secret')
      const r = checkSh(d)
      assert.notEqual(r.status, 0, rel)
      assert.ok(r.stderr.includes(rel), `${rel}: ${r.stderr}`)
      assert.match(r.stderr, /UNTRACKED file\(s\) outside \.gitignore/)
      assert.match(r.stderr, /AI_PRISM_ALLOW_UNTRACKED=1/)
      assert.match(r.stderr, /Nothing was changed/)
      if (PWSH) { const p = checkPs1(d); assert.notEqual(p.status, 0, `ps1 ${rel}`); assert.ok(flat(p.stderr + p.stdout).includes(rel), `ps1 ${rel}`) }
      rmSync(path.join(d, rel), { force: true })
    }
    assert.equal(checkSh(d).status, 0)
  })

  test('what the sync already excludes, the expected build outputs and .gitignore do not count', () => {
    const d = mkCheckout()
    for (const rel of ['.env', '.idea/x.xml', 'node_modules/a/b.js', 'coverage/l', 'run.log', 'x.zip', 'dist/ai-prism-1.4.0.zip', 'server-dist/appkit-chunk-ABC.mjs', 'client/dist/assets/new-HASH.js', '.DS_Store'])
      { mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); writeFileSync(path.join(d, rel), 'x') }
    const r = checkSh(d)
    assert.equal(r.status, 0, r.stderr)
    if (PWSH) { const p = checkPs1(d); assert.equal(p.status, 0, p.stderr + p.stdout) }
  })

  test('AI_PRISM_ALLOW_UNTRACKED=1 (and only the value 1) turns the check off with a warning', () => {
    const d = mkCheckout()
    writeFileSync(path.join(d, 'id_rsa'), 'secret')
    let r = checkSh(d, { AI_PRISM_ALLOW_UNTRACKED: '1' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /AI_PRISM_ALLOW_UNTRACKED=1: not checking untracked files/)
    assert.notEqual(checkSh(d, { AI_PRISM_ALLOW_UNTRACKED: '0' }).status, 0, 'only the value 1 is the opt-out')
    assert.notEqual(checkSh(d, { AI_PRISM_ALLOW_UNTRACKED: 'true' }).status, 0)
    if (PWSH) { const p = checkPs1(d, { AI_PRISM_ALLOW_UNTRACKED: '1' }); assert.equal(p.status, 0, p.stderr + p.stdout) }
  })

  test('a git ABOVE the folder does not count: the ZIP manifest is still required', () => {
    const d = mkCheckout()
    const sub = path.join(d, 'unzipped')
    mkdirSync(sub)
    copyFileSync(path.join(ROOT, 'deploy.sh'), path.join(sub, 'deploy.sh'))
    const r = spawnSync('bash', [path.join(sub, 'deploy.sh'), '--check-tree'], { cwd: sub, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(d, 'nohome'), LC_ALL: 'C' } })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /ai-prism-manifest\.txt is missing/)
  })

  test('.npmrc / .nvmrc that is a folder or a link aborts a real deploy.sh run before any CLI call', () => {
    for (const name of ['.npmrc', '.nvmrc']) for (const kind of ['dir', 'link']) {
      const d = mkCheckout()
      if (kind === 'dir') mkdirSync(path.join(d, name))
      else symlinkSync(os.tmpdir(), path.join(d, name))
      const bin = mktmp('ai-prism-fakecli-')
      writeFileSync(path.join(bin, 'databricks'), `#!/bin/sh\necho "$@" >> "${bin}/calls.log"\n`)
      chmodSync(path.join(bin, 'databricks'), 0o755)
      const r = spawnSync('bash', [path.join(d, 'deploy.sh'), 'someprofile'], { cwd: d, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: path.join(d, 'nohome'), LC_ALL: 'C', AI_PRISM_ALLOW_UNTRACKED: '1' } })
      assert.notEqual(r.status, 0, `${name} ${kind}`)
      assert.match(r.stderr, new RegExp(`'${name.replace('.', '\\.')}' exists but is not a regular file`))
      assert.equal(existsSync(path.join(bin, 'calls.log')), false, 'no CLI call')
    }
    assert.match(deployPs1, /exists but is not a regular file/)
  })

  test('a fresh clone of this repository passes (.gitignore covers the build outputs and local state)', () => {
    const d = mktmp('ai-prism-clone-')
    const c = spawnSync('git', ['clone', '-q', '--no-hardlinks', ROOT, path.join(d, 'c')], { encoding: 'utf8' })
    if (c.status !== 0) return
    const r = checkSh(path.join(d, 'c'))
    assert.equal(r.status, 0, r.stderr)
  })
})
