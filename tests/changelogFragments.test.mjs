// Tests for scripts/changelog-fragments.mjs: the CI gate (a PR must carry a
// changelog fragment or a CHANGELOG.md edit) and the release fold (fragments
// become one version section in CHANGELOG.md). Run with:
//   node --test tests/changelogFragments.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseFragment,
  validateFragment,
  gateDecision,
  foldRelease,
} from '../scripts/changelog-fragments.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'changelog-fragments.mjs')

const CHANGELOG = `# Changelog

Intro line.

## [Unreleased]

<!-- Add unreleased changes here. -->

### Fixed

- Existing unreleased fix.

## [1.4.0] - 2026-11-03

### Added

- Old feature.

[Unreleased]: https://github.com/o/r/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/o/r/compare/v1.3.0...v1.4.0
`

test('parseFragment groups bullets under their section heading', () => {
  const sections = parseFragment('### Added\n\n- One.\n- Two,\n  continued.\n\n### Fixed\n\n- Three.\n')
  assert.deepEqual(sections, [
    { name: 'Added', body: '- One.\n- Two,\n  continued.' },
    { name: 'Fixed', body: '- Three.' },
  ])
})

test('validateFragment rejects a fragment without any known section', () => {
  assert.match(validateFragment('just text, no heading\n').join(' '), /no "### <Section>" heading/)
  assert.match(validateFragment('### Misc\n\n- x\n').join(' '), /unknown section "Misc"/)
  assert.match(validateFragment('### Added\n\n').join(' '), /section "Added" is empty/)
  assert.deepEqual(validateFragment('### Security\n\n- ok\n'), [])
})

test('gateDecision passes on a valid fragment, on a CHANGELOG.md edit, and fails otherwise', () => {
  const read = (f) => ({ 'changelog.d/W0-5.md': '### Added\n\n- x\n', 'changelog.d/bad.md': 'nothing\n' })[f]
  assert.equal(gateDecision(['server/a.js', 'changelog.d/W0-5.md'], read).ok, true)
  assert.equal(gateDecision(['CHANGELOG.md'], read).ok, true)
  const none = gateDecision(['server/a.js'], read)
  assert.equal(none.ok, false)
  assert.match(none.errors.join(' '), /no changelog fragment/)
  // the README of the folder is documentation, not an entry
  assert.equal(gateDecision(['changelog.d/README.md'], read).ok, false)
  const bad = gateDecision(['changelog.d/bad.md'], read)
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /changelog\.d\/bad\.md/)
})

test('foldRelease moves Unreleased + fragments into a dated version and updates the compare links', () => {
  const out = foldRelease(CHANGELOG, [
    { file: 'changelog.d/a.md', text: '### Added\n\n- From fragment A.\n' },
    { file: 'changelog.d/b.md', text: '### Fixed\n\n- From fragment B.\n\n### Added\n\n- From fragment B too.\n' },
  ], { version: '1.5.0', date: '2026-11-20' })
  const expected = `# Changelog

Intro line.

## [Unreleased]

<!-- Add unreleased changes here. -->

## [1.5.0] - 2026-11-20

### Added

- From fragment A.
- From fragment B too.

### Fixed

- Existing unreleased fix.
- From fragment B.

## [1.4.0] - 2026-11-03

### Added

- Old feature.

[Unreleased]: https://github.com/o/r/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/o/r/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/o/r/compare/v1.3.0...v1.4.0
`
  assert.equal(out, expected)
})

test('foldRelease refuses a version that already exists and an empty release', () => {
  assert.throws(() => foldRelease(CHANGELOG, [], { version: '1.4.0', date: '2026-11-20' }), /already in CHANGELOG/)
  const empty = CHANGELOG.replace('### Fixed\n\n- Existing unreleased fix.\n\n', '')
  assert.throws(() => foldRelease(empty, [], { version: '1.5.0', date: '2026-11-20' }), /nothing to release/)
})

test('CLI release writes CHANGELOG.md and deletes the folded fragments, keeping the README', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cl-frag-'))
  mkdirSync(path.join(dir, 'changelog.d'))
  writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG)
  writeFileSync(path.join(dir, 'changelog.d', 'README.md'), '# How to\n')
  writeFileSync(path.join(dir, 'changelog.d', 'W0-5.md'), '### Added\n\n- Harness.\n')
  execFileSync(process.execPath, [SCRIPT, 'release', '1.5.0', '--date', '2026-11-20', '--root', dir])
  const cl = readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')
  assert.match(cl, /## \[1\.5\.0\] - 2026-11-20\n\n### Added\n\n- Harness\./)
  assert.equal(existsSync(path.join(dir, 'changelog.d', 'W0-5.md')), false)
  assert.deepEqual(readdirSync(path.join(dir, 'changelog.d')), ['README.md'])
})

test('CLI check exits 1 with a message when no fragment is present', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cl-gate-'))
  let code = 0
  let stderr = ''
  try {
    execFileSync(process.execPath, [SCRIPT, 'check', '--files', 'server/a.js', '--root', dir], { stdio: 'pipe' })
  } catch (e) {
    code = e.status
    stderr = String(e.stderr)
  }
  assert.equal(code, 1)
  assert.match(stderr, /no changelog fragment/)
})
