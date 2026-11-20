import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findStalePaths, trackedMarkdown } from './check-docs-paths.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function withTree(files, fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-paths-'))
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      writeFileSync(path.join(root, rel), text)
    }
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the real docs reference only server files that exist', () => {
  const stale = findStalePaths(REPO, trackedMarkdown(REPO))
  assert.deepEqual(stale, [], stale.map((s) => `${s.file}:${s.line} ${s.path}`).join('\n'))
})

test('a planted missing path fails, with a .ts hint when the module moved', () => {
  withTree({ 'server/real.ts': '', 'docs/a.md': 'See `server/real.js` and [x](server/ghost.js).\n' }, (root) => {
    const stale = findStalePaths(root, ['docs/a.md'])
    assert.deepEqual(stale.map((s) => [s.path, s.hint, s.line]), [['server/real.js', 'server/real.ts', 1], ['server/ghost.js', null, 1]])
  })
})

test('existing .js files, nested paths and test files pass', () => {
  withTree({ 'server/a.js': '', 'server/mw/b.test.js': '', 'docs/a.md': '`server/a.js` `server/mw/b.test.js`\n' }, (root) => {
    assert.deepEqual(findStalePaths(root, ['docs/a.md']), [])
  })
})

test('exemptions: changelog history, the foo placeholder, and package import paths', () => {
  withTree({
    'CHANGELOG.md': '`server/gone.js`\n',
    'changelog.d/x.md': '`server/gone.js`\n',
    'docs/a.md': '`server/foo.js` `server/foo.test.js` `@modelcontextprotocol/sdk/server/mcp.js`\n',
  }, (root) => {
    assert.deepEqual(findStalePaths(root, ['CHANGELOG.md', 'changelog.d/x.md', 'docs/a.md']), [])
  })
})

test('CLI exits 1 on a stale path and 0 on a clean tree', () => {
  const src = path.join(REPO, 'scripts/check-docs-paths.mjs')
  const exit = (script, cwd) => {
    try { execFileSync('node', [script], { cwd, stdio: 'pipe' }); return 0 } catch (e) { return e.status }
  }
  // The CLI resolves the repo from its own location, so copy it into the planted tree.
  withTree({ 'docs/a.md': '`server/ghost.js`\n' }, (root) => {
    mkdirSync(path.join(root, 'scripts'))
    const copy = path.join(root, 'scripts/check-docs-paths.mjs')
    writeFileSync(copy, readFileSync(src, 'utf8'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    assert.equal(exit(copy, root), 1)
    writeFileSync(path.join(root, 'docs/a.md'), 'clean\n')
    assert.equal(exit(copy, root), 0)
  })
  assert.equal(exit(src, REPO), 0)
})
