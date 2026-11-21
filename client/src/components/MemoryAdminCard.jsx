import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.tsx'
import { Switch, SaveStatus } from './SettingsControls.jsx'

// Memory group of the admin Tools tab (W3-3): the org-wide switch for
// app_tool_policy key `memory`. A missing row means ON (default-on), which is
// what the user-facing notice also says. Off = no learning, no use in answers,
// no listing; users can still delete what is stored. The parent owns the
// optimistic toggle and reverts it when the save fails; this card only shows
// the state it is handed and says so when the save failed.
export default function MemoryAdminCard({ on, onToggle, saveState }) {
  const t = useT()
  const nameId = 'tool-group-memory'
  return (
    <li
      className={`rounded-card border p-3 transition duration-fast ${
        on ? 'border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'
      }`}
    >
      <section aria-labelledby={nameId} data-testid="memory-admin-card">
        <div className="flex items-center gap-3">
          <Icon.Sparkle size={18} className="shrink-0 text-[var(--accent)]" aria-hidden />
          <span className="min-w-0 flex-1">
            <span id={nameId} className="block text-body font-semibold">
              {t('toolsAdmin.memory.name')}
            </span>
            <span id={`${nameId}-desc`} className="block text-label text-[var(--muted)] mt-0.5">
              {t('toolsAdmin.memory.desc')}
            </span>
          </span>
          {saveState && saveState !== 'error' && <SaveStatus state={saveState} />}
          <Switch checked={on} onChange={onToggle} labelledBy={nameId} describedBy={`${nameId}-desc`} disabled={saveState === 'saving'} />
        </div>
        {saveState === 'error' && <SaveStatus state="error" error={t('toolsAdmin.memory.saveFailed')} className="mt-2 pl-[30px]" />}
      </section>
    </li>
  )
}
