import { useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n.jsx'

// Right-click context menu for the HTML slide editor — Claude Design parity
// (Cut / Copy / Paste / Duplicate / Delete / Group / Ungroup / Wrap in flex),
// positioned at the click point. `menu` = { x, y, paths } | null. Actions are
// dispatched by key; the parent maps them to clipboard/ops. Closes on outside
// click, Escape, or scroll.
export default function HtmlEditContextMenu({ menu, canPaste, onAction, onClose }) {
  const t = useT()
  const ref = useRef(null)
  useEffect(() => {
    if (!menu) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu, onClose])
  if (!menu) return null
  const multi = (menu.paths || []).length > 1
  const items = [
    { key: 'cut', label: t('deckStudio.htmlEdit.cut'), shortcut: '⌘X' },
    { key: 'copy', label: t('deckStudio.htmlEdit.copy'), shortcut: '⌘C' },
    { key: 'paste', label: t('deckStudio.htmlEdit.paste'), shortcut: '⌘V', disabled: !canPaste },
    { key: 'duplicate', label: t('deckStudio.htmlEdit.duplicate'), shortcut: '⌘D' },
    { key: 'delete', label: t('common.delete'), shortcut: '⌫' },
    { sep: true },
    { key: 'group', label: t('deckStudio.htmlEdit.group'), shortcut: '⌘G', disabled: !multi },
    { key: 'ungroup', label: t('deckStudio.htmlEdit.ungroup'), shortcut: '⇧⌘G' },
    { key: 'wrapFlex', label: t('deckStudio.htmlEdit.wrapFlex') },
    { sep: true },
    { key: 'front', label: t('deckStudio.htmlEdit.toFront') },
    { key: 'back', label: t('deckStudio.htmlEdit.toBack') },
  ]
  // keep on screen
  const x = Math.min(menu.x, window.innerWidth - 210)
  const y = Math.min(menu.y, window.innerHeight - items.length * 30 - 16)
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-popover w-52 rounded-card border border-border bg-surface shadow-overlay py-1.5 motion-safe:animate-fade-in text-body"
      /* data */ style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} role="separator" className="my-1 border-t border-border" />
        ) : (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onAction(it.key)
              onClose()
            }}
            className="w-full min-h-8 flex items-center justify-between px-3 py-1.5 text-left text-fg hover:bg-accent-soft hover:text-accent-text disabled:text-disabled-text disabled:hover:bg-transparent"
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="text-caption text-faint">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}
