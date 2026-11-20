#!/usr/bin/env node
// Stale path guard for the docs: every `server/**/*.{js,mjs,cjs}` path that a
// tracked Markdown file mentions must exist. Server modules moved to .ts in
// W3-9a..e; a doc that still says `server/<name>.js` sends readers to a file
// that is gone.
//
//   node scripts/check-docs-paths.mjs
//
// Exempt on purpose: CHANGELOG.md and changelog.d/ (history describes the files
// as they were), `server/foo.*` (the placeholder in CONTRIBUTING's migration
// recipe), and package paths such as `@modelcontextprotocol/sdk/server/mcp.js`
// (the path must start the token, not follow another path segment).
// Exit codes: 0 ok · 1 stale path found.
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXEMPT_FILES = (f) => f === 'CHANGELOG.md' || f.startsWith('changelog.d/')
const PLACEHOLDER = /^server\/foo(\.test)?\.[cm]?js$/
// `server/` must begin the token: not preceded by a path character, `@` or `.`.
const PATH_RE = /(?<![A-Za-z0-9_./@-])server\/[A-Za-z0-9_./-]*?[A-Za-z0-9_-]\.(?:js|mjs|cjs)(?![A-Za-z0-9_])/g

/** Stale references in `files` (repo-relative); `root` is the repo root. */
export function findStalePaths(root, files) {
  const stale = []
  for (const f of files) {
    if (EXEMPT_FILES(f)) continue
    const lines = readFileSync(path.join(root, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PATH_RE)) {
        const p = m[0]
        if (PLACEHOLDER.test(p) || existsSync(path.join(root, p))) continue
        const ts = p.replace(/\.[cm]?js$/, '.ts')
        stale.push({ file: f, line: i + 1, path: p, hint: existsSync(path.join(root, ts)) ? ts : null })
      }
    })
  }
  return stale
}

export function trackedMarkdown(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: root, encoding: 'utf8' })
  return out.split('\0').filter((f) => f && existsSync(path.join(root, f)))
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
  const stale = findStalePaths(root, trackedMarkdown(root))
  for (const s of stale) console.error(`${s.file}:${s.line}: ${s.path} does not exist${s.hint ? ` (did you mean ${s.hint}?)` : ''}`)
  console.log(`docs paths: ${stale.length} stale server path(s)`)
  process.exit(stale.length ? 1 : 0)
}
