import { useT } from '../lib/i18n.tsx'
import { Switch, SaveStatus } from './SettingsControls.tsx'

// Memory group of the admin Tools tab (W3-3): the org-wide switch for
// app_tool_policy key `memory`. A missing row means ON (default-on), which is
// what the user-facing notice also says. Off = no learning, no use in answers,
// no listing; users can still delete what is stored. The parent owns the
// optimistic toggle and reverts it when the save fails; this card only shows
// the state it is handed and says so when the save failed.
interface MemoryAdminCardProps {
  on: boolean
  onToggle: (next: boolean) => void
  saveState?: 'idle' | 'saving' | 'saved' | 'error' | null
}

export default function MemoryAdminCard({ on, onToggle, saveState }: MemoryAdminCardProps) {
  const t = useT()
  const nameId = 'tool-group-memory'
  return (
    <li className="px-4 py-3">
      <section aria-labelledby={nameId} data-testid="memory-admin-card">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span id={nameId} className="block text-body font-medium">
              {t('toolsAdmin.memory.name')}
            </span>
            <span id={`${nameId}-desc`} className="block text-label text-[var(--muted)] mt-0.5">
              {t('toolsAdmin.memory.desc')}
            </span>
          </span>
          {saveState && saveState !== 'error' && <SaveStatus state={saveState} />}
          <Switch checked={on} onChange={onToggle} labelledBy={nameId} describedBy={`${nameId}-desc`} disabled={saveState === 'saving'} />
        </div>
        {saveState === 'error' && <SaveStatus state="error" error={t('toolsAdmin.memory.saveFailed')} className="mt-2" />}
      </section>
    </li>
  )
}
