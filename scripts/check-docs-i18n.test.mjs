// Unit tests for scripts/check-docs-i18n.mjs. Every check runs against a small
// fixture repository written to a temp dir (paired EN + pt-BR + es markdown),
// so a regression in one rule shows up as one failing case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  gitBlobHash,
  slugify,
  scanMarkdown,
  normalizeCode,
  parseMarker,
  checkDocs,
  renderStatus,
  renderGlossary,
  stampFile,
  runCli,
} from './check-docs-i18n.mjs'
import * as guard from './check-docs-i18n.mjs'

const hashTerm = (...a) => guard.hashTerm(...a)

const MANIFEST = {
  sourceLocale: 'en',
  names: { en: 'English', 'pt-BR': 'Português (Brasil)', es: 'Español' },
  locales: ['pt-BR', 'es'],
  sources: ['README.md', 'docs/*.md'],
  exclude: ['docs/i18n-status.md', 'docs/glossary.md'],
  paths: { 'README.md': { 'pt-BR': 'README.pt-BR.md', es: 'README.es.md' } },
  allowMissing: { es: ['docs/guide.md'] },
}

const EN_GUIDE = `# Guide

**English** · [Português (Brasil)](pt-BR/guide.md)

Intro with a [link to the setup](#set-up-the-app) and to [the README](../README.md).

## Set up the app

\`\`\`bash
# install the dependencies
npm ci --include=dev   # once
npm run bundle
\`\`\`

| Name | Value |
|---|---|
| a | b |

## Ação e reação
`

const PT_GUIDE = (hash, status = 'current', extra = '') => `<!-- i18n: source=docs/guide.md source-hash=${hash} status=${status} -->
# Guia

[English](../guide.md) · **Português (Brasil)**
${extra}
Introdução com um [link para a instalação](#instale-o-app) e para [o README](../../README.pt-BR.md).

## Instale o app

\`\`\`bash
# instale as dependências
npm ci --include=dev   # uma vez
npm run bundle
\`\`\`

| Nome | Valor |
|---|---|
| a | b |

## Ação e reação
`

const EN_README = `# Project

**English** · [Português (Brasil)](README.pt-BR.md) · [Español](README.es.md)

See the [guide](docs/guide.md#ação-e-reação).
`

const PT_README = (hash) => `<!-- i18n: source=README.md source-hash=${hash} status=current -->
# Projeto

[English](README.md) · **Português (Brasil)** · [Español](README.es.md)

Veja o [guia](docs/pt-BR/guide.md#ação-e-reação).
`

const ES_README = (hash) => `<!-- i18n: source=README.md source-hash=${hash} status=stub -->
# Proyecto

[English](README.md) · [Português (Brasil)](README.pt-BR.md) · **Español**

La traducción completa llegará pronto. Mientras tanto, lea el [README en inglés](README.md).
`

function write(root, rel, text) {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

/** A fixture repo where every check passes; `mutate(files)` edits it first. */
function fixture(mutate = () => {}, manifest = MANIFEST) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-i18n-'))
  const files = new Map()
  files.set('README.md', EN_README)
  files.set('docs/guide.md', EN_GUIDE)
  const h = (rel) => gitBlobHash(files.get(rel))
  files.set('README.pt-BR.md', () => PT_README(h('README.md')))
  files.set('README.es.md', () => ES_README(h('README.md')))
  files.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')))
  if (mutate) mutate(files, h)
  write(root, 'docs/i18n.json', JSON.stringify(manifest, null, 2))
  for (const [rel, v] of files) if (v != null) write(root, rel, typeof v === 'function' ? v() : v)
  return root
}

const messages = (list) => list.map((e) => `${e.file}: ${e.message}`)
const hasMessage = (list, re) => list.some((e) => re.test(`${e.file}: ${e.message}`))

function withFixture(mutate, fn, manifest) {
  const root = fixture(mutate, manifest)
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- helpers

test('gitBlobHash matches `git hash-object`', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-i18n-hash-'))
  try {
    const text = 'Olá, mundo — ação\n'
    write(root, 'a.md', text)
    const git = execFileSync('git', ['hash-object', path.join(root, 'a.md')], { encoding: 'utf8' }).trim()
    assert.equal(gitBlobHash(text), git)
    assert.equal(gitBlobHash(Buffer.from(text)), git)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('slugify follows GitHub heading anchors', () => {
  assert.equal(slugify('Set up the app'), 'set-up-the-app')
  assert.equal(slugify('Ação e reação'), 'ação-e-reação')
  assert.equal(slugify('3. Telemetria (OpenTelemetry)'), '3-telemetria-opentelemetry')
  assert.equal(slugify('5.1 SLOs propostos'), '51-slos-propostos')
  assert.equal(slugify('Vínculo entre e-mail e token (`server/identityBinding.js`)'), 'vínculo-entre-e-mail-e-token-serveridentitybindingjs')
  assert.equal(slugify('[Linked](x.md) **bold** `code`'), 'linked-bold-code')
  assert.equal(slugify('user_email and A/B'), 'user_email-and-ab')
})

test('scanMarkdown counts headings, fences and tables outside code', () => {
  const s = scanMarkdown(EN_GUIDE)
  assert.deepEqual(s.headingCounts, [1, 2, 0, 0])
  assert.equal(s.codeBlocks.length, 1)
  assert.equal(s.codeBlocks[0].lang, 'bash')
  assert.equal(s.tables, 1)
  assert.ok(s.slugs.has('set-up-the-app'))
  const inFence = scanMarkdown('# A\n\n```md\n## not a heading\n| a | b |\n|---|---|\n```\n')
  assert.deepEqual(inFence.headingCounts, [1, 0, 0, 0])
  assert.equal(inFence.tables, 0)
  const dup = scanMarkdown('# A\n## Notes\n## Notes\n')
  assert.ok(dup.slugs.has('notes') && dup.slugs.has('notes-1'))
})

test('normalizeCode ignores comments only', () => {
  assert.equal(normalizeCode('bash', '# a\nnpm test   # x\n'), normalizeCode('bash', '# b\nnpm test   # y\n'))
  assert.notEqual(normalizeCode('bash', 'npm test\n'), normalizeCode('bash', 'npm run test\n'))
  assert.equal(normalizeCode('js', '// a\nconst x = 1 // c\n'), normalizeCode('js', '// b\nconst x = 1 // d\n'))
  assert.equal(normalizeCode('sql', '-- a\nSELECT 1; -- c\n'), normalizeCode('sql', '-- b\nSELECT 1; -- d\n'))
})

test('parseMarker reads the HTML comment on line 1', () => {
  assert.deepEqual(parseMarker('<!-- i18n: source=docs/a.md source-hash=abc123 status=machine -->\n# A\n'), {
    source: 'docs/a.md',
    hash: 'abc123',
    status: 'machine',
  })
  assert.equal(parseMarker('# A\n'), null)
})

// ---------------------------------------------------------------- checks

test('a consistent fixture passes with no errors', () => {
  withFixture(null, (root) => {
    const r = checkDocs(root)
    assert.deepEqual(messages(r.errors), [])
  })
})

test('existence: a missing translation fails unless allowMissing lists it', () => {
  withFixture((f) => f.set('docs/pt-BR/guide.md', null), (root) => {
    const r = checkDocs(root)
    assert.ok(hasMessage(r.errors, /docs\/guide\.md.*missing pt-BR translation docs\/pt-BR\/guide\.md/), messages(r.errors).join('\n'))
  })
  // es for docs/guide.md is in allowMissing: no error
  withFixture(null, (root) => {
    assert.ok(!hasMessage(checkDocs(root).errors, /docs\/es\/guide\.md/))
  })
})

test('--strict turns allowMissing and flagged drift into errors', () => {
  withFixture(null, (root) => {
    const r = checkDocs(root, { strict: true })
    assert.ok(hasMessage(r.errors, /missing es translation docs\/es\/guide\.md/))
    assert.ok(hasMessage(r.errors, /README\.es\.md.*stub/))
  })
})

test('marker: missing or pointing at the wrong source fails', () => {
  withFixture((f) => f.set('docs/pt-BR/guide.md', PT_GUIDE('x').split('\n').slice(1).join('\n')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/pt-BR\/guide\.md: no i18n marker on line 1/))
  })
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('source=docs/guide.md', 'source=docs/other.md')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /marker source docs\/other\.md, expected docs\/guide\.md/))
  })
})

test('staleness: EN changed + status=current fails; outdated/machine warn and need a banner', () => {
  const changedEn = EN_GUIDE.replace('Intro with', 'An intro with')
  withFixture((f, h) => {
    const old = h('docs/guide.md')
    f.set('docs/guide.md', changedEn)
    f.set('docs/pt-BR/guide.md', PT_GUIDE(old))
  }, (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/pt-BR\/guide\.md: .*English source changed/))
  })
  const banner = '\n> Esta tradução pode estar desatualizada. Veja a [versão em inglês](../guide.md).\n'
  withFixture((f, h) => {
    const old = h('docs/guide.md')
    f.set('docs/guide.md', changedEn)
    f.set('docs/pt-BR/guide.md', PT_GUIDE(old, 'outdated', banner))
  }, (root) => {
    const r = checkDocs(root)
    assert.deepEqual(messages(r.errors), [])
    assert.ok(hasMessage(r.warnings, /docs\/pt-BR\/guide\.md: .*outdated/))
    assert.ok(hasMessage(checkDocs(root, { strict: true }).errors, /English source changed/))
  })
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md'), 'machine')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /status=machine needs a banner/))
  })
})

test('parity: headings per level, code blocks and tables must match', () => {
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('## Ação e reação\n', '')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /H2 headings: English 2, pt-BR 1/))
  })
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('| Nome | Valor |\n|---|---|\n| a | b |\n', 'Sem tabela.\n')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /tables: English 1, pt-BR 0/))
  })
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')) + '\n```bash\nnpm test\n```\n'), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /code blocks: English 1, pt-BR 2/))
  })
})

test('code blocks: byte-identical except comments; code-translated opt-out', () => {
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('npm run bundle', 'npm run pacote')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /code block 1 differs from English/))
  })
  const optOut = (text) => text.replace('```bash', '<!-- i18n: code-translated -->\n```bash')
  withFixture((f, h) => {
    f.set('docs/guide.md', optOut(EN_GUIDE))
    f.set('docs/pt-BR/guide.md', () => optOut(PT_GUIDE(h('docs/guide.md'))).replace('npm run bundle', 'npm run pacote'))
  }, (root) => {
    assert.deepEqual(messages(checkDocs(root).errors), [])
  })
})

test('links: missing files and anchors fail, accented anchors resolve', () => {
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('(#instale-o-app)', '(#set-up-the-app)')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/pt-BR\/guide\.md: broken anchor #set-up-the-app/))
  })
  withFixture((f) => f.set('README.md', EN_README.replace('docs/guide.md#', 'docs/nope.md#')), (root) => {
    const errs = checkDocs(root).errors
    assert.ok(hasMessage(errs, /README\.md: broken link docs\/nope\.md/), messages(errs).join('\n'))
  })
  withFixture((f) => f.set('README.md', EN_README + '\n`[not a link](missing.md)` and http://x\n\n```md\n[x](missing.md)\n```\n'), (root) => {
    // links inside inline code and fences are not checked; the README changed, so restamp is due
    assert.ok(!hasMessage(checkDocs(root).errors, /missing\.md/))
  })
})

test('switcher: first line after the H1 links every existing language', () => {
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('[English](../guide.md) · **Português (Brasil)**', 'Leia em inglês.')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/pt-BR\/guide\.md: language switcher/))
  })
  withFixture((f) => f.set('README.md', EN_README.replace(' · [Español](README.es.md)', '')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /README\.md: language switcher .*Español/))
  })
  // a source with no translation at all needs no switcher
  withFixture((f) => f.set('docs/solo.md', '# Solo\n\nNo translations yet.\n'), (root) => {
    assert.ok(!hasMessage(checkDocs(root).errors, /docs\/solo\.md: language switcher/))
  }, { ...MANIFEST, allowMissing: { es: ['docs/guide.md', 'docs/solo.md'], 'pt-BR': ['docs/solo.md'] } })
})

// ---------------------------------------------------------------- generated files

test('--report renders a deterministic status table; check flags a stale one', () => {
  withFixture(null, (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/i18n-status\.md is missing/))
    const table = renderStatus(root)
    assert.match(table, /\| `docs\/guide\.md` \|/)
    assert.match(table, /\[current\]\(pt-BR\/guide\.md\)/)
    assert.match(table, /missing \(planned\)/)
    assert.match(table, /\[stub\]\(\.\.\/README\.es\.md\)/)
    assert.equal(renderStatus(root), table)
    write(root, 'docs/i18n-status.md', 'old\n')
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/i18n-status\.md is out of date/))
    write(root, 'docs/i18n-status.md', table)
    assert.deepEqual(messages(checkDocs(root).errors), [])
  }, { ...MANIFEST, status: 'docs/i18n-status.md' })
})

test('--stamp rewrites the marker with the current English hash and status', () => {
  withFixture((f) => f.set('docs/pt-BR/guide.md', PT_GUIDE('0000', 'current')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /English source changed/))
    stampFile(root, 'docs/pt-BR/guide.md')
    const text = readFileSync(path.join(root, 'docs/pt-BR/guide.md'), 'utf8')
    const enHash = gitBlobHash(readFileSync(path.join(root, 'docs/guide.md')))
    assert.deepEqual(parseMarker(text), { source: 'docs/guide.md', hash: enHash, status: 'current' })
    assert.equal(text.split('\n').length, PT_GUIDE('0000').split('\n').length)
    stampFile(root, 'docs/pt-BR/guide.md', 'outdated')
    assert.equal(parseMarker(readFileSync(path.join(root, 'docs/pt-BR/guide.md'), 'utf8')).status, 'outdated')
  })
  // a translation with no marker yet gets one inserted
  withFixture((f) => f.set('docs/pt-BR/guide.md', PT_GUIDE('x').split('\n').slice(1).join('\n')), (root) => {
    stampFile(root, 'docs/pt-BR/guide.md', 'machine')
    const text = readFileSync(path.join(root, 'docs/pt-BR/guide.md'), 'utf8')
    assert.equal(parseMarker(text).status, 'machine')
    assert.match(text.split('\n')[1], /^# Guia$/)
  })
})

test('glossary is generated from the UI catalogs; unknown keys fail', async () => {
  const manifest = {
    ...MANIFEST,
    glossary: {
      catalogs: 'ui/locales.js',
      catalogLocales: { en: 'en', 'pt-BR': 'pt', es: 'es' },
      keys: 'docs/glossary.keys.json',
      out: 'docs/glossary.md',
    },
  }
  const root = fixture(() => {}, manifest)
  try {
    write(root, 'ui/locales.js', `export default {
      en: { 'a.new': 'New chat', 'a.pipe': 'A | B' },
      pt: { 'a.new': 'Nova conversa', 'a.pipe': 'A | B' },
      es: { 'a.new': 'Nueva conversación', 'a.pipe': 'A | B' },
    }\n`)
    write(root, 'docs/glossary.keys.json', JSON.stringify({ neverTranslate: ['Lakebase'], sections: [{ title: 'Chat', keys: ['a.new', 'a.pipe'] }] }))
    const md = await renderGlossary(root)
    assert.match(md, /\| New chat \| Nova conversa \| Nueva conversación \| `a\.new` \|/)
    assert.match(md, /A \\\| B/)
    assert.match(md, /Lakebase/)
    write(root, 'docs/glossary.keys.json', JSON.stringify({ sections: [{ title: 'Chat', keys: ['a.gone'] }] }))
    await assert.rejects(renderGlossary(root), /a\.gone/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runCli --ci prints GitHub annotations and returns 1 on errors', async () => {
  const root = fixture((f) => f.set('docs/pt-BR/guide.md', null), { ...MANIFEST, prohibited: testProhibited('Vorpal Quux Zeta') })
  try {
    const out = []
    const code = await runCli(['--ci', '--root', root], { log: (s) => out.push(s), error: (s) => out.push(s) })
    assert.equal(code, 1)
    assert.ok(out.some((l) => l.startsWith('::error file=docs/guide.md')), out.join('\n'))
    write(root, 'docs/pt-BR/guide.md', PT_GUIDE(gitBlobHash(readFileSync(path.join(root, 'docs/guide.md')))))
    assert.equal(await runCli(['--report', '--root', root], { log: () => {}, error: () => {} }), 0)
    assert.equal(await runCli(['--ci', '--root', root], { log: () => {}, error: () => {} }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- QA r1 findings

test('QA r1 #5: a blank-line-only change in a code block is not "identical"', () => {
  const before = ['npm ci --include=dev', '', 'npm run bundle'].join('\n')
  const after = ['npm ci --include=dev', 'npm run bundle'].join('\n')
  assert.notEqual(normalizeCode('bash', before), normalizeCode('bash', after))
  assert.notEqual(normalizeCode('bash', 'npm test  \n'), normalizeCode('bash', 'npm test\n'))
  // whole comment lines and trailing comments are still ignored
  assert.equal(normalizeCode('bash', '# one\nnpm test   # a\n\nnpm run qa\n'), normalizeCode('bash', '# um\n# dois\nnpm test   # b\n\nnpm run qa\n'))
  assert.equal(normalizeCode('js', '/* a */\nconst x = 1\n'), normalizeCode('js', '/* b\n   c */\nconst x = 1\n'))
  withFixture((f, h) => f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('npm ci --include=dev   # uma vez\n', 'npm ci --include=dev   # uma vez\n\n')), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /code block 1 differs from English/))
  })
})

// Synthetic, test-only terms and salt. Real names never appear in this repo:
// production entries are salted hashes in docs/i18n.json (see QA r2 below).
const TEST_SALT = 'test-only-salt'
const testProhibited = (...terms) => ({ salt: TEST_SALT, terms: terms.map((t) => hashTerm(t, TEST_SALT)) })

test('QA r1 #1 / r2 #1: a prohibited name in any text file or path fails, by salted hash, without printing it', () => {
  const entry = hashTerm('Vorpal Quux Zeta', TEST_SALT)
  assert.deepEqual(Object.keys(entry).sort(), ['length', 'sha256'])
  assert.equal(entry.length, 'vorpalquuxzeta'.length)
  assert.ok(!JSON.stringify(entry).toLowerCase().includes('vorpal'))
  assert.notEqual(hashTerm('Vorpal Quux Zeta', 'other-salt').sha256, entry.sha256, 'the salt changes the hash')
  // spaces, hyphens, underscores, case and accents collapse to the same entry
  for (const variant of ['vorpal-quux-zeta', 'VORPAL_QUUX_ZETA', 'Vórpal  Quux Zeta', 'VorpalQuuxZeta']) {
    assert.deepEqual(hashTerm(variant, TEST_SALT), entry, variant)
  }
  const manifest = { ...MANIFEST, prohibited: testProhibited('Vorpal Quux Zeta') }
  const cases = [
    ['docs/i18n-pending/forbidden-probe.md', 'VORPAL_QUUX_ZETA\n', 1], // an unlisted file (the QA probe)
    ['scripts/notes.txt', 'line one\nsee the vórpal-\nQuux ZETA here\n', 2], // across a line break, other case
    ['server/thing.js', 'const x = "VorpalQuux-zeta"\n', 1], // code, joined spelling
    ['client/dist/assets/app-abc123.js', 'var a="vorpal quux zeta";\n', 1], // built bundles are scanned too
  ]
  for (const [file, text, line] of cases) {
    withFixture((f) => f.set(file, text), (root) => {
      const errs = checkDocs(root, { requireProhibited: true }).errors
      const hit = errs.find((e) => e.file === file && /prohibited name/.test(e.message))
      assert.ok(hit, `${file}: ${messages(errs).join('\n')}`)
      assert.equal(hit.line, line, file)
      assert.ok(!errs.some((e) => /vorpal|quux|zeta/i.test(e.message)), 'the message must not echo the term')
    }, manifest)
  }
  // a file NAME carrying it fails too
  withFixture((f) => f.set('docs/vorpal-quux-zeta.txt', 'harmless\n'), (root) => {
    assert.ok(hasMessage(checkDocs(root).errors, /docs\/vorpal-quux-zeta\.txt: prohibited name in the file path/))
  }, manifest)
  // no false positive on a partial match; terms can also come from the environment
  withFixture((f) => f.set('docs/i18n-pending/ok.md', 'vorpal quux only\n'), (root) => {
    assert.ok(!hasMessage(checkDocs(root).errors, /prohibited name/))
    assert.ok(hasMessage(checkDocs(root, { prohibitedTerms: ['quux only'] }).errors, /docs\/i18n-pending\/ok\.md: prohibited name/))
  }, manifest)
})

test('QA r2 #1: with no prohibited names configured, --ci fails closed', async () => {
  withFixture(null, (root) => {
    assert.ok(hasMessage(checkDocs(root, { requireProhibited: true }).errors, /no prohibited names configured/))
    assert.ok(hasMessage(checkDocs(root).warnings, /no prohibited names configured/))
    assert.ok(!hasMessage(checkDocs(root).errors, /no prohibited names configured/))
  })
  const root = fixture()
  try {
    const out = []
    assert.equal(await runCli(['--ci', '--root', root], { log: (s) => out.push(s), error: (s) => out.push(s) }), 1)
    assert.ok(out.some((l) => /^::error file=docs\/i18n\.json.*no prohibited names configured/.test(l)), out.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // a salt with an empty list is still "not configured"
  withFixture(null, (root) => {
    assert.ok(hasMessage(checkDocs(root, { requireProhibited: true }).errors, /no prohibited names configured/))
  }, { ...MANIFEST, prohibited: { salt: TEST_SALT, terms: [] } })
})

test('QA r2 #1: --hash-terms <file> prints only salted entries, never the terms', async () => {
  const root = fixture(null, { ...MANIFEST, prohibited: { salt: TEST_SALT, terms: [] } })
  const priv = mkdtempSync(path.join(tmpdir(), 'docs-i18n-terms-'))
  try {
    write(priv, 'terms.txt', '# comment line\nVorpal Quux Zeta\n\n  quux-only  \n')
    const out = []
    const err = []
    assert.equal(await runCli(['--hash-terms', path.join(priv, 'terms.txt'), '--root', root], { log: (s) => out.push(s), error: (s) => err.push(s) }), 0)
    const text = out.join('\n')
    assert.ok(!/vorpal|quux|zeta|comment/i.test(text + err.join('\n')), 'output must not contain the terms')
    assert.deepEqual(JSON.parse(text), [hashTerm('Vorpal Quux Zeta', TEST_SALT), hashTerm('quux only', TEST_SALT)])
    // without a salt in the manifest it refuses (and still prints no term)
    const noSalt = fixture()
    try {
      const e2 = []
      assert.equal(await runCli(['--hash-terms', path.join(priv, 'terms.txt'), '--root', noSalt], { log: (s) => e2.push(s), error: (s) => e2.push(s) }), 2)
      assert.ok(e2.some((l) => /prohibited\.salt/.test(l)) && !/vorpal/i.test(e2.join('\n')))
    } finally {
      rmSync(noSalt, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(priv, { recursive: true, force: true })
  }
})

test('QA r2 #1: the production manifest carries salted entries and they catch a synthetic variant', () => {
  const prod = JSON.parse(readFileSync(new URL('../docs/i18n.json', import.meta.url), 'utf8')).prohibited
  assert.ok(prod && typeof prod.salt === 'string' && prod.salt.length >= 16, 'prohibited.salt is set')
  assert.ok(Array.isArray(prod.terms) && prod.terms.length > 0, 'prohibited.terms is not empty')
  for (const t of prod.terms) {
    assert.deepEqual(Object.keys(t).sort(), ['length', 'sha256'])
    assert.match(t.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(t.length) && t.length > 0)
  }
  // the production salt + a test-only entry for a synthetic term: the real scan path catches a variant
  const manifest = { ...MANIFEST, prohibited: { salt: prod.salt, terms: [...prod.terms, hashTerm('Vorpal Quux Zeta', prod.salt)] } }
  withFixture((f) => f.set('docs/i18n-pending/probe.md', 'Some text about the vorpal-\nquux_ZETA program.\n'), (root) => {
    const errs = checkDocs(root, { requireProhibited: true }).errors
    assert.ok(hasMessage(errs, /docs\/i18n-pending\/probe\.md: prohibited name/), messages(errs).join('\n'))
    // the production entries flag nothing in the clean fixture
    assert.equal(errs.filter((e) => /prohibited name/.test(e.message)).length, 1)
  }, manifest)
})

test('QA r1 #3: a required document must exist in every locale; allowMissing cannot excuse it', () => {
  const manifest = { ...MANIFEST, required: ['docs/guide.md'] }
  withFixture(null, (root) => {
    const errs = checkDocs(root).errors
    assert.ok(hasMessage(errs, /docs\/guide\.md: required document has no es translation/), messages(errs).join('\n'))
  }, manifest)
  withFixture((f, h) => {
    f.set('docs/es/guide.md', () => PT_GUIDE(h('docs/guide.md'), 'machine', '\n> Traducción asistida. Vea la [versión en inglés](../guide.md).\n').replace('**Português (Brasil)**', '[Português (Brasil)](../pt-BR/guide.md) · **Español**'))
    f.set('docs/guide.md', EN_GUIDE.replace('[Português (Brasil)](pt-BR/guide.md)', '[Português (Brasil)](pt-BR/guide.md) · [Español](es/guide.md)'))
    f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('**Português (Brasil)**', '**Português (Brasil)** · [Español](../es/guide.md)'))
  }, (root) => {
    assert.ok(!hasMessage(checkDocs(root).errors, /required document/), messages(checkDocs(root).errors).join('\n'))
  }, { ...manifest, allowMissing: {} })
})

test('QA r1 #4: docs may not advertise a Node.js older than package.json engines', () => {
  const withEngines = (f) => f.set('package.json', JSON.stringify({ engines: { node: '>=22' } }))
  withFixture((f, h) => {
    withEngines(f)
    f.set('docs/guide.md', EN_GUIDE.replace('## Set up the app\n', '## Set up the app\n\nYou need **Node.js 18+** and npm.\n'))
    f.set('docs/pt-BR/guide.md', () => PT_GUIDE(h('docs/guide.md')).replace('## Instale o app\n', '## Instale o app\n\nVocê precisa do Node ≥ 20.\n'))
  }, (root) => {
    const errs = checkDocs(root).errors
    assert.ok(hasMessage(errs, /docs\/guide\.md: says Node\.js 18, but package\.json engines requires >=22/), messages(errs).join('\n'))
    assert.ok(hasMessage(errs, /docs\/pt-BR\/guide\.md: says Node\.js 20/))
  })
  withFixture((f, h) => {
    withEngines(f)
    f.set('docs/guide.md', EN_GUIDE.replace('## Set up the app\n', '## Set up the app\n\nNode.js 22+ (Node ≥ 22.19 for e2e). Not Node 18 or v20 ranges in prose.\n'))
  }, (root) => {
    assert.ok(!hasMessage(checkDocs(root).errors, /says Node\.js/), messages(checkDocs(root).errors).join('\n'))
  })
})

test('Node claims compare the minor version when the doc states one (engines >=22.18.0)', () => {
  withFixture((f) => {
    f.set('package.json', JSON.stringify({ engines: { node: '>=22.18.0' } }))
    f.set('docs/solo.md', '# Solo\n\nNeeds Node.js 22.10+ or Node ≥ 22.3.\n\nFine: Node.js 22.18+, Node ≥ 22.19, Node 23+.\n')
  }, (root) => {
    const errs = checkDocs(root).errors.filter((e) => /says Node/.test(e.message))
    assert.deepEqual(errs.map((e) => `${e.file}:${e.line} ${e.message}`), [
      'docs/solo.md:3 says Node.js 22.10, but package.json engines requires >=22.18.0',
      'docs/solo.md:3 says Node.js 22.3, but package.json engines requires >=22.18.0',
    ])
  }, { ...MANIFEST, allowMissing: { es: ['docs/guide.md', 'docs/solo.md'], 'pt-BR': ['docs/solo.md'] } })
})
