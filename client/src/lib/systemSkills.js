// Localized text of the built-in ("system") skills. The server sends pt-BR text
// (SYSTEM_SKILLS in server/blocks.js); the UI shows the catalog text keyed by the
// skill's name (skills.system.<name>.title / .description), and keeps the server
// text when the catalogs do not know the name (a newer server, a future skill).
// Only a system skill is touched: an authored skill's title is the user's own.
export const SYSTEM_SKILL_NAMES = [
  'deck-generation',
  'spreadsheet-generation',
  'chart-generation',
  'pptx-adjust',
  'image-generation',
  'document-generation',
]

/** `skill` with its title/description in the UI language when it is a known system skill. */
export function localizedSkill(t, skill) {
  if (!skill || !(skill.scope === 'system' || skill.system === true) || !SYSTEM_SKILL_NAMES.includes(skill.name)) return skill
  const pick = (field) => {
    const key = `skills.system.${skill.name}.${field}`
    const v = t(key)
    return v === key ? skill[field] : v
  }
  return { ...skill, title: pick('title'), description: pick('description') }
}
