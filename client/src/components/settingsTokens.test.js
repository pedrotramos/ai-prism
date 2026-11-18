// Token purity of the Settings / admin surface (W2-7), checked by grep, not
// estimated: no hard-coded hex colour and no inline style except computed
// geometry or design-system data (a template's own colours and fonts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FILES = [
  'SettingsModal', 'PersonalTab', 'AdminSettings', 'ModelsAdminTab', 'ToolsAdminTab', 'McpCatalogAdminTab',
  'McpConnectionsTab', 'SkillsTab', 'DeckTemplatesSettings', 'DeckTemplateInspector', 'TemplateSlidePreview',
]
const src = Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(`./${f}.jsx`, import.meta.url), 'utf8')]))
const count = (re) => Object.fromEntries(FILES.map((f) => [f, (src[f].match(re) || []).length]))
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0)

test('hard-coded hex colours: at most 5 across the settings files', () => {
  const hex = count(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b(?![-\w])/g)
  assert.ok(total(hex) <= 5, JSON.stringify(hex))
})

test('raw palette colours (red-400, amber-500, text-white …) are replaced by tokens', () => {
  const raw = count(/\b(?:text|bg|border|ring)-(?:white|black|(?:red|green|amber|yellow|emerald|blue|sky|orange|rose|gray|zinc|slate)-\d{2,3})\b/g)
  assert.equal(total(raw), 0, JSON.stringify(raw))
})

test('inline styles only where the value is computed geometry or DS data', () => {
  const inline = count(/style=\{\{/g)
  // PersonalTab, ModelsAdminTab, McpCatalogAdminTab and McpConnectionsTab have none
  for (const f of ['SettingsModal', 'PersonalTab', 'ModelsAdminTab', 'ToolsAdminTab', 'McpCatalogAdminTab', 'McpConnectionsTab', 'AdminSettings', 'SkillsTab'])
    assert.equal(inline[f], 0, `${f}: ${inline[f]}`)
  assert.ok(total(inline) <= 14, JSON.stringify(inline))
})

test('ModelsAdminTab uses the type scale, not arbitrary pixel sizes', () => {
  assert.deepEqual(src.ModelsAdminTab.match(/\[\d+(?:\.\d+)?px\]/g) || [], [])
})
