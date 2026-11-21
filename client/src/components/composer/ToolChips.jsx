import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.jsx'

// Skills pinned for the next message (picked in the "/" menu or typed as
// "/<skill-name>"). They travel with that message only (`skills` in the send
// options; the server forces them in routeSkills) and clear after sending, so
// the chip row is the single place that shows what will be applied.
export default function ToolChips({ skills, onRemove }) {
  const t = useT()
  if (!skills.length) return null
  return (
    <ul className="flex flex-wrap gap-2 px-4 pt-3" aria-label={t('composer.pinnedLabel')}>
      {skills.map((s) => {
        const label = t('composer.unpinSkill', { name: s.name })
        return (
          <li
            key={s.id}
            className="inline-flex items-center gap-1.5 text-label rounded-pill bg-accent-soft text-accent-text pl-2.5 pr-0.5 py-0.5"
          >
            <Icon.SkillGlyph size={13} />
            <span className="max-w-48 truncate">{t('composer.skillChip', { name: s.name })}</span>
            <button
              type="button"
              onClick={() => onRemove(s.id)}
              aria-label={label}
              title={label}
              className="shrink-0 inline-flex items-center justify-center w-11 h-11 md:w-6 md:h-6 rounded-pill hover:bg-surface transition-colors duration-fast"
            >
              <Icon.Close size={12} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
