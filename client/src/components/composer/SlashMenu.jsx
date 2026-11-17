import { useEffect, useRef } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import { SLASH_COMMANDS } from '../../lib/slashCommands.js'

// The "/" suggestions above the message box: the listbox popup of the WAI-ARIA
// combobox pattern (with list autocomplete). Focus never leaves the textarea
// (role=combobox, typing keeps filtering): the composer moves the highlight
// with the arrow keys and points aria-activedescendant at the active option,
// the only one with aria-selected="true". Options are grouped (commands,
// skills, models) so a long list still scans in chunks.

const GROUP_LABEL = { command: 'composer.slash.groupCommands', skill: 'composer.slash.groupSkills', model: 'composer.slash.groupModels' }

export const slashItemId = (listId, i) => `${listId}-option-${i}`

export default function SlashMenu({ id, items, activeIndex, onPick, onHover }) {
  const t = useT()
  const listRef = useRef(null)

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // consecutive items of one kind form a group
  const groups = []
  items.forEach((item, i) => {
    const last = groups[groups.length - 1]
    if (last && last.kind === item.kind) last.items.push([item, i])
    else groups.push({ kind: item.kind, items: [[item, i]] })
  })

  return (
    <div
      id={id}
      ref={listRef}
      role="listbox"
      aria-label={t('composer.slash.menu')}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-card border border-border bg-surface-2 shadow-overlay p-1 z-dropdown animate-fade-in"
    >
      {groups.map((g) => (
        <div key={`${g.kind}:${g.items[0][1]}`} role="group" aria-label={t(GROUP_LABEL[g.kind])}>
          <div aria-hidden="true" className="px-3 pt-2 pb-1 text-caption font-medium uppercase tracking-wide text-faint">
            {t(GROUP_LABEL[g.kind])}
          </div>
          {g.items.map(([item, i]) => {
            const active = i === activeIndex
            const Glyph =
              item.kind === 'command' ? Icon[item.cmd.icon] || Icon.Terminal : item.kind === 'skill' ? Icon.SkillGlyph : Icon.Sparkle
            return (
              <div
                key={item.key}
                id={slashItemId(id, i)}
                role="option"
                aria-selected={active}
                // keep focus (and the caret) in the textarea
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => !active && onHover(i)}
                onClick={() => onPick(item)}
                className={`flex items-start gap-3 min-h-11 md:min-h-9 px-3 py-2 rounded-control cursor-pointer transition-colors duration-fast ${
                  active ? 'bg-surface-3' : 'hover:bg-surface-3'
                }`}
              >
                <Glyph size={16} className={`mt-0.5 shrink-0 ${active ? 'text-accent-text' : 'text-muted'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-fg truncate">{item.label}</span>
                  {item.description && <span className="block text-label text-muted truncate">{item.description}</span>}
                </span>
                {active && (
                  <kbd aria-hidden="true" className="hidden md:inline self-center text-caption text-faint font-sans">
                    ↵
                  </kbd>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// /ajuda: the commands that work here and the composer's keyboard model.
// A labelled region (not a dialog: nothing is blocked), closed by Esc or ×.
export function SlashHelp({ available, onClose }) {
  const t = useT()
  const shortcuts = ['enter', 'shiftEnter', 'slash', 'esc', 'attach']
  return (
    <section
      aria-label={t('composer.slash.help.title')}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-y-auto rounded-card border border-border bg-surface-2 shadow-overlay p-4 z-dropdown animate-fade-in"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-title font-semibold text-fg">{t('composer.slash.help.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('composer.slash.help.close')}
          title={t('composer.slash.help.close')}
          className="inline-flex items-center justify-center w-11 h-11 md:w-8 md:h-8 rounded-control text-muted hover:text-fg hover:bg-surface-3 transition-colors duration-fast"
        >
          <Icon.Close size={14} />
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-label">
        {SLASH_COMMANDS.filter((c) => available.has(c.id)).map((c) => (
          <div key={c.id} className="min-w-0">
            <dt className="font-mono text-fg">/{t(`composer.slash.cmd.${c.id}`)}</dt>
            <dd className="text-muted">{t(`composer.slash.cmd.${c.id}.desc`)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-4 mb-2 text-label font-medium uppercase tracking-wide text-faint">{t('composer.slash.help.shortcuts')}</h3>
      <ul className="space-y-1 text-label text-muted">
        {shortcuts.map((k) => (
          <li key={k}>{t(`composer.slash.help.${k}`)}</li>
        ))}
      </ul>
    </section>
  )
}
