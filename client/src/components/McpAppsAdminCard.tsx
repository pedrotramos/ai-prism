import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n.tsx'
import { getJSON, putJSON } from '../api.ts'
import { Switch, SaveStatus } from './SettingsControls.tsx'

// MCP Apps group of the admin Tools tab (W4-5): the org-wide switch (app_settings.mcp_apps_enabled, off by default, audited). When the
// operator set MCP_APPS_DISABLED=1 the switch is shown but says it has no effect. Design: docs/mcp-apps.md.
export default function McpAppsAdminCard() {
  const t = useT()
  const [on, setOn] = useState(false)
  const [envOff, setEnvOff] = useState(false)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const nameId = 'tool-group-mcp-apps'

  useEffect(() => {
    let live = true
    getJSON<{ enabled?: boolean; envDisabled?: boolean }>('/api/admin/mcp-apps/settings').then(
      (s) => {
        if (!live) return
        setOn(s.enabled === true)
        setEnvOff(s.envDisabled === true)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [])

  const toggle = (next: boolean) => {
    const prev = on
    setOn(next)
    setState('saving')
    putJSON<{ enabled?: boolean }>('/api/admin/mcp-apps/settings', { enabled: next }).then(
      () => setState('saved'),
      () => {
        setOn(prev)
        setState('error')
      }
    )
  }

  return (
    <li className="px-4 py-3">
      <section aria-labelledby={nameId} data-testid="mcp-apps-admin-card">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span id={nameId} className="block text-body font-medium">
              {t('mcpApps.admin.name')}
            </span>
            <span id={`${nameId}-desc`} className="block text-label text-[var(--muted)] mt-0.5">
              {t('mcpApps.admin.desc')}
            </span>
          </span>
          {state !== 'idle' && state !== 'error' && <SaveStatus state={state} />}
          <Switch checked={on} onChange={toggle} labelledBy={nameId} describedBy={`${nameId}-desc`} disabled={state === 'saving'} />
        </div>
        {envOff && <p className="mt-2 text-label text-[var(--warning)]">{t('mcpApps.admin.envOff')}</p>}
        {state === 'error' && <SaveStatus state="error" error={t('mcpApps.admin.saveFailed')} className="mt-2" />}
      </section>
    </li>
  )
}
