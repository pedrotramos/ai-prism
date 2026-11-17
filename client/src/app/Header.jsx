import CostMeter from '../components/CostMeter.jsx'
import ModelPicker from '../components/ModelPicker.jsx'
import ToolsPicker from '../components/ToolsPicker.jsx'
import * as Icon from '../components/Icons.jsx'
import { useT } from '../lib/i18n.jsx'

// The chat column's top bar. It has to fit a 390 px phone: no control shrinks
// below its target size. On a touch screen (coarse pointer) every control is a
// 44 x 44 px target: menu, model, Tools, cost meter and Settings. With a mouse,
// Tools and the cost meter stay at 36 px. The cost meter collapses to its icon
// below `sm`, and the model picker is the one element that gives way (its label
// truncates).
export default function Header({ cfg, s, layout, onOpenMenu, routeKey }) {
  const t = useT()
  const focused = layout.focused
  return (
    // relative z-dropdown: backdrop-blur makes this header a stacking context;
    // without an explicit z-index its popovers get painted UNDER later DOM
    // siblings (messages, Deck Studio)
    <header className="relative z-dropdown h-14 shrink-0 flex items-center gap-2 md:gap-3 px-2 md:px-5 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
      <button
        type="button"
        onClick={onOpenMenu}
        className="md:hidden shrink-0 grid place-items-center min-w-11 min-h-11 rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)] transition duration-fast"
        aria-label={t('shell.openMenu')}
        title={t('shell.openMenu')}
      >
        <Icon.Menu size={20} />
      </button>
      <div className="min-w-0">
        <ModelPicker models={cfg.models} value={cfg.model} onChange={(id) => {
            cfg.setModel(id)
            s.patchCurrent({ model: id })
          }} disabled={s.streaming} />
      </div>
      <ToolsPicker
        modelSupportsTools={cfg.models.find((m) => m.id === cfg.model)?.tools !== false}
        enabledTools={s.enabledTools}
        onChange={s.changeTools}
        disabled={s.streaming}
        toolPolicy={cfg.toolPolicy}
        onOpenMcpSettings={() => cfg.openSettings('mcp')}
      />
      {/* absolutely centered on the header (= visual center of the chat
          column) — as a flex child it would center in the leftover space
          right of the pickers and sit visibly off-center */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 max-w-[36%] text-body font-medium truncate text-[var(--muted)] pointer-events-none hidden ${focused ? '' : 'md:block'}`}
      >
        {s.currentTitle || ''}
      </div>
      <div className="ml-auto shrink-0">
        <CostMeter sessionId={s.currentId} streaming={s.streaming} compact={focused} closeKey={routeKey} />
      </div>
      <button
        type="button"
        onClick={() => cfg.openSettings()}
        className="shrink-0 grid place-items-center min-w-11 min-h-11 rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)] transition duration-fast"
        aria-label={t('settings.title')}
        title={t('settings.title')}
      >
        <Icon.Settings size={19} />
      </button>
    </header>
  )
}
