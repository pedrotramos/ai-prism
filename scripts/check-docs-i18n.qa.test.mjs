import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkDocs, codeBlockHash, gitBlobHash } from './check-docs-i18n.mjs'
import { findStalePaths } from './check-docs-paths.mjs'

test('a translated code block requires a matching marker in every language', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-i18n-qa-'))
  try {
    const englishCode = 'A[English label]'
    const translatedCode = 'A[Etiqueta traducida]'
    const hash = codeBlockHash(englishCode)
    const en = `# Guide\n\n**English** · [Español](es/guide.md)\n\n## Setup\n\n<!-- i18n: code-translated en=${hash} -->\n\`\`\`mermaid\n${englishCode}\n\`\`\`\n`
    const es = `<!-- i18n: source=docs/guide.md source-hash=${gitBlobHash(en)} status=current -->\n# Guía\n\n[English](../guide.md) · **Español**\n\n## Configuración\n\n\`\`\`mermaid\n${translatedCode}\n\`\`\`\n`
    mkdirSync(path.join(root, 'docs/es'), { recursive: true })
    writeFileSync(path.join(root, 'docs/i18n.json'), JSON.stringify({
      sourceLocale: 'en', names: { en: 'English', es: 'Español' }, locales: ['es'],
      sources: ['docs/guide.md'], paths: {}, allowMissing: {},
    }))
    writeFileSync(path.join(root, 'docs/guide.md'), en)
    writeFileSync(path.join(root, 'docs/es/guide.md'), es)
    const result = checkDocs(root)
    assert.ok(result.errors.length > 0, 'the unmarked translated block must not be waived by the English marker alone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the path guard catches a stale server path relative to a docs page', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-paths-qa-'))
  try {
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    mkdirSync(path.join(root, 'server'), { recursive: true })
    writeFileSync(path.join(root, 'docs/guide.md'), 'See `../server/real.js`.\n')
    writeFileSync(path.join(root, 'server/real.ts'), '')
    const result = findStalePaths(root, ['docs/guide.md'])
    assert.equal(result.length, 1, 'a relative reference to the moved server module must be reported')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
