import { modelBlurb } from './modelBlurb.js'
// Commands of the composer's "/" menu (pure logic; the menu is
// components/composer/SlashMenu.jsx and the app runs the actions).
//
// `names` are everything the user may type: every UI language's name works and
// accents are optional ("/historico", "/histórico", "/history", "/historial").
// The menu shows the current language's name (i18n `composer.slash.cmd.<id>`).
// `arg`:
//   'text'  — free text may follow ("/compactar foque nos números");
//   'model' — a second step lists the models to pick from.
//
// A command is only offered when something can run it (`availableCommandIds`):
// /compactar travels as text through onSend (the app already parses it) and
// /ajuda is answered inside the composer, so both always work; the others need
// the app's onCommand handler.
export const SLASH_COMMANDS = [
  { id: 'compact', names: ['compactar', 'compact'], arg: 'text', icon: 'Shrink' },
  { id: 'context', names: ['contexto', 'context'], icon: 'Gauge' },
  { id: 'new', names: ['nova', 'new', 'nueva', 'limpar', 'clear'], icon: 'Plus' },
  { id: 'model', names: ['modelo', 'model'], arg: 'model', icon: 'Sparkle' },
  { id: 'skills', names: ['skills', 'habilidades'], icon: 'SkillGlyph' },
  { id: 'cost', names: ['custo', 'cost', 'costo'], icon: 'Database' },
  { id: 'history', names: ['historico', 'history', 'historial'], icon: 'History' },
  { id: 'settings', names: ['configuracoes', 'settings', 'ajustes', 'configuracion'], icon: 'Settings' },
  { id: 'help', names: ['ajuda', 'help', 'ayuda'], icon: 'Search' },
]

// Commands that work without the app's handler (see the header).
const ALWAYS_AVAILABLE = ['compact', 'help']

export const normalizeSlash = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

const COMMAND_RE = /^\/(\S+)(?:\s+([\s\S]*))?$/

// "/compactar foque em X" → { cmd, arg: 'foque em X' }; null when the text isn't
// a known command (it then goes to the model as a normal message). Leading and
// trailing whitespace is ignored ("/nova " runs /nova).
export function parseSlashCommand(text) {
  const m = COMMAND_RE.exec(String(text || '').trim())
  if (!m) return null
  const name = normalizeSlash(m[1])
  const cmd = SLASH_COMMANDS.find((c) => c.names.includes(name))
  return cmd ? { cmd, arg: (m[2] || '').trim() } : null
}

// The app parses compaction as "/compactar <instructions>" (lib/compaction.js).
// Any language's name for it is rewritten to that form; null for other text.
export function canonicalCompactText(text) {
  const p = parseSlashCommand(text)
  if (p?.cmd.id !== 'compact') return null
  return p.arg ? `/compactar ${p.arg}` : '/compactar'
}

// Which command ids the menu may offer. `hasHandler`: the app passed onCommand;
// `commands`: the ids it handles (all of them when omitted).
export function availableCommandIds({ hasHandler = false, commands } = {}) {
  const known = new Set(SLASH_COMMANDS.map((c) => c.id))
  const ids = new Set(ALWAYS_AVAILABLE)
  if (hasHandler) for (const id of commands || known) if (known.has(id)) ids.add(id)
  return ids
}

// "/deck-generation faça um deck…" → { skill, rest }: typing a skill's name
// pins it for that message, like picking it in the menu.
export function parseSkillPrefix(text, skills) {
  const m = COMMAND_RE.exec(String(text || '').trim())
  if (!m) return null
  const name = normalizeSlash(m[1])
  const skill = (skills || []).find((s) => s.enabled !== false && normalizeSlash(s.name) === name)
  return skill ? { skill, rest: (m[2] || '').trim() } : null
}

// What the menu lists for the current input, or null when it should be closed.
//   "/"            → every available command + every enabled skill
//   "/com"         → commands/skills whose name (any language) or title matches
//   "/modelo kim"  → the models matching "kim" (second step of /modelo)
export function slashMenuItems(text, { t, available, skills = [], models = [] }) {
  const value = String(text || '')
  if (!value.startsWith('/') || value.includes('\n')) return null
  const space = value.search(/\s/)
  if (space === -1) {
    const q = normalizeSlash(value.slice(1))
    const match = (...fields) => !q || fields.some((f) => normalizeSlash(f).includes(q))
    const commands = SLASH_COMMANDS.filter((c) => available.has(c.id) && match(t(`composer.slash.cmd.${c.id}`), ...c.names)).map(
      (c) => ({
        kind: 'command',
        key: `cmd:${c.id}`,
        cmd: c,
        label: `/${t(`composer.slash.cmd.${c.id}`)}`,
        description: t(`composer.slash.cmd.${c.id}.desc`),
      })
    )
    const skillItems = skills
      .filter((s) => s.enabled !== false && match(s.name, s.title))
      .map((s) => ({ kind: 'skill', key: `skill:${s.id}`, skill: s, label: `/${s.name}`, description: s.title || '' }))
    const items = [...commands, ...skillItems]
    return items.length ? items : null
  }
  const parsed = parseSlashCommand(value.slice(0, space))
  if (parsed?.cmd.arg !== 'model' || !available.has('model')) return null
  const q = normalizeSlash(value.slice(space + 1).trim())
  const items = models
    .filter((m) => !q || normalizeSlash(`${m.label || ''} ${m.provider || ''} ${m.id}`).includes(q))
    .map((m) => ({
      kind: 'model',
      key: `model:${m.id}`,
      model: m,
      label: m.label || m.id,
      description: [m.provider, modelBlurb(m, t)].filter(Boolean).join(' · ') || m.id,
    }))
  return items.length ? items : null
}

// Roving index for menus: arrows wrap, Home/End jump; -1 when empty.
export function nextIndex(current, length, key) {
  if (length <= 0) return -1
  if (key === 'ArrowDown') return (current + 1) % length
  if (key === 'ArrowUp') return (current - 1 + length) % length
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return current
}
