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
  // 13 left: 2 iframe scale transforms (geometry) + 11 template colours, fonts and
  // the specimen paper (DS data). Ratchet: lower this when one goes away.
  assert.ok(total(inline) <= 13, JSON.stringify(inline))
})

test('ModelsAdminTab uses the type scale, not arbitrary pixel sizes', () => {
  assert.deepEqual(src.ModelsAdminTab!.match(/\[\d+(?:\.\d+)?px\]/g) || [], [])
})
