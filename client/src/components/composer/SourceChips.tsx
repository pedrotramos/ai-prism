import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import type { TFn } from '../../lib/tFn.ts'
import { refKey } from '../ToolsPicker.tsx'
import type { ToolRef } from '../ToolsPicker.tsx'

// The sources picked in the tools popover (Genie Agents, Vector Search indexes,
// Unity Catalog functions) as removable chips above the message box. Removing
// a chip is the same change as turning it off in the popover: the parent saves
// the new list on the open chat.
const SOURCE_KINDS = ['genie', 'vector-search', 'uc']

const nameOf = (t: ToolRef) => t.title || t.indexName || t.fullName || ''

export default function SourceChips({ tools, onChange, disabled }: { tools: ToolRef[]; onChange: (tools: ToolRef[]) => void; disabled?: boolean }) {
  const t: TFn = useT()
  const sources = tools.filter((x) => SOURCE_KINDS.includes(x.kind) && !x.off)
  if (!sources.length) return null
  return (
    <ul className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label={t('composer.sources.label')}>
      {sources.map((src) => {
        const name = nameOf(src)
        const label = t('composer.sources.remove', { name })
        const Glyph = src.kind === 'vector-search' ? Icon.Search : src.kind === 'uc' ? Icon.Wrench : Icon.Database
        return (
          <li key={refKey(src)} className="inline-flex items-center gap-1.5 text-label rounded-control bg-accent-soft text-accent-text pl-2 pr-0.5 py-0.5 max-w-full">
            <Glyph size={13} className="shrink-0" />
            <span className="max-w-56 truncate">{name}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(tools.filter((x) => refKey(x) !== refKey(src)))}
              aria-label={label}
              title={label}
              className="shrink-0 inline-flex items-center justify-center w-11 h-11 md:w-6 md:h-6 rounded-control hover:bg-raised transition-colors duration-fast disabled:opacity-50"
            >
              <Icon.Close size={12} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
