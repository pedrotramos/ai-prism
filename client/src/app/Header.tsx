import type { ReactNode } from 'react'
import CostMeter from '../components/CostMeter.tsx'
import TemporaryBadge from '../components/TemporaryBadge.tsx'
import * as Icon from '../components/Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import type { SessionsState } from './hooks/useSessions.ts'
import type { SettingsState } from './hooks/useSettingsState.ts'
import type { DeckFocusState } from './hooks/useDeckFocus.ts'

// The chat column's top bar (54 px): breadcrumb and title on the left; on the
// right the cost pill, optional actions, the artifact-panel toggle and
// Settings. The model and Tools pickers live in the composer, not here. It has
// to fit a 390 px phone: on a touch screen (coarse pointer) every control is a
// 44 x 44 px target, the breadcrumb hides below the 760 px breakpoint and the
// cost pill collapses to its icon below `sm`.
//
// Everything beyond the original props is optional and inert until a caller
// passes it: `title` and `costMeter` default to the open conversation's own.
export interface TopbarProps {
  cfg: SettingsState
  s: SessionsState
  layout: DeckFocusState
  onOpenMenu: () => void
  routeKey: string
  /** overrides the open conversation's title */
  title?: string
  /** the path to the title, e.g. the project; the last item with an onClick is a button */
  crumbs?: Array<{ label: string; onClick?: () => void }>
  /** replaces the default cost pill */
  costMeter?: ReactNode
  /** shows the artifact-panel toggle; null or absent hides it */
  panelToggle?: { open: boolean; onToggle: () => void } | null
  /** extra controls, left of the cost pill */
  actions?: ReactNode
}

const ghostBtn =
  'shrink-0 grid place-items-center min-w-9 min-h-9 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:min-h-11 rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-[var(--text)] transition duration-fast'

function PanelRight({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  )
}

export default function Header({ cfg, s, layout, onOpenMenu, routeKey, title, crumbs, costMeter, panelToggle, actions }: TopbarProps) {
  const t = useT()
  const focused = layout.focused
  const heading = title ?? s.currentTitle ?? ''
  return (
    // relative z-dropdown: backdrop-blur makes this header a stacking context;
    // without an explicit z-index its popovers get painted UNDER later DOM
    // siblings (messages, Deck Studio)
    <header className="relative z-dropdown h-[var(--topbar-h)] shrink-0 flex items-center gap-2 px-2 min-[761px]:px-3 border-b border-[var(--border-soft)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={onOpenMenu}
        className="min-[761px]:hidden shrink-0 grid place-items-center min-w-11 min-h-11 rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)] transition duration-fast"
        aria-label={t('shell.openMenu')}
        title={t('shell.openMenu')}
      >
        <Icon.Menu size={20} />
      </button>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label={t('shell.breadcrumb')} className={`hidden ${focused ? '' : 'min-[761px]:flex'} items-center gap-2 min-w-0 shrink text-body text-[var(--muted)]`}>
            {crumbs.map((c, i) => (
              <span key={`${i}-${c.label}`} className="flex items-center gap-2 min-w-0">
                {c.onClick ? (
                  <button type="button" onClick={c.onClick} className="truncate rounded-badge hover:text-[var(--text)] max-w-40">
                    {c.label}
                  </button>
                ) : (
                  <span className="truncate max-w-40">{c.label}</span>
                )}
                <span aria-hidden className="text-[var(--faint)]">
                  /
                </span>
              </span>
            ))}
          </nav>
        )}
        {/* a div, not a heading: the views below carry their own headings and axe heading-order must stay at 0 */}
        {heading && <div className="min-w-0 truncate text-body font-semibold text-[var(--text)]">{heading}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {s.currentEphemeral && <TemporaryBadge compact />}
        {actions}
        {costMeter ?? <CostMeter sessionId={s.currentId} streaming={s.streaming} compact={focused} closeKey={routeKey} />}
        {panelToggle && (
          <button
            type="button"
            onClick={panelToggle.onToggle}
            aria-pressed={panelToggle.open}
            className={`${ghostBtn} ${panelToggle.open ? 'bg-[var(--accent-soft)] !text-[var(--accent-text)]' : ''}`}
            aria-label={panelToggle.open ? t('shell.panelHide') : t('shell.panelShow')}
            title={panelToggle.open ? t('shell.panelHide') : t('shell.panelShow')}
          >
            <PanelRight />
          </button>
        )}
        <button type="button" onClick={() => cfg.openSettings()} className={ghostBtn} aria-label={t('settings.title')} title={t('settings.title')}>
          <Icon.Settings size={19} />
        </button>
      </div>
    </header>
  )
}
