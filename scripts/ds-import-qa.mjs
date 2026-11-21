#!/usr/bin/env node
// QA harness for the design-system bundle importer (client/src/lib/dsImport.js)
// against a real exported folder:
//
//   node scripts/ds-import-qa.mjs <bundle-dir> [out.json]
//
// Prints a summary and optionally writes the resulting template patch JSON.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { importDesignSystemBundle } from '../client/src/lib/dsImport.ts'

const [dir, outPath] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node scripts/ds-import-qa.mjs <bundle-dir> [out.json]')
  process.exit(1)
}

function walk(root) {
  const out = []
  for (const name of readdirSync(root)) {
    if (name === '.DS_Store' || name === 'uploads') continue // uploads/ = source pptx, never part of the bundle payload
    const full = join(root, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(dir)
const entries = files.map((full) => ({
  path: relative(dir, full).split('\\').join('/'),
  text: async () => readFileSync(full, 'utf8'),
  bytes: async () => new Uint8Array(readFileSync(full)),
}))

const t0 = Date.now()
const patch = await importDesignSystemBundle(entries, { onProgress: (m) => console.error('…', m) })
const ms = Date.now() - t0

const kinds = {}
for (const a of patch.iconAssets) kinds[a.kind] = (kinds[a.kind] || 0) + 1
const size = JSON.stringify(patch).length
console.log({
  name: patch.name,
  colors: {
    background: patch.backgroundColor,
    primary: patch.primaryColor,
    accent: patch.accentColor,
    secondary: patch.secondaryColor,
  },
  fonts: { heading: patch.headingFont, body: patch.bodyFont, fontAssets: patch.fontAssets.length },
  palette: patch.palette.length,
  readmeChars: patch.readme.length,
  brandRulesChars: patch.brandRules.length,
  assets: kinds,
  logo: { dark: patch.logoDataUrl?.slice(0, 40), light: patch.logoLightDataUrl?.slice(0, 40) },
  dsCards: patch.dsCards.length,
  cardGroups: [...new Set(patch.dsCards.map((c) => c.group))],
  totalJsonMB: (size / 1e6).toFixed(1),
  ms,
})
console.log('\nimport report:', JSON.stringify(patch._importReport, null, 1))
console.log('\nsample icons:', patch.iconAssets.filter((a) => a.kind === 'icon').slice(0, 8).map((a) => a.label))
console.log('illustrations:', patch.iconAssets.filter((a) => a.kind === 'illustration').map((a) => a.label))
console.log('backgrounds:', patch.iconAssets.filter((a) => a.kind === 'background').map((a) => a.label))
console.log('palette sample:', patch.palette.slice(0, 8).map((t) => `${t.name}=${t.value}`))

if (outPath) {
  writeFileSync(outPath, JSON.stringify(patch))
  console.log('\nwrote', outPath)
}
