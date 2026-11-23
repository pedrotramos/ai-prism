// Unit tests for the composer's "/" commands (slashCommands.ts): parsing,
// accent-insensitive filtering, trailing-space tolerance, availability and the
// second step of /modelo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLASH_COMMANDS,
  normalizeSlash,
  parseSlashCommand,
  parseSkillPrefix,
  slashMenuItems,
  canonicalCompactText,
  availableCommandIds,
  nextIndex,
  prefillText,
} from './slashCommands.ts'

// a translator that knows the localized command names of one language
const names = {
  pt: { compact: 'compactar', context: 'contexto', new: 'nova', model: 'modelo', skills: 'skills', cost: 'custo', history: 'historico', settings: 'configuracoes', help: 'ajuda' },
  en: { compact: 'compact', context: 'context', new: 'new', model: 'model', skills: 'skills', cost: 'cost', history: 'history', settings: 'settings', help: 'help' },
}
type Lang = keyof typeof names
const tFor = (lang: Lang) => (key: string): string => {
  const m = /^composer\.slash\.cmd\.(\w+)(\.desc)?$/.exec(key)
  if (!m) return key
  return m[2] ? `${m[1]} description` : names[lang][m[1] as keyof typeof names.pt]
}
const ALL = SLASH_COMMANDS.map((c) => c.id)
const PREFILLS = ['deck', 'memo', 'sheet', 'image', 'genie', 'python']

test('the command set is the nine ported commands plus the six artifact prefills, without /agente', () => {
  assert.deepEqual(ALL, ['compact', 'context', 'new', 'model', 'skills', 'cost', 'history', 'settings', 'help', 'deck', 'memo', 'sheet', 'image', 'genie', 'python'])
  for (const c of SLASH_COMMANDS) assert.ok(!c.names.some((n) => n.startsWith('agent')), c.id)
})

test('normalizeSlash lowercases and strips accents', () => {
  assert.equal(normalizeSlash('Histórico'), 'historico')
  assert.equal(normalizeSlash('CONFIGURAÇÕES'), 'configuracoes')
  assert.equal(normalizeSlash(null), '')
})

test('parseSlashCommand accepts every language name, accents optional', () => {
  assert.equal(parseSlashCommand('/histórico')!.cmd.id, 'history')
  assert.equal(parseSlashCommand('/historial')!.cmd.id, 'history')
  assert.equal(parseSlashCommand('/Configurações')!.cmd.id, 'settings')
  assert.equal(parseSlashCommand('/nueva')!.cmd.id, 'new')
  assert.equal(parseSlashCommand('/costo')!.cmd.id, 'cost')
})

test('parseSlashCommand tolerates surrounding and trailing whitespace', () => {
  assert.deepEqual(parseSlashCommand('/nova   ')!.arg, '')
  assert.equal(parseSlashCommand('  /ajuda \n')!.cmd.id, 'help')
  const p = parseSlashCommand('/compactar   foque nos números  ')
  assert.equal(p!.cmd.id, 'compact')
  assert.equal(p!.arg, 'foque nos números')
})

test('parseSlashCommand returns null for ordinary text and unknown commands', () => {
  assert.equal(parseSlashCommand('hello /nova'), null)
  assert.equal(parseSlashCommand('/foo bar'), null)
  assert.equal(parseSlashCommand('/'), null)
  assert.equal(parseSlashCommand(''), null)
})

test('canonicalCompactText rewrites any language name to /compactar (the form the app parses)', () => {
  assert.equal(canonicalCompactText('/compact keep the numbers '), '/compactar keep the numbers')
  assert.equal(canonicalCompactText('/compactar'), '/compactar')
  assert.equal(canonicalCompactText('/nova'), null)
  assert.equal(canonicalCompactText('hi'), null)
})

test('availableCommandIds: without a handler only /compactar and /ajuda work', () => {
  assert.deepEqual([...availableCommandIds({})].sort(), ['compact', 'help', ...PREFILLS].sort())
  // a handler without an explicit list handles every command
  assert.deepEqual([...availableCommandIds({ hasHandler: true })].sort(), [...ALL].sort())
  // an explicit list narrows it; compact and help stay
  assert.deepEqual([...availableCommandIds({ hasHandler: true, commands: ['new', 'bogus'] })].sort(), ['compact', 'help', 'new', ...PREFILLS].sort())
})

test('slashMenuItems: "/" lists every available command, closed otherwise', () => {
  const t = tFor('en')
  const all = slashMenuItems('/', { t, available: new Set(ALL) })
  assert.deepEqual(all!.map((i) => i.key), ALL.map((id) => `cmd:${id}`))
  assert.equal(all![0]!.label, '/compact')
  assert.equal(all![0]!.description, 'compact description')
  assert.equal(slashMenuItems('hello', { t, available: new Set(ALL) }), null)
  assert.equal(slashMenuItems('/nova\nmore', { t, available: new Set(ALL) }), null)
  assert.equal(slashMenuItems('', { t, available: new Set(ALL) }), null)
})

test('slashMenuItems hides commands without a handler (the prefills still show)', () => {
  const items = slashMenuItems('/', { t: tFor('en'), available: availableCommandIds({}) })
  assert.deepEqual(items!.map((i) => i.cmd!.id), ['compact', 'help', ...PREFILLS])
})

test('slashMenuItems filters as you type, accent-insensitive, in any language', () => {
  const t = tFor('pt')
  const av = new Set(ALL)
  assert.deepEqual(slashMenuItems('/hist', { t, available: av })!.map((i) => i.cmd!.id), ['history'])
  assert.deepEqual(slashMenuItems('/HISTÓ', { t, available: av })!.map((i) => i.cmd!.id), ['history'])
  // English name typed while the UI is Portuguese still matches
  assert.deepEqual(slashMenuItems('/sett', { t, available: av })!.map((i) => i.cmd!.id), ['settings'])
  assert.deepEqual(slashMenuItems('/configura', { t, available: av })!.map((i) => i.cmd!.id), ['settings'])
  assert.equal(slashMenuItems('/zzz', { t, available: av }), null)
})

test('slashMenuItems lists skills after commands and matches name or title', () => {
  const skills = [
    { id: 1, name: 'deck-generation', title: 'Gerar apresentação' },
    { id: 2, name: 'sql-helper', title: 'Ajuda com SQL', enabled: false },
  ]
  const items = slashMenuItems('/apresenta', { t: tFor('pt'), available: new Set(ALL), skills })
  assert.deepEqual(items!.map((i) => i.key), ['skill:1'])
  assert.equal(items![0]!.label, '/deck-generation')
  // disabled skills never show
  assert.equal(slashMenuItems('/sql', { t: tFor('pt'), available: new Set(ALL), skills }), null)
})

test('slashMenuItems: second step of /modelo lists matching models', () => {
  const models = [
    { id: 'databricks-claude-sonnet', label: 'Claude Sonnet', provider: 'Anthropic' },
    { id: 'databricks-gpt-5', label: 'GPT-5', provider: 'OpenAI' },
  ]
  const opts = { t: tFor('pt'), available: new Set(ALL), models }
  assert.deepEqual(slashMenuItems('/modelo ', opts)!.map((i) => i.key), ['model:databricks-claude-sonnet', 'model:databricks-gpt-5'])
  assert.deepEqual(slashMenuItems('/model openai', opts)!.map((i) => i.model!.id), ['databricks-gpt-5'])
  assert.equal(slashMenuItems('/modelo nothing-like-this', opts), null)
  // without the model handler, /modelo has no second step
  assert.equal(slashMenuItems('/modelo ', { ...opts, available: new Set(['compact', 'help']) }), null)
  // other commands close the menu once an argument starts
  assert.equal(slashMenuItems('/compactar foque', opts), null)
})

test('slashMenuItems: /model descriptions use the blurb in the UI language (AC6)', async () => {
  const { pt, en, es } = await import('./locales/index.ts')
  const cat: Record<string, Record<string, string>> = { pt, en, es }
  const tReal = (lang: 'pt' | 'en' | 'es') => (key: string): string => cat[lang]![key] ?? en[key] ?? pt[key] ?? key
  const models = [
    { id: 'databricks-claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'Anthropic', blurb: pt['modelPicker.blurb.databricks-claude-sonnet-5-5'] },
    { id: 'databricks-brand-new', label: 'New', provider: 'Acme', blurb: 'Texto guardado' },
    { id: 'databricks-claude-opus-5-5', label: 'Opus', provider: 'Anthropic', blurb: 'Edited by an admin' },
  ]
  const desc = (lang: 'pt' | 'en' | 'es') => slashMenuItems('/model ', { t: tReal(lang), available: new Set(ALL), models })!.map((i) => i.description)
  assert.deepEqual(desc('en'), ['Anthropic · ' + en['modelPicker.blurb.databricks-claude-sonnet-5-5'], 'Acme · Texto guardado', 'Anthropic · Edited by an admin'])
  assert.equal(desc('es')[0], 'Anthropic · ' + es['modelPicker.blurb.databricks-claude-sonnet-5-5'])
  assert.equal(desc('pt')[0], 'Anthropic · ' + pt['modelPicker.blurb.databricks-claude-sonnet-5-5'])
})

test('parseSkillPrefix pins an enabled skill typed by name', () => {
  const skills = [{ id: 7, name: 'deck-generation', title: 'Decks' }, { id: 8, name: 'off', enabled: false }]
  assert.deepEqual(parseSkillPrefix('/Deck-Generation  faça um deck ', skills), { skill: skills[0], rest: 'faça um deck' })
  assert.equal(parseSkillPrefix('/off hi', skills), null)
  assert.equal(parseSkillPrefix('/nope', skills), null)
})

test('nextIndex wraps for arrows and clamps Home/End', () => {
  assert.equal(nextIndex(0, 3, 'ArrowDown'), 1)
  assert.equal(nextIndex(2, 3, 'ArrowDown'), 0)
  assert.equal(nextIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(nextIndex(1, 3, 'Home'), 0)
  assert.equal(nextIndex(1, 3, 'End'), 2)
  assert.equal(nextIndex(1, 3, 'x'), 1)
  assert.equal(nextIndex(0, 0, 'ArrowDown'), -1)
})

test('slashMenuItems runs well under one frame for a large catalog', () => {
  const skills = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `skill-${i}`, title: `Título ${i}` }))
  const models = Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}`, label: `Model ${i}`, provider: 'P' }))
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) slashMenuItems('/ski', { t: tFor('pt'), available: new Set(ALL), skills, models })
  const perCall = (performance.now() - t0) / 50
  assert.ok(perCall < 16, `${perCall.toFixed(2)} ms per keystroke`)
})

test('the artifact commands are prefills: they never need the app handler', () => {
  for (const id of PREFILLS) assert.equal(SLASH_COMMANDS.find((c) => c.id === id)!.prefill, true, id)
  assert.equal(SLASH_COMMANDS.find((c) => c.id === 'new')!.prefill, undefined)
})

test('parseSlashCommand knows the prefills in every language', () => {
  assert.equal(parseSlashCommand('/deck')!.cmd.id, 'deck')
  assert.equal(parseSlashCommand('/memo vendas')!.arg, 'vendas')
  assert.equal(parseSlashCommand('/planilha')!.cmd.id, 'sheet')
  assert.equal(parseSlashCommand('/hoja')!.cmd.id, 'sheet')
  assert.equal(parseSlashCommand('/imagem')!.cmd.id, 'image')
  assert.equal(parseSlashCommand('/imagen')!.cmd.id, 'image')
  assert.equal(parseSlashCommand('/genie')!.cmd.id, 'genie')
  assert.equal(parseSlashCommand('/python')!.cmd.id, 'python')
})

test('prefillText: the localized lead-in plus what was typed after the command', () => {
  const t = (k: string) => (k === 'composer.slash.prefill.deck' ? 'Crie uma apresentação sobre ' : k)
  assert.equal(prefillText('deck', '', t), 'Crie uma apresentação sobre ')
  assert.equal(prefillText('deck', 'vendas do Sul', t), 'Crie uma apresentação sobre vendas do Sul')
})
