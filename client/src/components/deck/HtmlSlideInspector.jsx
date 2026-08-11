import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../lib/i18n.jsx'
import { zoneFromRatio, canDrop } from '../../lib/treeDnd.js'
import * as Icon from '../Icons.jsx'

// Ancestor paths of a child-index path: "1.0.2" → ["", "1", "1.0"]. The root is
// "" and every prefix in between. Used to auto-expand the tree down to a node
// selected on the canvas so its row is actually visible (item 2).
function ancestorPaths(path) {
  const segs = String(path).split('.')
  const out = ['']
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('.'))
  return out
}

// Properties panel + DOM layer tree for a pure-HTML slide — the Claude Design
// "Pro" edit surface, reproduced. A nested, selectable tree of the slide's real
// DOM nodes on top; below it a properties panel that edits the SELECTED node's
// inline style / text / attributes (Text · Sizing · Position · Padding · Margin
// · Appearance). The DOM is the model — no separate semantic tree. Selection is
// a child-index path (e.g. "1.0.2"), the exact scheme the in-iframe runtime uses,
// so tree, canvas ring and panel all address the same node(s).
//
// Multi-selection collapses the panel to a batch-ops strip (align/group/style),
// mirroring Claude Design. Style edits push to the iframe imperatively; the live
// `info` snapshot drives shown values.

const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']

function toHex(c) {
  if (!c) return '#000000'
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c)
  if (!m) return '#000000'
  return '#' + [m[1], m[2], m[3]].map((v) => Math.round(parseFloat(v)).toString(16).padStart(2, '0')).join('')
}
function hasBg(c) {
  if (!c || c === 'transparent' || c === 'none') return false
  const m = /rgba?\([^)]*?,\s*([\d.]+)\)/.exec(c)
  return !(m && parseFloat(m[1]) === 0)
}

// ---- DOM layer tree ---------------------------------------------------------
const TAG_LABEL = {
  section: 'Slide', h1: 'Título', h2: 'Título', h3: 'Subtítulo', h4: 'Subtítulo',
  p: 'Texto', span: 'Texto', ul: 'Lista', ol: 'Lista', li: 'Item',
  svg: 'Gráfico', img: 'Imagem', table: 'Tabela', tr: 'Linha', td: 'Célula', th: 'Célula',
}
function labelFor(el) {
  const tag = el.tagName.toLowerCase()
  const base = TAG_LABEL[tag]
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
  if ((tag === 'div' || tag === 'section') && !base) {
    const cls = el.getAttribute('class') || ''
    if (/card/i.test(cls)) return 'Card'
    const disp = el.getAttribute('style') || ''
    if (/flex|grid/i.test(disp) || /grid|row|col|flex/i.test(cls)) return 'Grupo'
    return 'Bloco'
  }
  if (base && text && text.length <= 42 && /^(h1|h2|h3|h4|p|span|li|td|th)$/.test(tag)) {
    return `${base} · ${text.slice(0, 34)}${text.length > 34 ? '…' : ''}`
  }
  return base || tag
}
function buildTree(html) {
  if (!html) return null
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const root = doc.body.firstElementChild
  if (!root) return null
  const walk = (el, path) => {
    const children = []
    let i = 0
    for (const c of el.children) {
      children.push(walk(c, path === '' ? String(i) : `${path}.${i}`))
      i++
    }
    return { tag: el.tagName.toLowerCase(), path, label: labelFor(el), children }
  }
  return walk(root, '')
}

// Which third of a row the cursor is over → where a drop would land. Delegates
// the zone decision to the pure helper so the tree and the QA harness agree.
function dropZone(e, el, isRoot) {
  const r = el.getBoundingClientRect()
  return zoneFromRatio((e.clientY - r.top) / (r.height || 1), isRoot)
}

function TreeRow({ node, depth, selectedPaths, onSelect, expanded, toggle, dnd }) {
  const isSel = selectedPaths.includes(node.path)
  const hasKids = node.children.length > 0
  const isOpen = expanded.has(node.path)
  const isRoot = node.path === ''
  // When this row becomes the (single) selection — e.g. the user clicked the
  // element on the canvas — scroll it into view inside the tree's scroll box so
  // the highlight is never off-screen (item 2). Only the primary selected row
  // scrolls; multi-selection doesn't fight over the viewport.
  const rowRef = useRef(null)
  useEffect(() => {
    if (isSel && selectedPaths[0] === node.path) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isSel, selectedPaths, node.path])
  // Drop feedback: this row is the current target and where the drop lands.
  const isTarget = dnd?.over?.path === node.path
  const zone = isTarget ? dnd.over.zone : null
  return (
    <div>
      <div
        ref={rowRef}
        draggable={!isRoot}
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.path) // Firefox needs a payload
          dnd?.onStart(node.path)
        }}
        onDragEnd={() => dnd?.onEnd()}
        onDragOver={(e) => {
          if (!dnd?.dragging) return
          // can't drop a node into itself or its own subtree — the runtime
          // rejects it too, but suppressing the target avoids a misleading hint.
          if (!canDrop(dnd.dragging, node.path)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          dnd.onOver(node.path, dropZone(e, e.currentTarget, isRoot))
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          dnd?.onDrop(node.path)
        }}
        onClick={(e) => onSelect(node.path, e.shiftKey || e.metaKey || e.ctrlKey)}
        className={`group/row relative flex items-center gap-1.5 h-7 rounded-md pr-1.5 cursor-pointer select-none transition-colors ${
          isSel ? 'bg-[var(--accent-soft)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
        } ${zone === 'inside' ? 'ring-1 ring-inset ring-[var(--accent)]' : ''}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
      >
        {zone === 'before' && <span className="pointer-events-none absolute left-1 right-1 -top-px h-0.5 rounded bg-[var(--accent)]" />}
        {zone === 'after' && <span className="pointer-events-none absolute left-1 right-1 -bottom-px h-0.5 rounded bg-[var(--accent)]" />}
        {hasKids ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggle(node.path)
            }}
            className="shrink-0 w-4 h-4 grid place-items-center text-[var(--faint)] hover:text-[var(--text)]"
          >
            <Icon.ChevronRight size={10} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="shrink-0 w-4" />
        )}
        <span className="flex-1 min-w-0 truncate text-[11px]" title={node.label}>
          {node.label}
        </span>
        <span className="shrink-0 text-[9px] text-[var(--faint)] font-mono hidden lg:block">{node.tag}</span>
      </div>
      {hasKids && isOpen && (
        <div>
          {node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} selectedPaths={selectedPaths} onSelect={onSelect} expanded={expanded} toggle={toggle} dnd={dnd} />
          ))}
        </div>
      )}
    </div>
  )
}

// The override marker to the left of a property label. Claude Design parity:
// a small dot when the property is set on THIS element, which becomes an × on
// hover to unset it (falls back to the ← inherited value). No override → an
// inert placeholder that keeps labels aligned. Replaces the old trailing eraser.
function Marker({ dot, onUnset }) {
  if (dot && onUnset) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          onUnset()
        }}
        title="Remover (voltar ao herdado)"
        className="group/mk w-3 h-3 shrink-0 grid place-items-center -ml-0.5"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] group-hover/mk:hidden" />
        <svg viewBox="0 0 12 12" width="10" height="10" className="hidden group-hover/mk:block text-[var(--accent)]" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    )
  }
  return <span className="w-3 shrink-0" aria-hidden />
}

// A property row. Label sits at the TOP-left (not vertically centered against a
// multi-line control), matching Claude Design; the control area fills the rest
// and can stack (`column`) for wide segmented controls that would overflow.
function Field({ label, children, dot, onUnset, column = false }) {
  return (
    <div className={`flex gap-2 min-h-8 ${column ? 'flex-col !gap-1' : 'items-start'}`}>
      <label className={`text-[11px] text-[var(--muted)] flex items-center gap-1 pt-1.5 ${column ? '' : 'w-[4.5rem] shrink-0'}`}>
        <Marker dot={dot} onUnset={onUnset} />
        {label}
      </label>
      <div className={`flex items-center gap-1.5 min-w-0 flex-wrap ${column ? 'w-full' : 'flex-1'}`}>{children}</div>
    </div>
  )
}
function SectionHead({ children, onReset }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">{children}</h4>
      {onReset && (
        <button onClick={onReset} className="text-[10px] text-[var(--faint)] hover:text-[var(--text)]">
          Reset
        </button>
      )}
    </div>
  )
}
const inputCls = 'min-w-0 text-[12px] rounded-md bg-[var(--surface)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)]'
// a small segmented toggle (Hug/Fixed/Fill, None/All/…). `fill` makes every
// option flex-1 so a 4-way control (e.g. Position modes) spans the row without
// clipping the last label.
function Seg({ options, value, onChange, fill = false }) {
  return (
    <div className={`flex rounded-md border border-[var(--border)] overflow-hidden text-[11px] ${fill ? 'w-full' : ''}`}>
      {options.map((o, i) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2 h-6 whitespace-nowrap ${fill ? 'flex-1' : ''} ${i ? 'border-l border-[var(--border)]' : ''} ${
            value === o.value ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Padding/Margin editor with None / All / X&Y / Individual modes — writes the
// shorthand (`padding`/`margin`) so a single inline declaration stays clean and
// the snapshot's mode detection round-trips.
function BoxEdit({ label, prop, mode, c, inl, set, t }) {
  const cap = prop === 'padding' ? 'padding' : 'margin'
  const T = c[`${cap}Top`] ?? 0
  const R = c[`${cap}Right`] ?? 0
  const B = c[`${cap}Bottom`] ?? 0
  const L = c[`${cap}Left`] ?? 0
  const write = (t2, r2, b2, l2) => set({ [prop]: `${t2}px ${r2}px ${b2}px ${l2}px` })
  const num = 'min-w-0 w-full text-[12px] rounded-md bg-[var(--surface)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]'
  return (
    <div className="space-y-1">
      <Field label={label} dot={inl} onUnset={() => set({ [prop]: null })} column>
        <Seg
          fill
          options={[
            { value: 'none', label: t('deckStudio.htmlEdit.none') },
            { value: 'all', label: t('deckStudio.htmlEdit.all') },
            { value: 'xy', label: 'X·Y' },
            { value: 'individual', label: t('deckStudio.htmlEdit.each') },
          ]}
          value={mode}
          onChange={(v) => {
            if (v === 'none') set({ [prop]: null })
            else if (v === 'all') set({ [prop]: '16px' })
            else if (v === 'xy') write(T || 16, R || 24, T || 16, R || 24)
            else write(T, R, B, L)
          }}
        />
      </Field>
      {mode === 'all' && (
        <div>
          <input type="number" min={0} value={T} onChange={(e) => set({ [prop]: `${e.target.value || 0}px` })} className={`${num} !w-16`} />
        </div>
      )}
      {mode === 'xy' && (
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">Y<input type="number" value={T} onChange={(e) => write(e.target.value || 0, R, e.target.value || 0, L)} className={num} /></label>
          <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">X<input type="number" value={R} onChange={(e) => write(T, e.target.value || 0, B, e.target.value || 0)} className={num} /></label>
        </div>
      )}
      {mode === 'individual' && (
        <div className="grid grid-cols-4 gap-1">
          {[['T', T, (v) => write(v, R, B, L)], ['R', R, (v) => write(T, v, B, L)], ['B', B, (v) => write(T, R, v, L)], ['L', L, (v) => write(T, R, B, v)]].map(([lbl, val, on]) => (
            <label key={lbl} className="flex flex-col items-center gap-0.5 text-[9px] text-[var(--faint)]">
              {lbl}
              <input type="number" value={val} onChange={(e) => on(e.target.value || 0)} className={num} />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export default function HtmlSlideInspector({
  html,
  selectedPaths = [],
  selectedInfo,
  onSelectPath,
  onStyle,
  onText,
  onAttr,
  onOp,
  onMove,
  onUploadImage,
}) {
  const t = useT()
  const tree = useMemo(() => buildTree(html), [html])
  const [expanded, setExpanded] = useState(() => new Set(['', '0', '1']))
  const toggle = (p) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(p) ? next.delete(p) : next.add(p)
      return next
    })

  // Expand the tree down to the primary selection so a node picked on the canvas
  // isn't hidden inside a collapsed ancestor (item 2). Runs on selection change;
  // only adds ancestors (never collapses what the user opened).
  const primaryPath = selectedPaths[0]
  useEffect(() => {
    if (primaryPath == null) return
    const anc = ancestorPaths(primaryPath)
    setExpanded((prev) => {
      if (anc.every((p) => prev.has(p))) return prev // already open — no re-render
      const next = new Set(prev)
      anc.forEach((p) => next.add(p))
      return next
    })
  }, [primaryPath])

  // Drag-and-drop reorder/reparent in the tree (item 1). `dragging` is the path
  // being dragged; `over` is the current hover target + zone (before/after/
  // inside). On drop we hand the move to the parent, which relays it to the
  // iframe runtime (opMove) — the re-serialized HTML round-trips back and pushes
  // an undo entry, so no separate undo bookkeeping is needed here.
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)
  const dnd = onMove && {
    dragging,
    over,
    onStart: (path) => setDragging(path),
    onEnd: () => {
      setDragging(null)
      setOver(null)
    },
    onOver: (path, zone) => setOver((o) => (o?.path === path && o?.zone === zone ? o : { path, zone })),
    onDrop: (path) => {
      const zone = over?.path === path ? over.zone : 'inside'
      if (dragging && dragging !== path) onMove(dragging, path, zone)
      setDragging(null)
      setOver(null)
    },
  }

  const info = selectedInfo
  const multi = info?.multi
  const c = info?.computed || {}
  const inl = info?.inline || {}
  const sz = info?.sizing || {}
  const isBold = parseInt(c.fontWeight, 10) >= 600
  const set = (style) => onStyle?.(style)
  // padding/margin box modes: none | all | xy | individual
  const boxMode = (on, top, right, bottom, left) => {
    if (!on) return 'none'
    if (top === right && right === bottom && bottom === left) return 'all'
    if (top === bottom && left === right) return 'xy'
    return 'individual'
  }
  const padMode = boxMode(inl.padding, c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft)
  const marMode = boxMode(inl.margin, c.marginTop, c.marginRight, c.marginBottom, c.marginLeft)

  const sizingSeg = [
    { value: 'hug', label: 'Hug' },
    { value: 'fixed', label: 'Fixed' },
    { value: 'fill', label: 'Fill' },
  ]
  const setWidth = (mode) => set({ width: mode === 'hug' ? null : mode === 'fill' ? '100%' : `${Math.round(c.width)}px` })
  const setHeight = (mode) => set({ height: mode === 'hug' ? null : mode === 'fill' ? '100%' : `${Math.round(c.height)}px` })

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* DOM layer tree */}
      <div className="shrink-0 border-b border-[var(--border)]">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <span className="text-xs font-semibold">{t('deckStudio.htmlEdit.layers')}</span>
          <span className="text-[9.5px] text-[var(--faint)]">{t('deckStudio.htmlEdit.layersHint')}</span>
        </div>
        <div className="max-h-44 overflow-y-auto px-1.5 pb-1.5">
          {tree ? (
            <TreeRow node={tree} depth={0} selectedPaths={selectedPaths} onSelect={onSelectPath} expanded={expanded} toggle={toggle} dnd={dnd} />
          ) : (
            <p className="text-[11px] text-[var(--faint)] px-2 py-1.5">{t('deckStudio.htmlEdit.noTree')}</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!info ? (
          <div className="h-full grid place-items-center text-center px-4">
            <p className="text-[11px] text-[var(--faint)] leading-relaxed">{t('deckStudio.htmlEdit.selectHint')}</p>
          </div>
        ) : multi ? (
          // ---- multi-selection: batch structural ops --------------------------
          <div className="space-y-3">
            <p className="text-[11px] text-[var(--muted)]">{t('deckStudio.htmlEdit.multiCount', { n: info.count })}</p>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => onOp?.('group')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5 flex items-center justify-center gap-1.5">
                <Icon.Copy size={12} /> {t('deckStudio.htmlEdit.group')}
              </button>
              <button onClick={() => onOp?.('wrapFlex')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5">
                {t('deckStudio.htmlEdit.wrapFlex')}
              </button>
              <button onClick={() => onOp?.('duplicate')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5 flex items-center justify-center gap-1.5">
                <Icon.Copy size={12} /> {t('deckStudio.htmlEdit.duplicate')}
              </button>
              <button onClick={() => onOp?.('delete')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5 flex items-center justify-center gap-1.5 text-[var(--danger,#e5484d)]">
                <Icon.Trash size={12} /> {t('common.delete')}
              </button>
            </div>
            {/* align / distribute — free-position (absolute) elements only */}
            <section className="space-y-1.5">
              <SectionHead>{t('deckStudio.htmlEdit.align')}</SectionHead>
              <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                {[
                  ['alignLeft', '⇤', 'alignLeft'],
                  ['alignHCenter', '⇔', 'alignHCenter'],
                  ['alignRight', '⇥', 'alignRight'],
                  ['alignTop', '⤒', 'alignTop'],
                  ['alignVMiddle', '⇳', 'alignVMiddle'],
                  ['alignBottom', '⤓', 'alignBottom'],
                ].map(([op, glyph, key], i) => (
                  <button
                    key={op}
                    onClick={() => onOp?.(op)}
                    title={t(`deckStudio.htmlEdit.${key}`)}
                    className={`flex-1 h-7 grid place-items-center text-[13px] text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] ${i ? 'border-l border-[var(--border)]' : ''}`}
                  >
                    {glyph}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => onOp?.('distributeH')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5" title={t('deckStudio.htmlEdit.distributeH')}>
                  {t('deckStudio.htmlEdit.distribute')} ↔
                </button>
                <button onClick={() => onOp?.('distributeV')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5" title={t('deckStudio.htmlEdit.distributeV')}>
                  {t('deckStudio.htmlEdit.distribute')} ↕
                </button>
              </div>
              <p className="text-[9.5px] text-[var(--faint)]">{t('deckStudio.htmlEdit.alignHint')}</p>
            </section>

            {/* shared color for a quick multi-restyle */}
            <Field label={t('deckStudio.htmlEdit.color')}>
              <input type="color" defaultValue="#FFFFFF" onChange={(e) => set({ color: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent" />
              <span className="text-[10px] text-[var(--faint)]">{t('deckStudio.htmlEdit.applyAll')}</span>
            </Field>
          </div>
        ) : (
          <div className="space-y-4">
            {/* content: text or image source */}
            {info.textLeaf && (
              <section className="space-y-1.5">
                <SectionHead>{t('deckStudio.htmlEdit.content')}</SectionHead>
                <textarea value={info.text || ''} onChange={(e) => onText?.(e.target.value)} rows={2} className={`${inputCls} w-full resize-none leading-snug`} />
              </section>
            )}
            {info.isImage && (
              <section className="space-y-1.5">
                <SectionHead>{t('deckStudio.htmlEdit.image')}</SectionHead>
                <Field label={t('deckStudio.htmlEdit.source')}>
                  <label className="text-[11px] text-[var(--accent)] hover:brightness-110 cursor-pointer flex items-center gap-1">
                    <Icon.Upload size={12} /> {t('deckStudio.htmlEdit.replaceImage')}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        const r = new FileReader()
                        r.onload = () => onAttr?.('src', r.result)
                        r.readAsDataURL(f)
                      }}
                    />
                  </label>
                </Field>
                <Field label={t('deckStudio.htmlEdit.fit')}>
                  <select value={c.objectFit || 'fill'} onChange={(e) => set({ objectFit: e.target.value })} className={inputCls}>
                    <option value="contain">contain</option>
                    <option value="cover">cover</option>
                    <option value="fill">fill</option>
                    <option value="none">none</option>
                  </select>
                </Field>
              </section>
            )}

            {/* typography (text leaves) */}
            {info.textLeaf && (
              <section className="space-y-1">
                <SectionHead>{t('deckStudio.htmlEdit.typography')}</SectionHead>
                <Field label={t('deckStudio.htmlEdit.size')} dot={inl.fontSize} onUnset={() => set({ fontSize: null })}>
                  <input type="number" min={6} max={200} value={c.fontSize ?? ''} onChange={(e) => set({ fontSize: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} />
                  <span className="text-[10px] text-[var(--faint)]">px</span>
                </Field>
                <Field label={t('deckStudio.htmlEdit.color')} dot={inl.color} onUnset={() => set({ color: null })}>
                  <input type="color" value={toHex(c.color)} onChange={(e) => set({ color: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0" />
                  <input value={toHex(c.color).toUpperCase()} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && set({ color: e.target.value.toUpperCase() })} className={`${inputCls} w-24 font-mono`} />
                </Field>
                <Field label={t('deckStudio.htmlEdit.weight')} dot={inl.fontWeight || inl.fontStyle || inl.textDecoration} onUnset={() => set({ fontWeight: null, fontStyle: null, textDecoration: null })}>
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    <button onClick={() => set({ fontWeight: isBold ? '400' : '700' })} className={`w-7 h-6 grid place-items-center font-bold text-[12px] ${isBold ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={t('deckStudio.htmlEdit.bold')}>
                      B
                    </button>
                    <button onClick={() => set({ fontStyle: c.fontStyle === 'italic' ? 'normal' : 'italic' })} className={`w-7 h-6 grid place-items-center italic text-[12px] border-l border-[var(--border)] ${c.fontStyle === 'italic' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={t('deckStudio.htmlEdit.italic')}>
                      I
                    </button>
                    <button onClick={() => set({ textDecoration: /underline/.test(c.textDecorationLine) ? 'none' : 'underline' })} className={`w-7 h-6 grid place-items-center underline text-[12px] border-l border-[var(--border)] ${/underline/.test(c.textDecorationLine) ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title="Underline">
                      U
                    </button>
                    <button onClick={() => set({ textDecoration: /line-through/.test(c.textDecorationLine) ? 'none' : 'line-through' })} className={`w-7 h-6 grid place-items-center line-through text-[12px] border-l border-[var(--border)] ${/line-through/.test(c.textDecorationLine) ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={t('deckStudio.htmlEdit.strike')}>
                      S
                    </button>
                  </div>
                  <select value={c.textTransform && c.textTransform !== 'none' ? c.textTransform : ''} onChange={(e) => set({ textTransform: e.target.value || 'none' })} className={`${inputCls} ml-1`} title={t('deckStudio.htmlEdit.transform')}>
                    <option value="">{t('deckStudio.htmlEdit.caseNormal')}</option>
                    <option value="uppercase">ABC</option>
                    <option value="lowercase">abc</option>
                    <option value="capitalize">Abc</option>
                  </select>
                </Field>
                {/* full weight scale (Claude Design parity: Thin→Black) */}
                <Field label={t('deckStudio.htmlEdit.weightScale')} dot={inl.fontWeight} onUnset={() => set({ fontWeight: null })}>
                  <select value={WEIGHTS.includes(String(parseInt(c.fontWeight, 10))) ? String(parseInt(c.fontWeight, 10)) : ''} onChange={(e) => set({ fontWeight: e.target.value || null })} className={inputCls}>
                    <option value="">—</option>
                    <option value="100">Thin</option>
                    <option value="200">Extra Light</option>
                    <option value="300">Light</option>
                    <option value="400">Regular</option>
                    <option value="500">Medium</option>
                    <option value="600">Semibold</option>
                    <option value="700">Bold</option>
                    <option value="800">Extra Bold</option>
                    <option value="900">Black</option>
                  </select>
                </Field>
                <Field label={t('deckStudio.htmlEdit.align')} dot={inl.textAlign} onUnset={() => set({ textAlign: null })}>
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    {['left', 'center', 'right', 'justify'].map((al) => (
                      <button key={al} onClick={() => set({ textAlign: al })} className={`px-2 h-6 text-[12px] ${al !== 'left' ? 'border-l border-[var(--border)]' : ''} ${c.textAlign === al ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={al}>
                        {al === 'left' ? '⇤' : al === 'center' ? '↔' : al === 'right' ? '⇥' : '≣'}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label={t('deckStudio.htmlEdit.spacing')} dot={inl.letterSpacing || inl.lineHeight} onUnset={() => set({ letterSpacing: null, lineHeight: null })}>
                  <input type="number" step={0.1} value={c.letterSpacing ?? 0} onChange={(e) => set({ letterSpacing: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-14`} title={t('deckStudio.htmlEdit.letterSpacing')} />
                  <span className="text-[10px] text-[var(--faint)]">ls</span>
                  <input type="number" step={0.05} min={0.7} max={3} value={c.lineHeight ?? ''} placeholder="auto" onChange={(e) => set({ lineHeight: e.target.value === '' ? null : e.target.value })} className={`${inputCls} w-14 ml-1`} title={t('deckStudio.htmlEdit.lineHeight')} />
                  <span className="text-[10px] text-[var(--faint)]">lh</span>
                </Field>
              </section>
            )}

            {/* sizing */}
            <section className="space-y-1">
              <SectionHead onReset={() => set({ width: null, height: null, flexGrow: null, alignSelf: null })}>{t('deckStudio.htmlEdit.sizing')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.width')} dot={inl.width} onUnset={() => set({ width: null })}>
                <input type="number" value={Math.round(c.width) || ''} onChange={(e) => set({ width: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} disabled={sz.width === 'hug'} />
                <Seg options={sizingSeg} value={sz.width} onChange={setWidth} />
              </Field>
              <Field label={t('deckStudio.htmlEdit.height')} dot={inl.height} onUnset={() => set({ height: null })}>
                <input type="number" value={Math.round(c.height) || ''} onChange={(e) => set({ height: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} disabled={sz.height === 'hug'} />
                <Seg options={sizingSeg} value={sz.height} onChange={setHeight} />
              </Field>
            </section>

            {/* position */}
            <section className="space-y-1">
              <SectionHead>{t('deckStudio.htmlEdit.position')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.mode')} dot={inl.position} onUnset={() => set({ position: null })} column>
                <Seg
                  fill
                  options={[
                    { value: 'static', label: t('deckStudio.htmlEdit.inline') },
                    { value: 'absolute', label: 'Absolute' },
                    { value: 'fixed', label: 'Fixed' },
                    { value: 'sticky', label: 'Sticky' },
                  ]}
                  value={c.position === 'relative' || c.position === 'static' ? 'static' : c.position}
                  onChange={(v) => set({ position: v === 'static' ? null : v })}
                />
              </Field>
              {c.position === 'absolute' || c.position === 'fixed' || c.position === 'sticky' ? (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      T
                      <input type="number" value={parseFloat(c.top) || ''} placeholder="auto" onChange={(e) => set({ top: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      L
                      <input type="number" value={parseFloat(c.left) || ''} placeholder="auto" onChange={(e) => set({ left: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      R
                      <input type="number" value={parseFloat(c.right) || ''} placeholder="auto" onChange={(e) => set({ right: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      B
                      <input type="number" value={parseFloat(c.bottom) || ''} placeholder="auto" onChange={(e) => set({ bottom: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                  </div>
                  <Field label="Z-index" dot={inl.zIndex} onUnset={() => set({ zIndex: null })}>
                    <input type="number" value={c.zIndex || ''} placeholder="auto" onChange={(e) => set({ zIndex: e.target.value === '' ? null : e.target.value })} className={`${inputCls} w-16`} />
                  </Field>
                </>
              ) : null}
            </section>

            {/* padding + margin — None / All / X&Y / Individual (Claude Design parity) */}
            <section className="space-y-1">
              <SectionHead>{t('deckStudio.htmlEdit.spacingBox')}</SectionHead>
              <BoxEdit label={t('deckStudio.htmlEdit.padding')} prop="padding" mode={padMode} c={c} inl={inl.padding} set={set} t={t} />
              <BoxEdit label={t('deckStudio.htmlEdit.margin')} prop="margin" mode={marMode} c={c} inl={inl.margin} set={set} t={t} />
            </section>

            {/* appearance */}
            <section className="space-y-1">
              <SectionHead onReset={() => set({ background: null, borderRadius: null, opacity: null, boxShadow: null, overflow: null })}>{t('deckStudio.htmlEdit.appearance')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.background')} dot={inl.background} onUnset={() => set({ background: null })}>
                {hasBg(c.backgroundColor) ? (
                  <>
                    <input type="color" value={toHex(c.backgroundColor)} onChange={(e) => set({ background: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0" />
                    <input value={toHex(c.backgroundColor).toUpperCase()} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && set({ background: e.target.value.toUpperCase() })} className={`${inputCls} w-24 font-mono`} />
                  </>
                ) : (
                  <button onClick={() => set({ background: '#FFFFFF' })} className="text-[11px] text-[var(--accent)] hover:brightness-110 flex items-center gap-1">
                    <Icon.Plus size={11} /> {t('deckStudio.htmlEdit.addFill')}
                  </button>
                )}
              </Field>
              <Field label={t('deckStudio.htmlEdit.radius')} dot={inl.borderRadius} onUnset={() => set({ borderRadius: null })}>
                <input type="number" min={0} max={400} value={c.borderRadius ?? 0} onChange={(e) => set({ borderRadius: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} />
                <span className="text-[10px] text-[var(--faint)]">px</span>
              </Field>
              <Field label={t('deckStudio.htmlEdit.overflow')} dot={inl.overflow} onUnset={() => set({ overflow: null })}>
                <select value={c.overflow || 'visible'} onChange={(e) => set({ overflow: e.target.value })} className={inputCls}>
                  <option value="visible">visible</option>
                  <option value="hidden">hidden</option>
                  <option value="auto">auto</option>
                </select>
              </Field>
              <Field label={t('deckStudio.htmlEdit.opacity')} dot={inl.opacity} onUnset={() => set({ opacity: null })}>
                <input type="range" min={0} max={1} step={0.05} value={parseFloat(c.opacity ?? 1)} onChange={(e) => set({ opacity: e.target.value })} className="flex-1 accent-[var(--accent)]" />
                <span className="text-[10px] text-[var(--faint)] tabular-nums w-8 text-right">{Math.round(parseFloat(c.opacity ?? 1) * 100)}%</span>
              </Field>
              <Field label={t('deckStudio.htmlEdit.shadow')} dot={inl.boxShadow} onUnset={() => set({ boxShadow: null })}>
                {c.boxShadow && c.boxShadow !== 'none' ? (
                  <span className="text-[11px] text-[var(--muted)]">{t('deckStudio.htmlEdit.shadowOn')}</span>
                ) : (
                  <button onClick={() => set({ boxShadow: '0 8px 24px rgba(0,0,0,.18)' })} className="text-[11px] text-[var(--accent)] hover:brightness-110 flex items-center gap-1">
                    <Icon.Plus size={11} /> {t('deckStudio.htmlEdit.addShadow')}
                  </button>
                )}
              </Field>
              {/* border (Claude Design parity) */}
              <Field label={t('deckStudio.htmlEdit.border')} dot={inl.border} onUnset={() => set({ border: null, borderWidth: null, borderStyle: null, borderColor: null })}>
                {inl.border && c.borderStyle && c.borderStyle !== 'none' && c.borderWidth > 0 ? (
                  <>
                    <input type="number" min={0} max={40} value={c.borderWidth ?? 1} onChange={(e) => set({ borderWidth: `${e.target.value || 0}px`, borderStyle: c.borderStyle || 'solid' })} className={`${inputCls} w-12`} />
                    <input type="color" value={toHex(c.borderColor)} onChange={(e) => set({ borderColor: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0" />
                    <select value={c.borderStyle || 'solid'} onChange={(e) => set({ borderStyle: e.target.value })} className={inputCls}>
                      <option value="solid">solid</option>
                      <option value="dashed">dashed</option>
                      <option value="dotted">dotted</option>
                    </select>
                  </>
                ) : (
                  <button onClick={() => set({ border: `1px solid ${toHex(c.color) || '#000000'}` })} className="text-[11px] text-[var(--accent)] hover:brightness-110 flex items-center gap-1">
                    <Icon.Plus size={11} /> {t('deckStudio.htmlEdit.addBorder')}
                  </button>
                )}
              </Field>
            </section>

            {/* structural ops for a single element */}
            <section className="pt-1 border-t border-[var(--border)]">
              <div className="grid grid-cols-2 gap-1.5 pt-2">
                <button onClick={() => onOp?.('duplicate')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5 flex items-center justify-center gap-1.5">
                  <Icon.Copy size={11} /> {t('deckStudio.htmlEdit.duplicate')}
                </button>
                <button onClick={() => onOp?.('delete')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5 flex items-center justify-center gap-1.5 text-[var(--danger,#e5484d)]">
                  <Icon.Trash size={11} /> {t('common.delete')}
                </button>
                <button onClick={() => onOp?.('front')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5">
                  {t('deckStudio.htmlEdit.toFront')}
                </button>
                <button onClick={() => onOp?.('back')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5">
                  {t('deckStudio.htmlEdit.toBack')}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
