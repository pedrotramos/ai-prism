import { useId, useMemo, useRef } from 'react'
import * as Icon from '../Icons.tsx'
import { ProviderMark } from '../ProviderMark.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { useModalDialog } from '../../lib/useModalDialog.ts'
import { dangerBtn, ghostBtn, iconBtn, primaryBtn } from '../projects/ui.tsx'
import AgentRunHistory from './AgentRunHistory.tsx'
import { chipKey, errorKey, formatInstant, rowActions, selectableTools } from './agentsLogic.ts'
import type { AgentRow, ToolOptions } from './agentsLogic.ts'

// The detail drawer of one agent (ui-revamp W1-8): what it does, what it may use, when it runs, and every action
// the old row offered. A modal: focus moves in, Tab wraps, Escape closes, focus goes back to the card that opened it.

interface ModelOption {
  id: string
  label: string
  provider?: string | null
}
interface Props {
  agent: AgentRow
  models: ModelOption[]
  toolOptions: ToolOptions | null
  busy: boolean
  queued: boolean
  historyOpen: boolean
  tz: string
  now: number
  onClose: () => void
  onSubmit: () => void
  onEnable: () => void
  onDisable: () => void
  onRun: () => void
  onToggleHistory: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenChat: (sessionId: string) => void
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <h3 id={id} className="text-label font-semibold text-[var(--text)]">
        {title}
      </h3>
      {children}
    </section>
  )
}

export default function AgentDrawer({ agent: a, models, toolOptions, busy, queued, historyOpen, tz, now, onClose, onSubmit, onEnable, onDisable, onRun, onToggleHistory, onEdit, onDelete, onOpenChat }: Props) {
  const { t, locale } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useModalDialog(ref, { onClose, initialFocus: (el) => el.querySelector<HTMLElement>('[data-drawer-close]') })

  const can = rowActions(a, now)
  const name = a.name || t('agents.unnamed')
  const label = (key: string) => t('agents.action.aria', { action: t(key), name })
  const model = models.find((m) => m.id === a.definition.model) ?? { id: a.definition.model, label: a.definition.model }
  const toolLabels = useMemo(() => {
    const known = new Map(selectableTools(toolOptions).map((o) => [o.ref, o.labelIsKey ? t(o.label) : o.label]))
    return a.definition.tools.map((r) => known.get(r) ?? r)
  }, [toolOptions, a.definition.tools, t])
  const sched = a.definition.schedule

  return (
    <div className="fixed inset-0 z-drawer flex justify-end bg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="h-full w-full sm:w-[28rem] flex flex-col bg-raised border-l border-[var(--border)] shadow-overlay animate-slide-in-right">
        <header className="shrink-0 flex items-start gap-3 px-5 py-4 border-b border-[var(--border)]">
          <span aria-hidden className="grid place-items-center w-9 h-9 shrink-0 rounded-control bg-accent-soft text-[var(--accent-text)]">
            <Icon.Sparkle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-body font-semibold text-[var(--text)] truncate" title={name}>
              {name}
            </h2>
            <span className="mt-0.5 inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">{t(chipKey(a))}</span>
          </div>
          <button type="button" data-drawer-close onClick={onClose} className={iconBtn} aria-label={t('common.close')} title={t('common.close')}>
            <Icon.Close size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {a.description && <p className="text-body text-[var(--text)]">{a.description}</p>}

          <Block title={t('agents.drawer.prompt')}>
            <p className="whitespace-pre-wrap break-words rounded-control bg-[var(--surface-2)] px-3 py-2 text-label text-[var(--text)] max-h-48 overflow-y-auto">{a.definition.prompt}</p>
          </Block>
          {a.definition.instructions && (
            <Block title={t('agents.drawer.instructions')}>
              <p className="whitespace-pre-wrap break-words rounded-control bg-[var(--surface-2)] px-3 py-2 text-label text-[var(--text)] max-h-48 overflow-y-auto">{a.definition.instructions}</p>
            </Block>
          )}

          <Block title={t('agents.drawer.model')}>
            <p className="flex items-center gap-2 text-label text-[var(--text)]">
              <ProviderMark model={model} size={18} className="shrink-0 text-[var(--muted)]" />
              <span className="min-w-0 truncate">{model.label}</span>
            </p>
          </Block>

          <Block title={t('agents.drawer.tools')}>
            {toolLabels.length === 0 ? (
              <p className="text-label text-[var(--muted)]">{t('agents.drawer.noTools')}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {toolLabels.map((l) => (
                  <li key={l} className="rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-medium text-[var(--text)]">
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title={t('agents.drawer.schedule')}>
            <ul className="text-label text-[var(--muted)] space-y-0.5">
              {sched ? <li>{t(`agents.schedule.${sched.freq}`)}</li> : <li>{t('agents.row.noSchedule')}</li>}
              {a.enabled && a.nextRunAt && <li>{t('agents.row.nextRun', { when: formatInstant(a.nextRunAt, tz, locale) })}</li>}
              {a.lastRunAt && <li>{t('agents.row.lastRun', { when: formatInstant(a.lastRunAt, tz, locale) })}</li>}
              {a.status === 'approved' && a.approvalExpiresAt && (can.run ? <li>{t('agents.row.expires', { when: formatInstant(a.approvalExpiresAt, tz, locale) })}</li> : <li>{t('agents.row.expired')}</li>)}
              {a.decisionReason && (a.status === 'rejected' || a.status === 'revoked') && <li>{t('agents.row.reason', { reason: a.decisionReason })}</li>}
              {a.disabledReason && !a.enabled && <li>{t('agents.row.disabledReason', { reason: t(errorKey(a.disabledReason)) })}</li>}
            </ul>
          </Block>

          <Block title={t('agents.drawer.permissions')}>
            <p className="text-label text-[var(--muted)]">{t('agents.runsAsNote')}</p>
          </Block>

          {queued && (
            <p role="status" className="text-label text-[var(--success)]">
              {t('agents.run.queued')}
            </p>
          )}
          {historyOpen && <AgentRunHistory agentId={a.id} agentName={name} onOpenChat={onOpenChat} onClose={onToggleHistory} />}
        </div>

        <footer className="shrink-0 flex flex-wrap gap-2 px-5 py-3 border-t border-[var(--border)]">
          {can.submit && (
            <button type="button" className={primaryBtn} disabled={busy} aria-label={label('agents.action.submit')} onClick={onSubmit}>
              {t('agents.action.submit')}
            </button>
          )}
          {can.enable && (
            <button type="button" className={primaryBtn} disabled={busy} aria-label={label('agents.action.enable')} onClick={onEnable}>
              {t('agents.action.enable')}
            </button>
          )}
          {can.disable && (
            <button type="button" className={ghostBtn} disabled={busy} aria-label={label('agents.action.disable')} onClick={onDisable}>
              {t('agents.action.disable')}
            </button>
          )}
          {can.run && (
            <button type="button" className={ghostBtn} disabled={busy} aria-label={label('agents.action.run')} onClick={onRun}>
              <Icon.Play size={14} aria-hidden /> {t('agents.action.run')}
            </button>
          )}
          <button type="button" className={ghostBtn} aria-label={label('agents.action.history')} aria-expanded={historyOpen} onClick={onToggleHistory}>
            {t('agents.action.history')}
          </button>
          <button type="button" className={ghostBtn} disabled={busy} aria-label={label('agents.action.edit')} onClick={onEdit}>
            <Icon.Pencil size={14} aria-hidden /> {t('agents.action.edit')}
          </button>
          <button type="button" className={`${dangerBtn} sm:ml-auto`} disabled={busy} aria-label={label('agents.action.delete')} onClick={onDelete}>
            <Icon.Trash size={14} aria-hidden /> {t('agents.action.delete')}
          </button>
        </footer>
      </div>
    </div>
  )
}
