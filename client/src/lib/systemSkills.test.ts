// N7 item 19: the built-in ("system") skills carry pt-BR text from the server
// (SYSTEM_SKILLS in server/blocks.js). The UI localizes them from its catalogs,
// keyed by the skill's NAME, and keeps the server text as the fallback for a
// skill the catalogs do not know (a newer server, an authored skill).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import catalogs from './locales/index.ts'
import { localizedSkill, SYSTEM_SKILL_NAMES } from './systemSkills.ts'

// the catalogs as the app's t() reads them: a missing key comes back as the key (lib/i18n.tsx)
const tFor = (locale: 'pt' | 'en' | 'es') => (k: string) => catalogs[locale][k] ?? k

test('N7-19: every built-in system skill has a title and a description in pt, en and es', () => {
  for (const name of SYSTEM_SKILL_NAMES) {
    for (const locale of ['pt', 'en', 'es'] as const) {
      const t = tFor(locale)
      assert.notEqual(t(`skills.system.${name}.title`), `skills.system.${name}.title`, `${locale} ${name} title`)
      assert.notEqual(t(`skills.system.${name}.description`), `skills.system.${name}.description`, `${locale} ${name} description`)
    }
  }
})

test('N7-19: a system skill is shown in the UI language; the catalogs differ per language', () => {
  const server = { name: 'deck-generation', scope: 'system', title: 'Geração de apresentações', description: 'Cria apresentações…' }
  const en = localizedSkill(tFor('en'), server)
  assert.equal(en.title, 'Presentation generation')
  assert.notEqual(en.description, server.description)
  assert.notEqual(localizedSkill(tFor('es'), server).title, en.title)
  assert.equal(localizedSkill(tFor('pt'), server).title, 'Geração de apresentações')
})

test('N7-19: an unknown name keeps the server text (fallback), and an authored skill is never touched', () => {
  const unknown = { name: 'future-capability', scope: 'system', title: 'Capacidade nova', description: 'texto do servidor' }
  assert.deepEqual(localizedSkill(tFor('en'), unknown), { ...unknown })
  const authored = { name: 'deck-generation', scope: 'user', title: 'Meu deck', description: 'meu texto' }
  assert.equal(localizedSkill(tFor('en'), authored).title, 'Meu deck')
})

test('N7-19: the live-turn badge payload (system: true) is localized like the tab entry', () => {
  const badge = { name: 'spreadsheet-generation', system: true, title: 'Geração de planilhas', description: 'Monta planilhas…' }
  assert.equal(localizedSkill(tFor('en'), badge).title, 'Spreadsheet generation')
})
