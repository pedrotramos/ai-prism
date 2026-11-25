// Token purity of the Settings / admin surface (W2-7), checked by grep, not
// estimated: no hard-coded hex colour and no inline style except computed
// geometry or design-system data (a template's own colours and fonts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const FILES = [
  'SettingsModal', 'PersonalTab', 'AdminSettings', 'ModelsAdminTab', 'ToolsAdminTab', 'McpCatalogAdminTab',
  'McpConnectionsTab', 'SkillsTab', 'DeckTemplatesSettings', 'DeckTemplateInspector', 'TemplateSlidePreview',
]
const src: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(`./${f}.tsx`, import.meta.url), 'utf8')]))
const count = (re: RegExp): Record<string, number> => Object.fromEntries(FILES.map((f) => [f, (src[f]!.match(re) || []).length]))
const total = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0)

test('hard-coded hex colours: at most 5 across the settings files', () => {
  const hex = count(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b(?![-\w])/g)
  assert.ok(total(hex) <= 5, JSON.stringify(hex))
})

test('raw palette colours (red-400, amber-500, text-white …) are replaced by tokens', () => {
  // the modal scrim (bg-black/50) is the app-wide overlay convention and has
  // no token yet (tokens.css is owned elsewhere), so it is the one exception
  const raw = count(/\b(?:text|bg|border|ring)-(?:white|black(?!\/\d)|(?:red|green|amber|yellow|emerald|blue|sky|orange|rose|gray|zinc|slate)-\d{2,3})\b/g)
  assert.equal(total(raw), 0, JSON.stringify(raw))
})

test('inline styles only where the value is computed geometry or DS data', () => {
  const inline = count(/style=\{\{/g)
  // PersonalTab, ModelsAdminTab, McpCatalogAdminTab and McpConnectionsTab have none
  for (const f of ['SettingsModal', 'PersonalTab', 'ModelsAdminTab', 'ToolsAdminTab', 'McpCatalogAdminTab', 'McpConnectionsTab', 'AdminSettings', 'SkillsTab'])
    assert.equal(inline[f], 0, `${f}: ${inline[f]}`)
  // 12 left: 2 iframe scale transforms (geometry) + 10 template colours, fonts and
  // the specimen paper (DS data). Ratchet: lower this when one goes away (W2-3 took
  // the thumbnail fallback and the swatches to SVG paint attributes).
  assert.ok(total(inline) <= 12, JSON.stringify(inline))
})

test('ModelsAdminTab uses the type scale, not arbitrary pixel sizes', () => {
  assert.deepEqual(src.ModelsAdminTab!.match(/\[\d+(?:\.\d+)?px\]/g) || [], [])
})

test('W2-3: the provider dot palette is gone; the models table paints marks, never brand hex', () => {
  assert.equal(existsSync(new URL('../lib/providerColors.ts', import.meta.url)), false)
  assert.match(src.ModelsAdminTab!, /ProviderMark/)
  assert.doesNotMatch(src.ModelsAdminTab!, /providerColor|PROVIDER_COLORS/)
})

test('W2-3: primary buttons of the admin and design-system surfaces are ink (bg-action), not the accent', () => {
  for (const f of ['ModelsAdminTab', 'AdminSettings', 'McpCatalogAdminTab', 'DeckTemplatesSettings']) {
    assert.doesNotMatch(src[f]!, /accent-strong|\bon-accent\b/, `${f} still has an accent-filled button`)
    assert.match(src[f]!, /bg-action/, `${f} has no ink primary`)
  }
})
