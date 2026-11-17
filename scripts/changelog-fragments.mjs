#!/usr/bin/env node
// Changelog fragments: every PR adds `changelog.d/<id>.md` instead of editing
// CHANGELOG.md, so parallel PRs never conflict on the same lines. At release
// time `release` folds every fragment (plus whatever is already under
// "## [Unreleased]") into one dated version section. See changelog.d/README.md.
//
//   node scripts/changelog-fragments.mjs check --base <sha> --head <sha>   # CI gate
//   node scripts/changelog-fragments.mjs check --files a.js,changelog.d/x.md
//   node scripts/changelog-fragments.mjs release 1.5.0 [--date YYYY-MM-DD] [--dry-run]
//   node scripts/changelog-fragments.mjs list
//
// Exit codes: 0 ok · 1 gate failed / invalid fragment · 2 usage error.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FRAGMENT_DIR = 'changelog.d'
// Keep a Changelog sections, in the order a release prints them, plus the two
// extra headings this repository already uses.
export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Performance', 'Deploy notes']
const SECTION_ALIASES = { 'Notas de deploy': 'Deploy notes' }

const canonicalSection = (name) => SECTION_ALIASES[name] || name

/** `### Section` blocks of a fragment (or of a changelog version body). */
export function parseFragment(text) {
  const sections = []
  let current = null
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const h = /^###\s+(.+?)\s*$/.exec(line)
    if (h) {
      current = { name: h[1], lines: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return sections.map((s) => ({ name: s.name, body: s.lines.join('\n').trim() }))
}

/** Problems with a fragment; an empty array means it is valid. */
export function validateFragment(text) {
  const sections = parseFragment(text)
  if (!sections.length) return ['no "### <Section>" heading (use one of: ' + SECTIONS.join(', ') + ')']
  const errors = []
  for (const s of sections) {
    if (!SECTIONS.includes(canonicalSection(s.name))) errors.push(`unknown section "${s.name}" (use one of: ${SECTIONS.join(', ')})`)
    else if (!s.body) errors.push(`section "${s.name}" is empty`)
  }
  return errors
}

const isFragment = (f) => f.startsWith(`${FRAGMENT_DIR}/`) && f.endsWith('.md') && path.basename(f) !== 'README.md'

/**
 * CI gate. `changedFiles` are repo-relative paths added/modified by the PR;
 * `readFile(path)` returns a fragment's text. A CHANGELOG.md edit still passes
 * (release PRs and hotfixes edit it directly).
 */
export function gateDecision(changedFiles, readFile) {
  const fragments = changedFiles.filter(isFragment)
  if (changedFiles.includes('CHANGELOG.md') && !fragments.length) return { ok: true, errors: [], fragments }
  if (!fragments.length) {
    return {
      ok: false,
      errors: [`no changelog fragment: add ${FRAGMENT_DIR}/<task-or-branch>.md (see ${FRAGMENT_DIR}/README.md) or apply the "skip-changelog" label`],
      fragments,
    }
  }
  const errors = []
  for (const f of fragments) for (const e of validateFragment(readFile(f) ?? '')) errors.push(`${f}: ${e}`)
  return { ok: errors.length === 0, errors, fragments }
}

const VERSION_RE = /^## \[(?!Unreleased\])/m

/**
 * Returns the new CHANGELOG.md text: the "## [Unreleased]" body (minus its
 * HTML comment) and every fragment are merged per section into
 * "## [<version>] - <date>", Unreleased is left with only its comment, and the
 * compare links at the bottom are updated.
 */
export function foldRelease(changelog, fragments, { version, date }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error(`invalid version "${version}" (expected X.Y.Z)`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`invalid date "${date}" (expected YYYY-MM-DD)`)
  const text = String(changelog).replace(/\r\n/g, '\n')
  if (text.includes(`## [${version}]`)) throw new Error(`version ${version} is already in CHANGELOG.md`)

  const unrelStart = text.indexOf('## [Unreleased]')
  if (unrelStart < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  const headerEnd = text.indexOf('\n', unrelStart) + 1
  const rest = text.slice(headerEnd)
  const nextVersion = rest.search(VERSION_RE)
  const linksAt = rest.search(/^\[Unreleased\]:/m)
  const bodyEnd = nextVersion >= 0 ? nextVersion : linksAt >= 0 ? linksAt : rest.length
  const unreleasedBody = rest.slice(0, bodyEnd)
  const tail = rest.slice(bodyEnd)

  const comments = (unreleasedBody.match(/<!--[\s\S]*?-->/g) || []).join('\n')
  const merged = new Map()
  const order = []
  const add = (name, body) => {
    const key = canonicalSection(name)
    if (!body) return
    if (!merged.has(key)) {
      merged.set(key, [])
      order.push(key)
    }
    merged.get(key).push(body)
  }
  for (const s of parseFragment(unreleasedBody.replace(/<!--[\s\S]*?-->/g, ''))) add(s.name, s.body)
  for (const f of fragments) {
    const errors = validateFragment(f.text)
    if (errors.length) throw new Error(`${f.file}: ${errors.join('; ')}`)
    for (const s of parseFragment(f.text)) add(s.name, s.body)
  }
  if (!order.length) throw new Error('nothing to release: no fragments and an empty [Unreleased] section')

  const known = SECTIONS.filter((s) => merged.has(s))
  const unknown = order.filter((s) => !SECTIONS.includes(s))
  const sectionText = [...known, ...unknown].map((s) => `### ${s}\n\n${merged.get(s).join('\n')}\n`).join('\n')

  const prevMatch = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(tail)
  const prev = prevMatch ? prevMatch[1] : null
  let newTail = tail
  const unrelLink = /^\[Unreleased\]: (.+?)\/compare\/\S+\.\.\.HEAD$/m
  const m = unrelLink.exec(newTail)
  if (m) {
    const repo = m[1]
    const versionLink = prev ? `[${version}]: ${repo}/compare/v${prev}...v${version}` : `[${version}]: ${repo}/releases/tag/v${version}`
    newTail = newTail.replace(m[0], `[Unreleased]: ${repo}/compare/v${version}...HEAD\n${versionLink}`)
  }

  const head = text.slice(0, headerEnd)
  const unreleased = comments ? `\n${comments}\n\n` : '\n'
  const versionBlock = `## [${version}] - ${date}\n\n${sectionText}\n`
  return `${head}${unreleased}${versionBlock}${newTail}`
}

// ---------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (['--base', '--head', '--files', '--date', '--root'].includes(a)) out[a.slice(2)] = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else out._.push(a)
  }
  return out
}

function listFragments(root) {
  const dir = path.join(root, FRAGMENT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => ({ file: `${FRAGMENT_DIR}/${f}`, text: readFileSync(path.join(dir, f), 'utf8') }))
}

const USAGE = `Usage:
  changelog-fragments.mjs check (--base <sha> --head <sha> | --files a,b,c) [--root <dir>]
  changelog-fragments.mjs release <X.Y.Z> [--date YYYY-MM-DD] [--dry-run] [--root <dir>]
  changelog-fragments.mjs list [--root <dir>]
`

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`)
    return 2
  }
  const [cmd, arg] = args._
  if (args.help || !cmd) {
    process.stdout.write(USAGE)
    return args.help ? 0 : 2
  }
  const root = path.resolve(args.root || process.cwd())

  if (cmd === 'check') {
    let files
    if (args.files != null) files = args.files.split(',').map((s) => s.trim()).filter(Boolean)
    else if (args.base && args.head) {
      // added/modified/renamed only: deleting a fragment (a release) is not an entry
      files = execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${args.base}...${args.head}`], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } else {
      process.stderr.write(`check needs --base and --head, or --files\n\n${USAGE}`)
      return 2
    }
    const read = (f) => {
      try {
        return readFileSync(path.join(root, f), 'utf8')
      } catch {
        return null
      }
    }
    const d = gateDecision(files, read)
    if (!d.ok) {
      for (const e of d.errors) process.stderr.write(`::error::${e}\n`)
      return 1
    }
    process.stdout.write(d.fragments.length ? `changelog fragment(s) ok: ${d.fragments.join(', ')}\n` : 'CHANGELOG.md edited directly.\n')
    return 0
  }

  if (cmd === 'list') {
    for (const f of listFragments(root)) {
      const errors = validateFragment(f.text)
      process.stdout.write(`${f.file}${errors.length ? `  INVALID: ${errors.join('; ')}` : ''}\n`)
    }
    return 0
  }

  if (cmd === 'release') {
    const date = args.date || new Date().toISOString().slice(0, 10)
    const clPath = path.join(root, 'CHANGELOG.md')
    const fragments = listFragments(root)
    let next
    try {
      next = foldRelease(readFileSync(clPath, 'utf8'), fragments, { version: arg, date })
    } catch (e) {
      process.stderr.write(`${e.message}\n`)
      return 1
    }
    if (args.dryRun) {
      process.stdout.write(next)
      return 0
    }
    writeFileSync(clPath, next)
    for (const f of fragments) unlinkSync(path.join(root, f.file))
    process.stdout.write(`CHANGELOG.md: released ${arg} (${date}) from ${fragments.length} fragment(s).\n`)
    return 0
  }

  process.stderr.write(`unknown command ${cmd}\n\n${USAGE}`)
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
