#!/usr/bin/env node
// Docs i18n guard. English is canonical; translations mirror it under
// docs/<locale>/ (README.<locale>.md at the root). The manifest is
// docs/i18n.json. Each translation starts with a marker on line 1:
//
//   <!-- i18n: source=docs/operations.md source-hash=<git blob sha> status=current -->
//
// status: current (in sync with that English blob) · outdated (English moved
// on, acknowledged) · machine (machine translation awaiting native review) ·
// stub (short placeholder). outdated/machine carry a visible banner.
//
//   node scripts/check-docs-i18n.mjs               # check, plain output
//   node scripts/check-docs-i18n.mjs --ci          # check, GitHub annotations
//   node scripts/check-docs-i18n.mjs --ci --strict # release: no allowMissing, no drift, no stubs
//   node scripts/check-docs-i18n.mjs --report      # regenerate docs/i18n-status.md
//   node scripts/check-docs-i18n.mjs --glossary    # regenerate docs/glossary.md from the UI catalogs
//   node scripts/check-docs-i18n.mjs --stamp docs/pt-BR/operations.md [--status outdated]
//   node scripts/check-docs-i18n.mjs --hash-terms <file outside the repo>   # salted entries, one term per line
//
// Prohibited names: docs/i18n.json "prohibited" holds a salt and, per name, the
// salted SHA-256 of the name with case, accents, spaces, hyphens and
// underscores removed (plus its length), so the repository never spells the
// names. DOCS_PROHIBITED_TERMS (comma or newline separated, e.g. from a CI
// secret) adds plain-text terms at run time. Every tracked text file (and every
// untracked, non-ignored one) and every file path is scanned; a match may span
// spaces, punctuation and line breaks; the error never prints the term. With
// --ci an empty list fails: the scan cannot be silently off.
//
// The staleness check hashes the current English file (same value as
// `git hash-object`), so it needs no git history and works on shallow clones.
// Zero dependencies on purpose: CI runs it before `npm ci`.
//
// Exit codes: 0 ok · 1 check failed · 2 usage error.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MANIFEST_PATH = 'docs/i18n.json'
export const STATUSES = ['current', 'outdated', 'machine', 'stub']
const DEFAULT_STATUS_FILE = 'docs/i18n-status.md'
const WALK_SKIP = new Set(['node_modules', 'client/dist', 'server-dist'])
const CODE_TRANSLATED = '<!-- i18n: code-translated en=<sha256-12> -->'
const CODE_TRANSLATED_RE = /^<!-- i18n: code-translated(?: en=([0-9a-f]{12}))? -->$/

/** First 12 hex chars of the sha256 of an English code block body (line endings normalized). */
export function codeBlockHash(body) {
  return createHash('sha256').update(String(body).replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
}
const translatedMarker = (prev) => {
  const m = CODE_TRANSLATED_RE.exec(prev)
  return m ? { hash: m[1] || '' } : null
}

// ---------------------------------------------------------------- primitives

const toPosix = (p) => p.split(path.sep).join('/')
const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8')
const exists = (root, rel) => existsSync(path.join(root, rel))

/** Same value as `git hash-object <file>` (sha1 of "blob <len>\0<bytes>"). */
export function gitBlobHash(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

/** GitHub's heading anchor (github-slugger rules, without the duplicate suffix). */
export function slugify(heading) {
  const text = String(heading)
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
}

/** Glob with `*` (one path segment) and `**` (any depth). */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
const matchesAny = (rel, globs = []) => globs.some((g) => globToRegExp(g).test(rel))

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)?.*$/
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
const EXPLICIT_ANCHOR_RE = /<a\s+(?:name|id)=["']([^"']+)["']/gi

/**
 * Structure of a markdown file: headings (H1..H6 with slugs, duplicates get
 * -1, -2 like GitHub), fenced code blocks, tables and links, all outside fences.
 */
export function scanMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const headings = []
  const codeBlocks = []
  const links = []
  const slugs = new Set()
  const slugCount = new Map()
  const prose = []
  let tables = 0
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      const t = line.trim()
      if (t.startsWith(fence.marker[0].repeat(fence.marker.length)) && /^(`+|~+)$/.test(t)) {
        codeBlocks.push({ lang: fence.lang, line: fence.line, translated: fence.translated, marker: fence.marker2, body: fence.body.join('\n') })
        fence = null
      } else {
        fence.body.push(line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line.trimStart())
      }
      continue
    }
    const f = FENCE_RE.exec(line)
    if (f) {
      const prev = i > 0 ? lines[i - 1].trim() : ''
      fence = { marker: f[2], indent: f[1], lang: (f[3] || '').toLowerCase(), line: i + 1, body: [], translated: !!translatedMarker(prev), marker2: translatedMarker(prev) }
      continue
    }
    prose.push({ text: line, line: i + 1 })
    const h = HEADING_RE.exec(line)
    if (h) {
      const base = slugify(h[2])
      const n = slugCount.get(base) || 0
      slugCount.set(base, n + 1)
      const slug = n === 0 ? base : `${base}-${n}`
      slugs.add(slug)
      headings.push({ level: h[1].length, text: h[2], line: i + 1, slug })
    }
    if (TABLE_DELIM_RE.test(line) && i > 0 && lines[i - 1].includes('|')) tables++
    for (const m of line.matchAll(EXPLICIT_ANCHOR_RE)) slugs.add(m[1].toLowerCase())
    for (const target of linkTargets(line)) links.push({ target, line: i + 1 })
  }
  if (fence) codeBlocks.push({ lang: fence.lang, line: fence.line, translated: fence.translated, marker: fence.marker2, body: fence.body.join('\n'), unclosed: true })
  const headingCounts = [1, 2, 3, 4].map((lvl) => headings.filter((x) => x.level === lvl).length)
  return { headings, headingCounts, codeBlocks, tables, links, slugs, lines, prose }
}

/** Link targets of one line, ignoring inline code spans. */
function linkTargets(line) {
  const clean = line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length))
  const out = []
  // [text](target "title") and ![alt](target); nested brackets one level deep
  for (const m of clean.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^)]*["'])?\s*\)/g)) {
    out.push(m[1].replace(/^<|>$/g, ''))
  }
  const ref = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(clean)
  if (ref) out.push(ref[1].replace(/^<|>$/g, ''))
  return out
}

const HASH_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'yaml', 'yml', 'toml', 'ini', 'python', 'py', 'ps1', 'powershell', 'pwsh', 'env', 'dotenv', 'dockerfile', 'makefile', 'conf', 'properties', 'r', 'ruby', 'perl', 'gitignore'])
const SLASH_LANGS = new Set(['js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript', 'jsx', 'tsx', 'json', 'jsonc', 'json5', 'c', 'cpp', 'java', 'go', 'rust', 'css', 'scss', 'kotlin', 'scala', 'swift'])
const SQL_LANGS = new Set(['sql', 'pgsql', 'postgres', 'postgresql', 'plpgsql'])
const HTML_LANGS = new Set(['html', 'xml', 'md', 'markdown', 'svg'])

/**
 * Code with comments removed, for the "identical except comments" check.
 * Only comments go: whole comment lines, trailing comments (with the spaces
 * before them) and block comments. Blank lines, indentation and trailing
 * whitespace on code lines are kept, so they must match byte for byte.
 */
export function normalizeCode(lang, body) {
  const l = String(lang || '').toLowerCase()
  const known = HASH_LANGS.has(l) || SLASH_LANGS.has(l) || SQL_LANGS.has(l) || HTML_LANGS.has(l)
  const hash = HASH_LANGS.has(l) || !known
  const slash = SLASH_LANGS.has(l) || !known
  const sql = SQL_LANGS.has(l)
  const DROP = '\u0000'
  const dropAll = (m) => m.split('\n').map(() => DROP).join('\n')
  let text = String(body).replace(/\r\n/g, '\n')
  if (HTML_LANGS.has(l) || !known) text = text.replace(/<!--[\s\S]*?-->/g, dropAll)
  if (slash) text = text.replace(/\/\*[\s\S]*?\*\//g, dropAll)
  const out = []
  for (const raw of text.split('\n')) {
    const hadDrop = raw.includes(DROP)
    const line = raw.split(DROP).join('')
    const t = line.trim()
    if (hadDrop && !t) continue
    if (t && hash && t.startsWith('#')) continue
    if (t && slash && t.startsWith('//')) continue
    if (t && sql && t.startsWith('--')) continue
    let code = line
    if (hash) code = code.replace(/\s+#\s.*$/, '').replace(/\s+#$/, '')
    if (slash) code = code.replace(/\s+\/\/(\s.*)?$/, '')
    if (sql) code = code.replace(/\s+--(\s.*)?$/, '')
    if (code !== line || hadDrop) code = code.replace(/\s+$/, '')
    out.push(code)
  }
  return out.join('\n')
}

const MARKER_RE = /^<!--\s*i18n:\s*(.*?)\s*-->\s*$/

/** `{ source, hash, status }` from the marker on line 1, or null. */
export function parseMarker(text) {
  const first = String(text).split('\n', 1)[0]
  const m = MARKER_RE.exec(first)
  if (!m) return null
  const kv = {}
  for (const part of m[1].split(/\s+/)) {
    const eq = part.indexOf('=')
    if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1)
  }
  if (!kv.source) return null
  return { source: kv.source, hash: kv['source-hash'] || '', status: kv.status || '' }
}

export const formatMarker = ({ source, hash, status }) => `<!-- i18n: source=${source} source-hash=${hash} status=${status} -->`

// ---------------------------------------------------------------- manifest + plan

export function loadManifest(root) {
  const file = path.join(root, MANIFEST_PATH)
  if (!existsSync(file)) throw new Error(`${MANIFEST_PATH} not found under ${root}`)
  const m = JSON.parse(readFileSync(file, 'utf8'))
  m.sourceLocale ||= 'en'
  m.names ||= {}
  m.locales ||= []
  m.allowMissing ||= {}
  m.paths ||= {}
  return m
}

function walkMarkdown(root) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.name.startsWith('.') || WALK_SKIP.has(e.name) || WALK_SKIP.has(child)) continue
      if (e.isDirectory()) walk(child)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(child)
    }
  }
  walk('')
  return out.sort()
}

/** Where `source` lives in `locale`. */
export function targetPath(manifest, source, locale) {
  const override = manifest.paths[source]
  if (typeof override === 'string') return override.replaceAll('{locale}', locale)
  if (override && (override[locale] || override['*'])) return (override[locale] || override['*']).replaceAll('{locale}', locale)
  const rel = source.startsWith('docs/') ? source.slice('docs/'.length) : source
  return `docs/${locale}/${rel}`
}

/** Every English source with its expected translation per locale. */
export function plan(root, manifest = loadManifest(root)) {
  const all = walkMarkdown(root)
  const sources = all.filter((f) => matchesAny(f, manifest.sources) && !matchesAny(f, manifest.exclude))
  return sources.map((source) => ({
    source,
    translations: manifest.locales.map((locale) => {
      const target = targetPath(manifest, source, locale)
      return { locale, target, exists: exists(root, target), allowMissing: matchesAny(source, manifest.allowMissing[locale]) }
    }),
  }))
}

// ---------------------------------------------------------------- prohibited names

const SCAN_SKIP_RE = /(^|\/)node_modules\//
const MAX_SCAN_BYTES = 32 * 1024 * 1024

/** Lowercase ASCII words: accents, case and punctuation do not matter. */
export function termWords(text) {
  return String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}
const saltedHash = (salt, s) => createHash('sha256').update(`${salt}\n${s}`).digest('hex')

/**
 * Manifest entry for a prohibited name: the salted hash of its letters and
 * digits with every separator removed ("A-b_c d" -> "abcd") and that length.
 * Spacing, hyphen, underscore, case and accent variants share one entry.
 */
export function hashTerm(term, salt) {
  if (typeof salt !== 'string' || !salt) throw new Error('prohibited.salt is required')
  const joined = termWords(term).join('')
  if (!joined) throw new Error('empty term')
  return { length: joined.length, sha256: saltedHash(salt, joined) }
}

/** Terms from a private file: one per line, blank lines and `#` comments skipped. */
export function readTermsFile(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

/** Every tracked file plus untracked, non-ignored ones (git), else a walk. */
function repoFiles(root) {
  let tracked = null
  let untracked = []
  if (existsSync(path.join(root, '.git'))) {
    try {
      const ls = (...a) => execFileSync('git', ['ls-files', '-z', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
      tracked = ls('--cached')
      // untracked dot directories hold local state (other worktrees, editor and agent caches)
      untracked = ls('--others', '--exclude-standard').filter((f) => !/^\.(?!github\/)[^/]+\//.test(f))
    } catch {
      tracked = null
    }
  }
  if (!tracked) {
    tracked = []
    const walk = (rel) => {
      let entries
      try {
        entries = readdirSync(path.join(root, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.name === '.git' || e.name === 'node_modules' || (e.isDirectory() && e.name.startsWith('.') && e.name !== '.github')) continue
        if (e.isDirectory()) walk(child)
        else if (e.isFile()) tracked.push(child)
      }
    }
    walk('')
  }
  return [...new Set([...tracked, ...untracked])].filter((f) => !SCAN_SKIP_RE.test(f)).sort()
}

/** Text content of a file, or null for binaries (a NUL byte in the first 8 KB). */
function readText(abs) {
  let st
  try {
    st = statSync(abs)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_SCAN_BYTES) return null
  const buf = readFileSync(abs)
  if (buf.subarray(0, 8192).includes(0)) return null
  return buf.toString('utf8')
}

/** Matcher over a word stream: finds a run of consecutive words whose concatenation hashes to an entry. */
function prohibitedMatcher(manifest, extraTerms = []) {
  const salt = manifest.prohibited?.salt || 'env'
  const byLength = new Map()
  const add = (e, id) => {
    if (!byLength.has(e.length)) byLength.set(e.length, new Map())
    byLength.get(e.length).set(e.sha256, id)
  }
  const configured = manifest.prohibited?.salt ? manifest.prohibited.terms || [] : []
  configured.forEach((e, i) => add(e, i + 1))
  extraTerms.map((t) => String(t).trim()).filter(Boolean).forEach((t, i) => add(hashTerm(t, salt), `env ${i + 1}`))
  if (!byLength.size) return null
  return (words) => {
    for (const [len, hashes] of byLength) {
      for (let i = 0; i < words.length; i++) {
        let joined = ''
        for (let j = i; j < words.length && joined.length < len; j++) {
          joined += words[j]
          if (joined.length === len) {
            const id = hashes.get(saltedHash(salt, joined))
            if (id != null) return { index: i, id }
          }
        }
      }
    }
    return null
  }
}

function checkProhibited(root, manifest, { extraTerms = [], require = false } = {}, err, warn) {
  const match = prohibitedMatcher(manifest, extraTerms)
  if (!match) {
    const msg = 'no prohibited names configured (docs/i18n.json "prohibited.salt" + "prohibited.terms", or DOCS_PROHIBITED_TERMS); the name scan cannot run'
    if (require) err(MANIFEST_PATH, 1, `${msg}; add the salted entries with --hash-terms <file>`)
    else warn(MANIFEST_PATH, 1, msg)
    return
  }
  const hint = 'remove it (the guard never prints the term)'
  for (const file of repoFiles(root)) {
    const p = match(termWords(file))
    if (p) err(file, 1, `prohibited name in the file path (entry ${p.id}); ${hint}`)
    const text = readText(path.join(root, file))
    if (text == null) continue
    const words = []
    const lineOf = []
    text.split('\n').forEach((l, i) => {
      for (const w of termWords(l)) {
        words.push(w)
        lineOf.push(i + 1)
      }
    })
    const m = match(words)
    if (m) err(file, lineOf[m.index], `prohibited name (entry ${m.id}); ${hint}`)
  }
}

// ---------------------------------------------------------------- Node.js claims

const NODE_CLAIM_RE = /\bNode(?:\.js)?\s*(?:(?:>=|≥)\s*v?(\d+)(?:\.(\d+))?(?:\.\d+)?|v?(\d+)(?:\.(\d+))?(?:\.\d+)?\s*\+)/g

/** Floor from package.json "engines.node" (">=22.18.0" -> 22.18), or null. */
function enginesNode(root) {
  try {
    const engines = JSON.parse(read(root, 'package.json')).engines?.node
    const m = /(\d+)(?:\.(\d+))?/.exec(engines || '')
    return m ? { range: engines, major: Number(m[1]), minor: Number(m[2] || 0) } : null
  } catch {
    return null
  }
}

/**
 * True when a prose claim is below the floor. A bare major ("Node 22+") is
 * compared on the major only; a claim that names a minor is compared on both.
 */
function claimBelowFloor(major, minor, floor) {
  if (major !== floor.major) return major < floor.major
  return minor != null && minor < floor.minor
}

// ---------------------------------------------------------------- checks

/** Resolve a relative link from `fromFile`; null for external/absolute links. */
function resolveLink(fromFile, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/')) return null
  const hashAt = target.indexOf('#')
  const rawPath = hashAt >= 0 ? target.slice(0, hashAt) : target
  const anchor = hashAt >= 0 ? target.slice(hashAt + 1) : null
  let decodedPath = rawPath
  let decodedAnchor = anchor
  try {
    decodedPath = decodeURIComponent(rawPath)
    if (anchor != null) decodedAnchor = decodeURIComponent(anchor)
  } catch {}
  const file = decodedPath ? toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decodedPath.split('?')[0]))) : fromFile
  return { file, anchor: decodedAnchor }
}

export function checkDocs(root, { strict = false, prohibitedTerms = [], requireProhibited = false } = {}) {
  const manifest = loadManifest(root)
  const errors = []
  const warnings = []
  const err = (file, line, message) => errors.push({ file, line, message })
  const warn = (file, line, message) => warnings.push({ file, line, message })
  const name = (loc) => manifest.names[loc] || loc
  const scans = new Map()
  const scan = (rel) => {
    if (!scans.has(rel)) scans.set(rel, scanMarkdown(read(root, rel)))
    return scans.get(rel)
  }
  const pairs = plan(root, manifest)
  const linkFiles = new Set(manifest.linkCheck || [])

  const required = new Set(manifest.required || [])
  for (const { source, translations } of pairs) {
    linkFiles.add(source)
    if (required.has(source)) {
      for (const t of translations) if (!t.exists) err(source, 1, `required document has no ${t.locale} translation (${t.target}); required documents cannot be listed in allowMissing`)
    }
    const enText = readFileSync(path.join(root, source))
    const enHash = gitBlobHash(enText)
    const en = scan(source)
    const group = [{ locale: manifest.sourceLocale, file: source }]
    for (const t of translations) {
      if (!t.exists) {
        if (!t.allowMissing || strict) err(source, 1, `missing ${t.locale} translation ${t.target}${t.allowMissing ? ' (allowMissing, --strict)' : ''}`)
        continue
      }
      group.push({ locale: t.locale, file: t.target })
      linkFiles.add(t.target)
      const text = read(root, t.target)
      const tr = scan(t.target)
      const marker = parseMarker(text)
      if (!marker) {
        err(t.target, 1, `no i18n marker on line 1 (run: node scripts/check-docs-i18n.mjs --stamp ${t.target})`)
        continue
      }
      if (marker.source !== source) err(t.target, 1, `marker source ${marker.source}, expected ${source}`)
      if (!STATUSES.includes(marker.status)) err(t.target, 1, `unknown status "${marker.status}" (use ${STATUSES.join('|')})`)
      if (marker.hash !== enHash) {
        const msg = `English source changed since this translation was synced (marker ${marker.hash.slice(0, 10) || '∅'}, ${source} is ${enHash.slice(0, 10)})`
        if (marker.status === 'current' || strict) err(t.target, 1, `${msg}; update the translation and run --stamp ${t.target}, or stamp it --status outdated`)
        else warn(t.target, 1, `${msg}; flagged ${marker.status}`)
      }
      if (marker.status === 'stub') {
        if (strict) err(t.target, 1, 'status=stub is not allowed with --strict')
        continue
      }
      if (marker.status === 'outdated' || marker.status === 'machine') {
        const banner = tr.lines.slice(0, 15).some((l) => l.trimStart().startsWith('>') && linkTargets(l).some((x) => resolveLink(t.target, x)?.file === source))
        if (!banner) err(t.target, 1, `status=${marker.status} needs a banner: a "> ..." line near the top linking to ${source}`)
      }
      // structure parity
      for (let lvl = 1; lvl <= 4; lvl++) {
        const a = en.headingCounts[lvl - 1]
        const b = tr.headingCounts[lvl - 1]
        if (a !== b) err(t.target, 1, `H${lvl} headings: ${name(manifest.sourceLocale)} ${a}, ${t.locale} ${b}`)
      }
      if (en.tables !== tr.tables) err(t.target, 1, `tables: ${name(manifest.sourceLocale)} ${en.tables}, ${t.locale} ${tr.tables}`)
      if (en.codeBlocks.length !== tr.codeBlocks.length) {
        err(t.target, 1, `code blocks: ${name(manifest.sourceLocale)} ${en.codeBlocks.length}, ${t.locale} ${tr.codeBlocks.length}`)
      } else {
        en.codeBlocks.forEach((cb, i) => {
          const other = tr.codeBlocks[i]
          if (cb.translated || other.translated) {
            // The marker must be on every language copy of the block and carry the
            // hash of the English block, so it cannot outlive the English code nor
            // let one marked copy waive an unmarked, different one.
            const want = codeBlockHash(cb.body)
            for (const [blk, file, label] of [[cb, source, 'English'], [other, t.target, t.locale]]) {
              if (!blk.translated) {
                err(file, blk.line, `code block ${i + 1} (${label} copy) has no code-translated marker, but the other language copy does; put <!-- i18n: code-translated en=${want} --> above it in every language, or keep the blocks identical`)
                continue
              }
              const got = blk.marker?.hash || ''
              if (got !== want) err(file, blk.line, `code-translated marker on code block ${i + 1} ${got ? `has en=${got}` : 'has no en=<hash>'}; the English block hashes to ${want} (${label} copy): update it to <!-- i18n: code-translated en=${want} -->`)
            }
            return
          }
          if (normalizeCode(cb.lang, cb.body) !== normalizeCode(other.lang, other.body) || cb.lang !== other.lang) {
            err(t.target, other.line, `code block ${i + 1} differs from English (${source}:${cb.line}); only comments may be translated, or mark both with ${CODE_TRANSLATED}`)
          }
        })
      }
    }
    // language switcher: the first non-empty line after the H1
    if (group.length > 1) {
      for (const member of group) {
        const s = scan(member.file)
        const h1 = s.headings.find((h) => h.level === 1)
        const line = h1 ? s.lines.slice(h1.line).find((l) => l.trim()) || '' : ''
        const lineNo = h1 ? h1.line + 1 + s.lines.slice(h1.line).findIndex((l) => l.trim()) : 1
        const problems = []
        if (!line.includes(`**${name(member.locale)}**`)) problems.push(`**${name(member.locale)}** (current, bold)`)
        const targets = linkTargets(line).map((x) => resolveLink(member.file, x)?.file)
        for (const other of group) {
          if (other === member) continue
          const label = `[${name(other.locale)}](`
          if (!line.includes(label) || !targets.includes(other.file)) problems.push(`[${name(other.locale)}](→ ${other.file})`)
        }
        if (problems.length) err(member.file, lineNo, `language switcher (first line after the H1) must have ${problems.join(', ')}`)
      }
    }
  }

  // links and anchors
  for (const file of [...linkFiles].sort()) {
    if (!exists(root, file)) continue
    for (const { target, line } of scan(file).links) {
      const r = resolveLink(file, target)
      if (!r) continue
      const abs = path.join(root, r.file)
      if (!existsSync(abs)) {
        err(file, line, `broken link ${target} (${r.file} does not exist)`)
        continue
      }
      if (r.anchor && r.file.endsWith('.md') && statSync(abs).isFile()) {
        const want = r.anchor.toLowerCase()
        if (!scan(r.file).slugs.has(want)) err(file, line, `broken anchor #${r.anchor} in ${r.file}`)
      }
    }
  }

  for (const r of required) if (!pairs.some((p) => p.source === r)) err(MANIFEST_PATH, 1, `required document ${r} is not an English source`)

  // Node.js claims in prose must not be below package.json engines
  const engines = enginesNode(root)
  if (engines) {
    for (const file of [...linkFiles].sort()) {
      if (!exists(root, file)) continue
      for (const { text, line } of scan(file).prose) {
        for (const m of text.matchAll(NODE_CLAIM_RE)) {
          const major = Number(m[1] ?? m[3])
          const minorText = m[1] != null ? m[2] : m[4]
          const minor = minorText != null ? Number(minorText) : null
          if (claimBelowFloor(major, minor, engines)) err(file, line, `says Node.js ${minor != null ? `${major}.${minor}` : major}, but package.json engines requires ${engines.range}`)
        }
      }
    }
  }

  checkProhibited(root, manifest, { extraTerms: prohibitedTerms, require: requireProhibited }, err, warn)

  // generated status table
  if (manifest.status) {
    if (!exists(root, manifest.status)) err(manifest.status, 1, `${manifest.status} is missing; run node scripts/check-docs-i18n.mjs --report`)
    else if (read(root, manifest.status) !== renderStatus(root, manifest)) err(manifest.status, 1, `${manifest.status} is out of date; run node scripts/check-docs-i18n.mjs --report`)
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------- generated files

/** docs/i18n-status.md: one row per English source, one column per locale. */
export function renderStatus(root, manifest = loadManifest(root)) {
  const statusFile = manifest.status || DEFAULT_STATUS_FILE
  const dir = path.posix.dirname(statusFile)
  const rel = (to) => path.posix.relative(dir, to)
  const name = (loc) => manifest.names[loc] || loc
  const notes = manifest.notes || {}
  const rows = plan(root, manifest).map(({ source, translations }) => {
    const enHash = gitBlobHash(readFileSync(path.join(root, source)))
    const cells = translations.map((t) => {
      if (!t.exists) return t.allowMissing ? 'missing (planned)' : '**missing**'
      const marker = parseMarker(read(root, t.target))
      if (!marker) return `[no marker](${rel(t.target)})`
      const drift = marker.hash !== enHash ? ' (English changed)' : ''
      return `[${marker.status}](${rel(t.target)})${drift}`
    })
    return `| \`${source}\` | \`${enHash.slice(0, 7)}\` | ${cells.join(' | ')} | ${notes[source] || ''} |`
  })
  return [
    '<!-- Generated by `node scripts/check-docs-i18n.mjs --report`. Do not edit by hand. -->',
    '# Translation status',
    '',
    `English is the canonical language. Translations live under \`docs/<locale>/\` (the root README under \`README.<locale>.md\`).`,
    'Each translation records the English blob it was synced from; this table is regenerated from those markers.',
    '',
    `- **current**: in sync with the English blob shown. **outdated**: English changed and the translation is flagged; read the English page for the latest.`,
    `- **machine**: machine-assisted translation waiting for a native review. **stub**: a short placeholder that points to English.`,
    `- **missing (planned)**: listed in \`allowMissing\` in [i18n.json](${rel(MANIFEST_PATH)}); translated in a later phase.`,
    '',
    `How to translate or update a page: [docs/README.md](${rel('docs/README.md')}#translations).`,
    '',
    `| English source | English blob | ${manifest.locales.map(name).join(' | ')} | Note |`,
    `|---|---|${manifest.locales.map(() => '---').join('|')}|---|`,
    ...rows,
    '',
  ].join('\n')
}

const escapeCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** docs/glossary.md from docs/glossary.keys.json + the UI catalogs. */
export async function renderGlossary(root, manifest = loadManifest(root)) {
  const g = manifest.glossary
  if (!g) throw new Error(`${MANIFEST_PATH} has no "glossary" section`)
  const spec = JSON.parse(read(root, g.keys))
  const mod = await import(pathToFileURL(path.join(root, g.catalogs)).href)
  const catalogs = mod.default || mod
  const locales = [manifest.sourceLocale, ...manifest.locales]
  const catalogOf = (loc) => catalogs[g.catalogLocales?.[loc] || loc]
  const missing = []
  const name = (loc) => manifest.names[loc] || loc
  const lines = [
    '<!-- Generated by `node scripts/check-docs-i18n.mjs --glossary` from the UI catalogs and docs/glossary.keys.json. Do not edit by hand. -->',
    '# Glossary · Glossário · Glosario',
    '',
    'The words the app shows, in each language, taken from the UI catalogs (`client/src/lib/locales/`). Docs that quote a screen label use the label of their language from this table.',
    '',
    'As palavras que o app mostra, em cada idioma, extraídas dos catálogos da interface. Uma doc que cita um rótulo de tela usa o rótulo do seu idioma desta tabela.',
    '',
    'Las palabras que muestra la app, en cada idioma, tomadas de los catálogos de la interfaz. Una doc que cita una etiqueta de pantalla usa la etiqueta de su idioma de esta tabla.',
    '',
    `To change a term, change the UI catalog and run \`node scripts/check-docs-i18n.mjs --glossary\`; to add one, add its key to [glossary.keys.json](glossary.keys.json).`,
    '',
  ]
  if (spec.neverTranslate?.length) {
    lines.push('## Never translated · Nunca traduzidos · Nunca se traducen', '')
    lines.push('Product and platform names, and terms the UI keeps in English in every language:', '')
    lines.push(spec.neverTranslate.map((t) => `\`${t}\``).join(' · '), '')
  }
  for (const section of spec.sections || []) {
    lines.push(`## ${section.title}`, '')
    lines.push(`| ${locales.map(name).join(' | ')} | UI key |`, `|${locales.map(() => '---').join('|')}|---|`)
    for (const key of section.keys) {
      const cells = locales.map((loc) => {
        const v = catalogOf(loc)?.[key]
        if (v == null) missing.push(`${key} (${loc})`)
        return escapeCell(v ?? '')
      })
      lines.push(`| ${cells.join(' | ')} | \`${key}\` |`)
    }
    lines.push('')
  }
  if (missing.length) throw new Error(`glossary keys not found in the UI catalogs: ${missing.join(', ')}`)
  return lines.join('\n')
}

/** Rewrite (or insert) the marker of a translation with the current English hash. */
export function stampFile(root, file, status = 'current', manifest = loadManifest(root)) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}" (use ${STATUSES.join('|')})`)
  const rel = toPosix(path.relative(root, path.resolve(root, file)))
  const text = read(root, rel)
  const marker = parseMarker(text)
  let source = marker?.source
  if (!source) {
    for (const { source: s, translations } of plan(root, manifest)) if (translations.some((t) => t.target === rel)) source = s
  }
  if (!source) throw new Error(`${rel}: not a translation listed by ${MANIFEST_PATH}`)
  const hash = gitBlobHash(readFileSync(path.join(root, source)))
  const line = formatMarker({ source, hash, status })
  const next = marker ? text.replace(/^[^\n]*/, line) : `${line}\n${text}`
  writeFileSync(path.join(root, rel), next)
  return { file: rel, source, hash, status }
}

// ---------------------------------------------------------------- CLI

export async function runCli(argv, io = console) {
  const args = [...argv]
  const flag = (f) => {
    const i = args.indexOf(f)
    if (i < 0) return false
    args.splice(i, 1)
    return true
  }
  const option = (f) => {
    const i = args.indexOf(f)
    if (i < 0) return null
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const root = path.resolve(option('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const ci = flag('--ci')
  const strict = flag('--strict')
  const report = flag('--report')
  const glossary = flag('--glossary')
  const stamp = flag('--stamp')
  const status = option('--status') || 'current'
  const termsFile = option('--hash-terms')
  const unknown = args.filter((a) => a.startsWith('--'))
  if (unknown.length) {
    io.error(`unknown option ${unknown.join(' ')}`)
    return 2
  }
  let manifest
  try {
    manifest = loadManifest(root)
  } catch (e) {
    io.error(e.message)
    return 2
  }
  if (termsFile != null) {
    // Prints only salted entries; the terms themselves never reach stdout, stderr or the repo.
    const salt = manifest.prohibited?.salt
    if (!salt) {
      io.error(`${MANIFEST_PATH} needs "prohibited.salt" (a random hex string) before entries can be hashed`)
      return 2
    }
    let terms
    try {
      terms = readTermsFile(termsFile)
    } catch {
      io.error(`cannot read the terms file given to --hash-terms`)
      return 2
    }
    io.log(JSON.stringify(terms.map((t) => hashTerm(t, salt)), null, 2))
    return 0
  }
  if (stamp) {
    if (!args.length) {
      io.error('usage: --stamp <translation.md>... [--status current|outdated|machine|stub]')
      return 2
    }
    try {
      for (const f of args) {
        const r = stampFile(root, f, status, manifest)
        io.log(`stamped ${r.file}: source=${r.source} source-hash=${r.hash.slice(0, 10)} status=${r.status}`)
      }
    } catch (e) {
      io.error(e.message)
      return 2
    }
    if (manifest.status) writeFileSync(path.join(root, manifest.status), renderStatus(root, manifest))
    return 0
  }
  if (report || glossary) {
    if (report) {
      const out = manifest.status || DEFAULT_STATUS_FILE
      writeFileSync(path.join(root, out), renderStatus(root, manifest))
      io.log(`wrote ${out}`)
    }
    if (glossary) {
      try {
        writeFileSync(path.join(root, manifest.glossary.out), await renderGlossary(root, manifest))
        io.log(`wrote ${manifest.glossary.out}`)
      } catch (e) {
        io.error(e.message)
        return 1
      }
    }
    return 0
  }

  const prohibitedTerms = String(process.env.DOCS_PROHIBITED_TERMS || '').split(/[,\n]/)
  const { errors, warnings } = checkDocs(root, { strict, prohibitedTerms, requireProhibited: ci })
  if (manifest.glossary) {
    try {
      const want = await renderGlossary(root, manifest)
      const out = manifest.glossary.out
      if (!exists(root, out) || read(root, out) !== want) errors.push({ file: out, line: 1, message: `${out} is out of date with the UI catalogs; run node scripts/check-docs-i18n.mjs --glossary` })
    } catch (e) {
      errors.push({ file: manifest.glossary.keys, line: 1, message: e.message })
    }
  }
  const emit = (kind, e) => (ci ? `::${kind} file=${e.file},line=${e.line}::${e.message}` : `${kind} ${e.file}:${e.line} ${e.message}`)
  for (const w of warnings) io.log(emit('warning', w))
  for (const e of errors) io.error(emit('error', e))
  const pairs = plan(root, manifest)
  const translated = pairs.reduce((n, p) => n + p.translations.filter((t) => t.exists).length, 0)
  io.log(`docs i18n: ${pairs.length} English sources, ${translated} translations, ${errors.length} errors, ${warnings.length} warnings${strict ? ' (strict)' : ''}`)
  return errors.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
