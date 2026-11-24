import type { ReactNode } from 'react'
import { useT } from '../../lib/i18n.tsx'
import * as Icon from '../Icons.tsx'

// Tool rail of the HTML slide editor: Select, Text, Rectangle, Oval, Line,
// Arrow, Image, as a vertical rail beside the canvas (a horizontal strip on
// phones). Undo/Redo live in the panel header. Picking a shape
// tool arms drag-to-create on the canvas (the iframe runtime draws the box and
// inserts the element); Image opens a file picker and drops the picture in.
// `tool` is the armed tool; clicking the active one disarms back to select.

interface ToolBtnProps {
  active?: boolean
  title: string
  onClick: () => void
  children?: ReactNode
  disabled?: boolean
}

function ToolBtn({ active, title, onClick, children, disabled }: ToolBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : !!active}
      disabled={disabled}
      className={`w-8 h-8 max-md:w-11 max-md:h-11 rounded-control grid place-items-center transition-colors duration-fast disabled:text-disabled-text ${
        active ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-sunk hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

// small glyphs to match the Claude Design toolbar
const RectGlyph = () => <span className="w-3.5 h-3.5 rounded-sm border-2 border-current" />
const OvalGlyph = () => <span className="w-3.5 h-3.5 rounded-full border-2 border-current" />
const LineGlyph = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="13" x2="13" y2="3" />
  </svg>
)
const ArrowGlyph = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
    <line x1="3" y1="13" x2="13" y2="3" />
    <path d="M7 3h6v6" />
  </svg>
)
const TextGlyph = () => <span className="text-title font-bold leading-none" aria-hidden>T</span>

interface HtmlEditToolbarProps {
  tool: string
  onTool: (tool: string) => void
  onImage(dataUrl: string | ArrayBuffer | null): void // method syntax: callers may take just a string
}

export default function HtmlEditToolbar({ tool, onTool, onImage }: HtmlEditToolbarProps) {
  const t = useT()
  const pick = (name: string) => onTool(tool === name ? 'select' : name)
  return (
    <div role="toolbar" aria-label={t('deckStudio.htmlEdit.toolbar')} data-edit-rail className="flex md:flex-col items-center gap-1 rounded-card border border-border bg-raised shadow-raised p-1">
      <ToolBtn active={tool === 'select'} title={t('deckStudio.htmlEdit.tool.select')} onClick={() => onTool('select')}>
        <Icon.Pencil size={15} />
      </ToolBtn>
      <span role="separator" aria-orientation="vertical" className="w-px h-5 md:w-5 md:h-px bg-border mx-0.5 md:mx-0 md:my-0.5" />
      <ToolBtn active={tool === 'text'} title={t('deckStudio.htmlEdit.tool.text')} onClick={() => pick('text')}>
        <TextGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'rect'} title={t('deckStudio.htmlEdit.tool.rect')} onClick={() => pick('rect')}>
        <RectGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'oval'} title={t('deckStudio.htmlEdit.tool.oval')} onClick={() => pick('oval')}>
        <OvalGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'line'} title={t('deckStudio.htmlEdit.tool.line')} onClick={() => pick('line')}>
        <LineGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'arrow'} title={t('deckStudio.htmlEdit.tool.arrow')} onClick={() => pick('arrow')}>
        <ArrowGlyph />
      </ToolBtn>
      <label className="w-8 h-8 max-md:w-11 max-md:h-11 rounded-control grid place-items-center text-muted hover:bg-sunk hover:text-fg cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-[var(--focus-ring)]" title={t('deckStudio.htmlEdit.tool.image')}>
        <Icon.Image size={15} aria-hidden />
        <input
          aria-label={t('deckStudio.htmlEdit.tool.image')}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            const r = new FileReader()
            r.onload = () => onImage(r.result)
            r.readAsDataURL(f)
            e.target.value = ''
          }}
        />
      </label>
    </div>
  )
}
