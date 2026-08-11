import { useCallback, useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import HtmlSlideFrame, { buildDeckTokenStyle } from './deck/HtmlSlideFrame.jsx'
import HtmlSlideEditor from './deck/HtmlSlideEditor.jsx'
import HtmlSlideInspector from './deck/HtmlSlideInspector.jsx'
import HtmlEditToolbar from './deck/HtmlEditToolbar.jsx'
import HtmlEditContextMenu from './deck/HtmlEditContextMenu.jsx'
import { extractOpsFromSlides } from '../lib/domToSlideOps.js'
import { buildDeckAssetMap } from '../lib/deckAssets.js'
import { getJSON, patchJSON, postJSON } from '../api.js'
import { useT } from '../lib/i18n.jsx'
import CostBadge from './CostBadge.jsx'
import PromptImageStrip from './PromptImageStrip.jsx'
import { usePromptImages } from '../hooks/usePromptImages.js'

// Given a slide's <section> HTML and a list of child-index paths (e.g. "1.0.2"),
// return the outerHTML of each addressed node — used to copy/cut selected
// elements to the studio clipboard (paste re-inserts them into the live editor).
function extractNodesHtml(html, paths) {
  if (!html || !paths?.length) return []
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return []
  }
  const root = doc.body.firstElementChild
  if (!root) return []
  const at = (path) => {
    let el = root
    for (const seg of String(path).split('.')) {
      if (!el) return null
      el = el.children[parseInt(seg, 10)]
    }
    return el || null
  }
  return paths.map(at).filter(Boolean).map((el) => el.outerHTML)
}

// Fullscreen Present mode — arrow keys / click zones, Esc closes. Renders
// HTML slides for full-screen presentation.
function PresentMode({ deck, template, onClose }) {
  const t = useT()
  const [index, setIndex] = useState(0)
  const n = deck.slides.length
  const go = useCallback((d) => setIndex((i) => Math.max(0, Math.min(n - 1, i + d))), [n])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') go(1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1)
      else if (e.key === 'Home') setIndex(0)
      else if (e.key === 'End') setIndex(n - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, n, onClose])
  const slide = deck.slides[index]
  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col items-center justify-center animate-fade-in">
      <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10" title={t('deckStudio.present.exit')}>
        <Icon.Close size={20} />
      </button>
      <div className="absolute inset-0 flex" aria-hidden>
        <div className="flex-1 cursor-w-resize" onClick={() => go(-1)} />
        <div className="flex-1 cursor-e-resize" onClick={() => go(1)} />
      </div>
      <div className="w-full max-w-[min(96vw,177vh)] px-6 pointer-events-none">
        <HtmlSlideFrame
          html={typeof slide === 'string' ? slide : slide?.html}
          template={template}
          title={`${deck.title} — ${index + 1}`}
          className="w-full shadow-2xl"
        />
      </div>
      <div className="absolute bottom-4 text-white/40 text-xs tabular-nums select-none">
        {t('deckStudio.present.nav', { current: index + 1, total: n })}
      </div>
      {slide?.notes && (
        <div className="absolute bottom-10 max-w-2xl text-center text-white/50 text-xs px-6 line-clamp-2" title={slide.notes}>
          🗒 {slide.notes}
        </div>
      )}
    </div>
  )
}

function emptySlide() {
  return { html: '<section class="slide"></section>' }
}


// Shown on the stage while a pure-HTML deck is streaming and the current slide
// hasn't arrived yet — a shimmering 16:9 placeholder (title bar + content
// blocks) so the auto-opened Studio reads as "building", not a blank white box.
function HtmlSlideSkeleton({ streaming, label }) {
  return (
    <div className="w-full rounded-lg shadow-lg overflow-hidden border border-[var(--border)]" style={{ aspectRatio: '16/9', background: '#F9F7F4' }}>
      <div className="h-full w-full p-[6%] flex flex-col gap-[3%]">
        <div className="h-[4%] w-[22%] rounded animate-pulse" style={{ background: 'rgba(0,0,0,0.10)' }} />
        <div className="h-[9%] w-[70%] rounded animate-pulse" style={{ background: 'rgba(0,0,0,0.13)' }} />
        <div className="flex-1 grid grid-cols-3 gap-[3%] mt-[2%]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg animate-pulse" style={{ background: 'rgba(0,0,0,0.06)', animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
        {streaming && label && (
          <div className="text-center text-xs text-[var(--muted)] pt-[1%]">{label}</div>
        )}
      </div>
    </div>
  )
}


export default function DeckStudio({ open, deckId, streamingDeck, onClose, pushToast, focus = false, onToggleFocus, onEditModeChange, onDeckSession, models, model }) {
  const t = useT()
  const [deck, setDeck] = useState(null)
  const [template, setTemplate] = useState(null)
  const [loading, setLoading] = useState(false)
  // deck/template fetch failure (timeout, expired session…) — surfaced with a
  // retry button instead of an eternal "Carregando deck…"; loadTick re-runs
  // the load effect
  const [loadError, setLoadError] = useState(null)
  const [loadTick, setLoadTick] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [exporting, setExporting] = useState(false)
  // export font-fidelity chooser (HTML decks): universal vs. embedded brand fonts
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  // AI tweak (HTML decks): state for pending preview
  const [tweak, setTweak] = useState('')
  const [tweakWholeDeck, setTweakWholeDeck] = useState(false)
  const [tweaking, setTweaking] = useState(false)
  // images attached to the AI tweak prompt (paste or attach) — sent as vision
  // input so the model can edit from a reference screenshot/design (item 9)
  const tweakImages = usePromptImages()
  const tweakImageInput = useRef(null)
  // AI tweak preview: a pending edit shown in the canvas with Accept/Discard,
  // so an AI change is reversible before it lands. `before` is the deck to
  // restore on discard; `label` describes the edit for the history log.
  const [tweakPreview, setTweakPreview] = useState(null) // null | { before, label }
  const tweakPreviewRef = useRef(null) // mirror for cleanup on slide switch
  tweakPreviewRef.current = tweakPreview
  const [tweakHistory, setTweakHistory] = useState([]) // [{ label, at }] applied edits
  const [tweakCost, setTweakCost] = useState(null) // { usage, model } of the last AI edit
  const [presenting, setPresenting] = useState(false)
  const dragFrom = useRef(null)
  const saveTimer = useRef(null)
  const skipNextSave = useRef(true)
  // pure-HTML deck manual editing (Claude Design "Pro" parity): Edit mode turns
  // the slide into a full design surface (select/create/restyle). Selection is a
  // list of child-index paths into the current slide's <section>, plus the live
  // style snapshot the iframe reports.
  const [htmlEditMode, setHtmlEditMode] = useState(false)
  const [htmlSel, setHtmlSel] = useState(null) // null | { paths:[...], info }
  const [htmlTool, setHtmlTool] = useState('select') // armed create tool
  const [htmlMenu, setHtmlMenu] = useState(null) // right-click menu {x,y,paths}
  const [htmlClip, setHtmlClip] = useState(null) // clipboard: outerHTML string(s)
  const htmlEditorRef = useRef(null)
  // per-slide undo/redo stacks for the raw HTML string, keyed by slide index.
  // Kept in refs (mutable, no re-render needed until we read length for toolbar).
  const htmlHist = useRef({ past: [], future: [] })
  const [htmlHistTick, setHtmlHistTick] = useState(0) // bump to refresh can-undo/redo
  const htmlEditPreview = useRef(null) // { before } for AI tweak preview on HTML
  // mirror of isHtmlDeck for effects that run before the render-body computes it
  const isHtmlDeckRef = useRef(false)
  // manual editing is now COMMIT-based (Claude Design "Discard / Save"): edits
  // accumulate in the working deck and only persist on an explicit Save. Autosave
  // is suppressed while editing; `htmlDirty` gates the Save/Discard bar and
  // `htmlBaseline` is the deck snapshot to restore on Discard.
  const [htmlDirty, setHtmlDirty] = useState(false)
  const htmlBaseline = useRef(null)
  const [htmlSaving, setHtmlSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false) // brief "Salvo" confirmation
  const htmlEditModeRef = useRef(false)
  // when closing the Studio with unsaved manual edits, show a Save / Discard /
  // Cancel confirmation instead of silently dropping the changes
  const [closeConfirm, setCloseConfirm] = useState(false)

  useEffect(() => {
    if (!open || !deckId) return
    skipNextSave.current = true
    setLoading(true)
    setLoadError(null)
    setActiveIndex(0)
    Promise.all([getJSON(`/api/decks/${deckId}`), getJSON('/api/deck-templates/selected')])
      .then(([d, t]) => {
        setDeck(d.deck)
        setTemplate(t.template || null)
        // tell App which chat this deck belongs to, so it can close the Studio
        // when the user navigates to a different conversation
        onDeckSession?.(d.deck?.sessionId ?? null)
      })
      .catch((e) => setLoadError(e.message || t('deckStudio.loadError')))
      .finally(() => setLoading(false))
  }, [open, deckId, loadTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live-streaming deck (pure-HTML engine): no deckId yet — the slides arrive
  // via SSE and are handed in as `streamingDeck`. Mirror them into `deck` so the
  // rail + stage build up live. The template is loaded once; saves are disabled
  // while streaming (there's nothing persisted to PATCH yet).
  useEffect(() => {
    if (!open || !streamingDeck) return
    skipNextSave.current = true
    setDeck(streamingDeck)
    setLoading(false)
    setLoadError(null)
  }, [open, streamingDeck])

  useEffect(() => {
    if (!open || !streamingDeck || template) return
    getJSON('/api/deck-templates/selected')
      .then((t) => setTemplate(t.template || null))
      .catch(() => {})
  }, [open, streamingDeck, template])

  // HTML editing: reset selection and state when switching slides
  useEffect(() => {
    setHtmlSel(null)
    setHtmlTool('select')
    setHtmlMenu(null)
    htmlHist.current = { past: [], future: [] } // per-slide undo history
    setHtmlHistTick((n) => n + 1)
  }, [activeIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // tell App to hide the chat while manual HTML editing (max canvas room).
  // Entering Edit mode snapshots the deck as the Discard baseline and clears the
  // dirty flag; leaving it clears both (Save/Discard already handled the deck).
  useEffect(() => {
    onEditModeChange?.(htmlEditMode)
    htmlEditModeRef.current = htmlEditMode
    if (htmlEditMode) {
      htmlBaseline.current = deck
      setHtmlDirty(false)
    } else {
      htmlBaseline.current = null
      setHtmlDirty(false)
    }
  }, [htmlEditMode, onEditModeChange]) // eslint-disable-line react-hooks/exhaustive-deps
  // leaving the studio or switching away from an HTML deck exits Edit mode
  useEffect(() => {
    if (!open) setHtmlEditMode(false)
  }, [open])

  // HTML Edit mode hotkeys (Cmd+Z/Shift+Z, copy/cut/paste, etc) are routed
  // through hotkeysRef; skip if the focus is in an input/textarea/contentEditable
  const hotkeysRef = useRef({})
  useEffect(() => {
    if (!open) return
    const onKey = (ev) => {
      const t = ev.target
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const meta = ev.metaKey || ev.ctrlKey
      const hk = hotkeysRef.current
      // HTML Edit mode: full editor hotkey set (but never steal from a field)
      if (hk.htmlActive && !inField) {
        const k = ev.key.toLowerCase()
        if (meta && k === 'z') {
          ev.preventDefault()
          ev.shiftKey ? hk.redo?.() : hk.undo?.()
          return
        }
        if (meta && k === 'c') {
          ev.preventDefault()
          hk.op?.('copy')
          return
        }
        if (meta && k === 'x') {
          ev.preventDefault()
          hk.op?.('cut')
          return
        }
        if (meta && k === 'v') {
          ev.preventDefault()
          hk.op?.('paste')
          return
        }
        if (meta && k === 'd') {
          ev.preventDefault()
          hk.op?.('duplicate')
          return
        }
        if (meta && ev.shiftKey && k === 'g') {
          ev.preventDefault()
          hk.op?.('ungroup')
          return
        }
        if (meta && k === 'g') {
          ev.preventDefault()
          hk.op?.('group')
          return
        }
        if ((k === 'delete' || k === 'backspace') && hk.hasSel) {
          ev.preventDefault()
          hk.op?.('delete')
          return
        }
        if (k === 'escape') {
          hk.clearSel?.()
          return
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // debounced autosave — skips the initial load so opening the studio never
  // fires a needless PATCH
  useEffect(() => {
    if (!deck) return
    // a live-streaming deck has no persisted id yet — never PATCH it
    if (deck.streaming || !deck.id) return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    // manual HTML editing is commit-based: while Edit mode is on, edits stay
    // local (Discard/Save bar) and never autosave. Mark the deck dirty instead.
    if (htmlEditModeRef.current && isHtmlDeckRef.current) {
      setHtmlDirty(true)
      return
    }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      patchJSON(`/api/decks/${deck.id}`, {
        title: deck.title,
        slides: deck.slides,
        audience: deck.audience,
        author: deck.author,
        narrative: deck.narrative,
      })
        // Let the chat's deck card (DeckBlock) know its persisted deck changed so
        // it can re-fetch and reflect live edits (its block.slides is a snapshot
        // frozen at generation time). Fire only after the write lands.
        .then(() =>
          window.dispatchEvent(new CustomEvent('prism:deck-saved', { detail: { deckId: deck.id } }))
        )
        .catch((e) => pushToast?.(e.message))
    }, 500)
    return () => clearTimeout(saveTimer.current)
  }, [deck]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const slide = deck?.slides?.[activeIndex]
  // HTML deck (deck-html engine): slides are self-contained <section> strings
  const isHtmlDeck = deck?.meta?.format === 'html' || typeof deck?.slides?.[0] === 'string'
  isHtmlDeckRef.current = isHtmlDeck

  const updateSlide = (idx, patch) => {
    setDeck((d) => {
      const slides = [...d.slides]
      const cur = slides[idx]
      // an HTML slide stored as a bare string must become {html,…} to carry
      // notes/patches (e.g. manual speaker notes on an HTML deck)
      slides[idx] = typeof cur === 'string' ? { html: cur, ...patch } : { ...cur, ...patch }
      return { ...d, slides }
    })
  }

  // read the raw <section> HTML string of a slide (string or {html} form)
  const slideHtml = (s) => (typeof s === 'string' ? s : s?.html || '')

  // Pure-HTML deck: write the edited <section> string back into the current
  // slide, preserving whether the slide entry was a bare string or a {html,notes}
  // object. `pushHistory` snapshots the PREVIOUS html for undo (skipped for
  // history-driven writes so undo/redo don't stack on themselves).
  const setHtmlSlide = (idx, newHtml, { pushHistory = true } = {}) => {
    setDeck((d) => {
      const slides = [...d.slides]
      const cur = slides[idx]
      const prev = slideHtml(cur)
      if (prev === newHtml) return d
      if (pushHistory) {
        htmlHist.current.past.push(prev)
        if (htmlHist.current.past.length > 100) htmlHist.current.past.shift()
        htmlHist.current.future = []
        setHtmlHistTick((n) => n + 1)
      }
      slides[idx] = typeof cur === 'string' ? newHtml : { ...cur, html: newHtml }
      return { ...d, slides }
    })
  }

  // undo/redo the current slide's HTML — pushes the inverse onto the other stack
  // and pushes the restored html into the live editor (setHtml replaces <section>)
  const htmlUndo = () => {
    const h = htmlHist.current
    if (!h.past.length) return
    const cur = slideHtml(deck.slides[activeIndex])
    const prev = h.past.pop()
    h.future.push(cur)
    setHtmlHistTick((n) => n + 1)
    setHtmlSlide(activeIndex, prev, { pushHistory: false })
    htmlEditorRef.current?.setHtml(prev, true)
    setHtmlSel(null)
  }
  const htmlRedo = () => {
    const h = htmlHist.current
    if (!h.future.length) return
    const cur = slideHtml(deck.slides[activeIndex])
    const next = h.future.pop()
    h.past.push(cur)
    setHtmlHistTick((n) => n + 1)
    setHtmlSlide(activeIndex, next, { pushHistory: false })
    htmlEditorRef.current?.setHtml(next, true)
    setHtmlSel(null)
  }

  // right-click / hotkey structural ops routed to the iframe runtime
  const htmlOp = (op) => {
    if (op === 'copy' || op === 'cut') {
      // copy the selected nodes' outerHTML from the current slide's DOM
      const paths = htmlSel?.paths || []
      const clips = extractNodesHtml(slideHtml(deck.slides[activeIndex]), paths)
      if (clips.length) setHtmlClip(clips)
      if (op === 'cut') htmlEditorRef.current?.op('delete')
      return
    }
    if (op === 'paste') {
      if (!htmlClip?.length) return
      htmlEditorRef.current?.paste(htmlClip)
      return
    }
    htmlEditorRef.current?.op(op, htmlSel?.paths)
  }

  // AI tweak for HTML decks: scope = whole deck / this slide / selected element.
  // Runs in PREVIEW mode; the returned deck is shown with Accept/Discard. On
  // discard we restore the pre-edit deck AND push the original HTML back into the
  // live editor iframe so the canvas reverts too.
  const submitHtmlTweak = async () => {
    const instruction = tweak.trim()
    if (!instruction || tweaking || !deck?.id) return
    setTweaking(true)
    setTweakCost(null) // don't flash the previous edit's cost while this one runs
    try {
      const single = htmlSel?.paths?.length === 1 && !htmlSel.info?.multi
      const selPayload = single
        ? { path: htmlSel.paths[0], htmlOuter: extractNodesHtml(slideHtml(deck.slides[activeIndex]), htmlSel.paths)[0] || null }
        : null
      const r = await postJSON(`/api/decks/${deck.id}/tweak`, {
        instruction,
        slideIndex: tweakWholeDeck ? null : activeIndex,
        selection: tweakWholeDeck ? null : selPayload,
        // Send the working copy so the AI edits what the user is looking at —
        // including manual edits that haven't been saved yet — not the last
        // persisted version (item 4).
        slides: deck.slides,
        // attached images (item 9): `visionUrl` is what the model SEES (raster);
        // `dataUrl` is the ORIGINAL the server splices in when the model chooses
        // to insert it as a real asset (keeps SVG vector). See parseInlineImages.
        images: tweakImages.images.map((im) => ({ dataUrl: im.dataUrl, visionUrl: im.visionUrl })),
        preview: true,
        model,
      })
      htmlEditPreview.current = { before: deck }
      setTweakPreview({ before: deck, label: instruction })
      skipNextSave.current = true
      setDeck(r.deck)
      // reflect the edited HTML on the live canvas
      const editedHtml = slideHtml(r.deck.slides[activeIndex])
      htmlEditorRef.current?.setHtml(editedHtml, true)
      setHtmlSel(null)
      if (r.usage) setTweakCost({ usage: r.usage, model: r.model })
      setTweak('')
      tweakImages.clear()
    } catch (e) {
      pushToast?.(e.message || t('deckStudio.tweakError'))
    } finally {
      setTweaking(false)
    }
  }
  const acceptHtmlTweak = async () => {
    if (!tweakPreview) return
    // Accepting an AI edit folds it into the working deck (already live in
    // `deck`) AND persists immediately (item 3) — the user shouldn't have to
    // remember a second Save step after saying "accept". It stays undoable: we
    // checkpoint the pre-edit HTML on the undo stack first.
    setTweakHistory((h) => [{ label: tweakPreview.label, at: Date.now() }, ...h].slice(0, 20))
    setTweakPreview(null)
    setTweakCost(null)
    htmlEditPreview.current = null
    // history checkpoint so the accepted AI edit is itself undoable
    htmlHist.current.past.push(slideHtml(tweakPreview.before.slides[activeIndex]))
    setHtmlHistTick((n) => n + 1)
    // persist now; on failure we leave the deck dirty so the Save bar is the
    // explicit retry path (and the edit isn't lost).
    const ok = await persistDeck(deck)
    if (!ok) setHtmlDirty(true)
  }
  const discardHtmlTweak = () => {
    if (!tweakPreview) return
    skipNextSave.current = true
    setDeck(tweakPreview.before)
    htmlEditorRef.current?.setHtml(slideHtml(tweakPreview.before.slides[activeIndex]), true)
    setTweakPreview(null)
    setTweakCost(null)
    htmlEditPreview.current = null
  }

  // ---- commit-based manual editing: explicit Save / Discard -----------------
  // Persist one deck snapshot (one PATCH), re-baseline, clear dirty, and flash a
  // brief "Salvo" confirmation. Shared by the explicit Save bar and the AI
  // accept auto-save. Returns true on success, false on failure (caller decides
  // whether to keep the deck dirty as a retry affordance). Never throws.
  const persistDeck = async (d) => {
    if (!d?.id || htmlSaving) return false
    setHtmlSaving(true)
    try {
      await patchJSON(`/api/decks/${d.id}`, {
        title: d.title,
        slides: d.slides,
        audience: d.audience,
        author: d.author,
        narrative: d.narrative,
      })
      window.dispatchEvent(new CustomEvent('prism:deck-saved', { detail: { deckId: d.id } }))
      htmlBaseline.current = d // new restore point
      setHtmlDirty(false)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1600)
      return true
    } catch (e) {
      pushToast?.(e.message || t('deckStudio.saveError'))
      return false
    } finally {
      setHtmlSaving(false)
    }
  }
  // Save persists the current working deck; Discard restores the snapshot taken
  // when Edit mode opened and pushes it back onto the live canvas.
  const saveHtmlEdits = () => persistDeck(deck)
  const discardHtmlEdits = () => {
    const base = htmlBaseline.current
    if (!base) {
      setHtmlDirty(false)
      return
    }
    // drop any pending AI preview too
    setTweakPreview(null)
    setTweakCost(null)
    htmlEditPreview.current = null
    skipNextSave.current = true
    setDeck(base)
    htmlEditorRef.current?.setHtml(slideHtml(base.slides[activeIndex]), true)
    htmlHist.current = { past: [], future: [] }
    setHtmlHistTick((n) => n + 1)
    setHtmlSel(null)
    setHtmlDirty(false)
  }

  // Closing the Studio with unsaved manual edits must not drop them silently:
  // intercept the close and raise a Save / Discard / Cancel confirmation. When
  // clean (or not editing), close straight through.
  const requestClose = () => {
    if (htmlEditMode && isHtmlDeck && htmlDirty) {
      setCloseConfirm(true)
      return
    }
    onClose?.()
  }
  const confirmCloseSave = async () => {
    await saveHtmlEdits()
    setCloseConfirm(false)
    setHtmlEditMode(false)
    onClose?.()
  }
  const confirmCloseDiscard = () => {
    discardHtmlEdits()
    setCloseConfirm(false)
    setHtmlEditMode(false)
    onClose?.()
  }

  // keep the global hotkey handler pointed at the live HTML-edit closures
  hotkeysRef.current = {
    htmlActive: htmlEditMode && isHtmlDeck,
    hasSel: !!htmlSel?.paths?.length,
    undo: htmlUndo,
    redo: htmlRedo,
    op: htmlOp,
    clearSel: () => {
      setHtmlSel(null)
      htmlEditorRef.current?.clear()
    },
  }

  const addSlide = () => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides.splice(activeIndex + 1, 0, emptySlide())
      return { ...d, slides }
    })
    setActiveIndex((i) => i + 1)
  }

  const duplicateSlide = () => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides.splice(activeIndex + 1, 0, JSON.parse(JSON.stringify(slides[activeIndex])))
      return { ...d, slides }
    })
    setActiveIndex((i) => i + 1)
  }

  const deleteSlide = () => {
    setDeck((d) => {
      if (d.slides.length <= 1) return d
      const slides = d.slides.filter((_, i) => i !== activeIndex)
      return { ...d, slides }
    })
    setActiveIndex((i) => Math.max(0, Math.min(i, (deck?.slides.length || 2) - 2)))
  }

  const reorder = (from, to) => {
    if (from === to) return
    setDeck((d) => {
      const slides = [...d.slides]
      const [moved] = slides.splice(from, 1)
      slides.splice(to, 0, moved)
      return { ...d, slides }
    })
    setActiveIndex(to)
  }

  const triggerDownload = (blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(deck.title || 'apresentacao').replace(/[^\w-]+/g, '_').slice(0, 60)}.pptx`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // `fontMode`: 'universal' (web-safe faces, opens identically anywhere) or
  // 'brand' (the DS's real fonts, embedded in the .pptx for max fidelity — the
  // viewer sees the brand font even without it installed).
  const exportPptx = async (fontMode = 'universal') => {
    setExporting(true)
    setExportMenuOpen(false)
    try {
      // Pure-HTML deck: export native editable shapes (like Claude Design).
      // Render every slide full-size off-screen, extract paint-ops off the DOM,
      // and POST them; the server assembles the .pptx with pptxgenjs.
      const slidesHtml = (deck.slides || []).map((s) => (typeof s === 'string' ? s : s?.html))
      const slidesOps = await extractOpsFromSlides(slidesHtml, () => buildDeckTokenStyle(template), {
        fontMode,
        assetMap: buildDeckAssetMap(template),
      })
      const res = await fetch(`/api/decks/${deck.id}/export-html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // embedFonts asks the server to embed the DS font files into the .pptx
        body: JSON.stringify({ slides: slidesOps, embedFonts: fontMode === 'brand' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      triggerDownload(await res.blob())
    } catch (e) {
      pushToast?.(e.message || t('deckStudio.exportError'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className={`fixed inset-0 z-[70] flex flex-col bg-[var(--bg)] animate-fade-in
                 md:static md:inset-auto md:z-auto md:h-full
                 md:border-l md:border-[var(--border)] ${
                   focus || (htmlEditMode && isHtmlDeck)
                     ? 'md:flex-1 md:min-w-0'
                     : 'md:shrink-0 md:w-[45%] md:min-w-[420px] md:max-w-[760px]'
                 }`}
    >
      {/* toolbar */}
      <header className="shrink-0 h-14 flex items-center gap-2 md:gap-3 px-3 md:px-4 border-b border-[var(--border)]">
        <button onClick={requestClose} className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
          <Icon.Close size={20} />
        </button>
        <Icon.Presentation size={18} className="text-[var(--accent)]" />
        {deck ? (
          <input
            value={deck.title}
            onChange={(e) => setDeck((d) => ({ ...d, title: e.target.value }))}
            className="font-semibold text-sm bg-transparent outline-none border-b border-transparent focus:border-[var(--accent)] min-w-0 flex-1 md:flex-none md:max-w-md"
          />
        ) : (
          <span className="font-semibold text-sm">{t('deckStudio.title')}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {isHtmlDeck && deck && !deck.streaming && !htmlEditMode && (
            <button
              onClick={() => setHtmlEditMode(true)}
              className="flex items-center gap-1.5 rounded-lg font-semibold text-xs px-2.5 py-1.5 transition text-[var(--muted)] hover:bg-[var(--surface-3)] border border-transparent"
              title={t('deckStudio.htmlEdit.toggleTitle')}
            >
              <Icon.Pencil size={14} /> <span className="hidden sm:inline">{t('deckStudio.htmlEdit.toggle')}</span>
            </button>
          )}
          {isHtmlDeck && deck && !deck.streaming && htmlEditMode && (
            // commit-based editing: explicit Discard / Save (Claude Design style).
            // Both exit Edit mode; Save is disabled until there are changes.
            <div className="flex items-center gap-1.5 mr-1">
              {savedFlash && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)] animate-fade-in mr-0.5" aria-live="polite">
                  <Icon.Check size={13} /> {t('deckStudio.htmlEdit.saved')}
                </span>
              )}
              <button
                onClick={() => {
                  discardHtmlEdits()
                  setHtmlSel(null)
                  htmlEditorRef.current?.clear()
                  setHtmlEditMode(false)
                }}
                className="rounded-lg font-semibold text-xs px-2.5 py-1.5 border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-3)] transition"
                title={t('deckStudio.htmlEdit.discardEditsTitle')}
              >
                {t('deckStudio.htmlEdit.discardEdits')}
              </button>
              <button
                onClick={async () => {
                  await saveHtmlEdits()
                  setHtmlSel(null)
                  htmlEditorRef.current?.clear()
                  setHtmlEditMode(false)
                }}
                disabled={!htmlDirty || htmlSaving}
                className="inline-flex items-center gap-1.5 rounded-lg font-semibold text-xs px-3 py-1.5 bg-[var(--accent)] text-white hover:brightness-110 disabled:opacity-50 transition"
                title={t('deckStudio.htmlEdit.saveEditsTitle')}
              >
                {htmlSaving && <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />}
                {t('deckStudio.htmlEdit.saveEdits')}
              </button>
            </div>
          )}
          <button
            onClick={onToggleFocus}
            className="hidden md:block p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
            title={focus ? t('deckStudio.toolbar.shrink') : t('deckStudio.toolbar.expand')}
          >
            {focus ? <Icon.Shrink size={16} /> : <Icon.Expand size={16} />}
          </button>
          {/* deck actions apply only to editable HTML decks — a legacy deck shows
              just the close button + the "old format" notice below */}
          {isHtmlDeck && (
          <>
          <button
            onClick={() => setPresenting(true)}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.present')}
          >
            <Icon.Play size={16} />
          </button>
          <button
            onClick={addSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.addSlide')}
          >
            <Icon.Plus size={17} />
          </button>
          <button
            onClick={duplicateSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.duplicate')}
          >
            <Icon.Copy size={16} />
          </button>
          <button
            onClick={deleteSlide}
            disabled={!deck || deck.slides.length <= 1}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.deleteSlide')}
          >
            <Icon.Trash size={16} />
          </button>
          {/* HTML decks offer a font-fidelity choice on export */}
          <div className="relative ml-1 md:ml-2 shrink-0">
            <button
              onClick={() => setExportMenuOpen((o) => !o)}
              disabled={!deck || exporting}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm px-3 md:px-3.5 py-2 transition"
              title={t('deckStudio.exportPptx')}
            >
              <Icon.Download size={15} />
              <span className="hidden sm:inline">{exporting ? t('deckStudio.exporting') : t('deckStudio.exportPptx')}</span>
              {!exporting && <Icon.ChevronRight size={12} className="rotate-90 -mr-0.5 opacity-80" />}
            </button>
            {exportMenuOpen && !exporting && (
              <>
                <div className="fixed inset-0 z-[75]" onClick={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1.5 z-[80] w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl p-1.5 animate-fade-in">
                  <button
                    onClick={() => exportPptx('universal')}
                    className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--surface-3)] transition"
                  >
                    <div className="text-sm font-semibold text-[var(--text)]">{t('deckStudio.export.universalTitle')}</div>
                    <div className="text-[11px] text-[var(--muted)] leading-snug mt-0.5">{t('deckStudio.export.universalBody')}</div>
                  </button>
                  <button
                    onClick={() => exportPptx('brand')}
                    className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--surface-3)] transition"
                  >
                    <div className="text-sm font-semibold text-[var(--text)] flex items-center gap-1.5">
                      {t('deckStudio.export.brandTitle')}
                      <span className="text-[9px] font-bold uppercase tracking-wide text-[var(--accent)] bg-[var(--accent-soft)] rounded px-1 py-0.5">{t('deckStudio.export.brandBadge')}</span>
                    </div>
                    <div className="text-[11px] text-[var(--muted)] leading-snug mt-0.5">{t('deckStudio.export.brandBody')}</div>
                  </button>
                </div>
              </>
            )}
          </div>
          </>
          )}
        </div>
      </header>

      {loadError && !loading ? (
        <div className="flex-1 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <p className="text-sm text-[var(--muted)] max-w-sm">{t('deckStudio.loadFailed', { error: loadError })}</p>
            <button
              onClick={() => setLoadTick((n) => n + 1)}
              className="rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm px-4 py-2 transition"
            >
              {t('deckStudio.retry')}
            </button>
          </div>
        </div>
      ) : loading || !deck ? (
        <div className="flex-1 grid place-items-center text-sm text-[var(--faint)]">{t('deckStudio.loading')}</div>
      ) : !isHtmlDeck ? (
        // Legacy deck: generated by the old semantic-tree engine (removed). Its
        // slides aren't HTML, so the HTML Studio can't render or edit them —
        // show a clear notice instead of a blank canvas that reads as "broken".
        <div className="flex-1 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center px-6 max-w-sm">
            <Icon.Presentation size={28} className="text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--text)]">{t('deckStudio.legacy.title')}</p>
            <p className="text-sm text-[var(--muted)]">{t('deckStudio.legacy.body')}</p>
          </div>
        </div>
      ) : (
        // Pure-HTML deck layout (Claude-Design-style): thumbnail rail · stage +
        // speaker notes · (Edit mode) DOM inspector. The stage swaps between the
        // read-only frame and the directly-editable one based on htmlEditMode.
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* thumbnail rail */}
          <div className="flex md:block shrink-0 md:w-52 gap-2 md:gap-0 border-b md:border-b-0 md:border-r border-[var(--border)] overflow-x-auto md:overflow-x-visible md:overflow-y-auto p-3 md:space-y-2">
            {deck.slides.map((s, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  reorder(dragFrom.current, i)
                  dragFrom.current = null
                }}
                onClick={() => setActiveIndex(i)}
                className={`relative rounded-lg cursor-pointer ring-2 transition animate-fade-in shrink-0 w-32 md:w-auto ${
                  i === activeIndex ? 'ring-[var(--accent)]' : 'ring-transparent hover:ring-[var(--border)]'
                }`}
                style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
              >
                <HtmlSlideFrame html={typeof s === 'string' ? s : s?.html} template={template} title={`${deck.title} — ${i + 1}`} className="rounded-lg" />
                <span className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[10px] font-semibold grid place-items-center">
                  {i + 1}
                </span>
              </div>
            ))}
          </div>

          {/* stage + create toolbar + AI bar + speaker notes */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* create-asset toolbar (Edit mode only) */}
            {htmlEditMode && slide && (
              <div className="shrink-0 flex items-center justify-center gap-2 px-6 pt-3 pb-1 animate-fade-in">
                <HtmlEditToolbar
                  tool={htmlTool}
                  onTool={(tName) => {
                    setHtmlTool(tName)
                    htmlEditorRef.current?.setTool(tName)
                  }}
                  onImage={(dataUrl) => htmlEditorRef.current?.createImage(dataUrl)}
                  onUndo={htmlUndo}
                  onRedo={htmlRedo}
                  canUndo={htmlHist.current.past.length > 0}
                  canRedo={htmlHist.current.future.length > 0}
                />
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-2 pb-2">
              <div className="mx-auto w-full" style={{ maxWidth: 'calc((100dvh - 15rem) * 1.7778)' }}>
                {slide ? (
                  htmlEditMode ? (
                    <HtmlSlideEditor
                      ref={htmlEditorRef}
                      html={slideHtml(slide)}
                      template={template}
                      tool={htmlTool}
                      title={`${deck.title} — ${activeIndex + 1}`}
                      className={`w-full rounded-lg shadow-lg ring-1 ring-[var(--accent)]/40 ${htmlTool !== 'select' ? 'cursor-crosshair' : ''}`}
                      onSelect={(paths, info) => setHtmlSel({ paths, info })}
                      onDeselect={() => setHtmlSel(null)}
                      onChange={(newHtml) => setHtmlSlide(activeIndex, newHtml)}
                      onContextMenu={(m) => setHtmlMenu(m)}
                      onDismissMenu={() => setHtmlMenu(null)}
                      onToolDone={() => setHtmlTool('select')}
                    />
                  ) : (
                    <HtmlSlideFrame
                      html={slideHtml(slide)}
                      template={template}
                      title={`${deck.title} — ${activeIndex + 1}`}
                      className="w-full rounded-lg shadow-lg"
                    />
                  )
                ) : (
                  <HtmlSlideSkeleton streaming={deck.streaming} label={t('deckStudio.building')} />
                )}
                {htmlEditMode && slide && (
                  <p className="text-[11px] text-[var(--faint)] text-center mt-2">
                    {htmlTool === 'select' ? t('deckStudio.htmlEdit.canvasHint') : t('deckStudio.htmlEdit.drawHint')}
                  </p>
                )}
              </div>
            </div>

            {/* AI edit bar (Edit mode) — slide / deck / selected element, with a
                reversible preview (Accept / Discard). */}
            {htmlEditMode && slide && (
              <div className="shrink-0 px-6 pb-1">
                <div className="mx-auto w-full" style={{ maxWidth: 'calc((100dvh - 15rem) * 1.7778)' }}>
                  {tweakPreview ? (
                    <div className="flex items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 animate-fade-in">
                      <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                      <span className="text-xs text-[var(--text)] flex-1 min-w-0 truncate" title={tweakPreview.label}>
                        {t('deckStudio.tweak.previewLabel', { label: tweakPreview.label })}
                      </span>
                      {tweakCost && <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} className="text-[11px] shrink-0" />}
                      <button onClick={discardHtmlTweak} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[var(--muted)] font-semibold text-xs px-2.5 py-1.5 shrink-0">
                        {t('deckStudio.tweak.discard')}
                      </button>
                      <button onClick={acceptHtmlTweak} className="rounded-lg bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-xs px-2.5 py-1.5 shrink-0">
                        {t('deckStudio.tweak.accept')}
                      </button>
                    </div>
                  ) : (
                    <div>
                    <PromptImageStrip images={tweakImages.images} onRemove={tweakImages.removeAt} />
                    <div className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5">
                        <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                        <input
                          value={tweak}
                          onChange={(e) => setTweak(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && submitHtmlTweak()}
                          onPaste={tweakImages.onPaste}
                          placeholder={
                            tweakWholeDeck
                              ? t('deckStudio.tweak.placeholderDeck')
                              : htmlSel && !htmlSel.info?.multi
                                ? t('deckStudio.htmlEdit.aiPlaceholderEl')
                                : t('deckStudio.tweak.placeholderSlide')
                          }
                          disabled={tweaking}
                          className="flex-1 bg-transparent text-sm py-2 outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
                        />
                        <button
                          onClick={() => tweakImageInput.current?.click()}
                          disabled={tweaking}
                          className="shrink-0 p-1 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-50 transition"
                          title={t('deckStudio.tweak.attachImage')}
                        >
                          <Icon.Paperclip size={16} />
                        </button>
                        <input
                          ref={tweakImageInput}
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => { tweakImages.addFiles(e.target.files); e.target.value = '' }}
                        />
                      </div>
                      <button
                        onClick={submitHtmlTweak}
                        disabled={(!tweak.trim() && !tweakImages.images.length) || tweaking}
                        className="rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-xs px-3 py-2.5 transition shrink-0 inline-flex items-center gap-1.5"
                      >
                        {tweaking && <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />}
                        {t('deckStudio.tweak.apply')}
                      </button>
                    </div>
                    </div>
                  )}
                  {!tweakPreview && (
                    <label className="flex items-center gap-1.5 text-[10px] text-[var(--muted)] cursor-pointer w-fit mt-1">
                      <input type="checkbox" checked={tweakWholeDeck} onChange={(e) => setTweakWholeDeck(e.target.checked)} />
                      {t('deckStudio.tweak.wholeDeckToggle')}
                    </label>
                  )}
                </div>
              </div>
            )}

            {/* speaker notes — always editable (converts a string slide to {html,notes}) */}
            <div className="shrink-0 border-t border-[var(--border)] px-6 py-2.5">
              <div className="mx-auto w-full flex items-start gap-2" style={{ maxWidth: 'calc((100dvh - 15rem) * 1.7778)' }}>
                <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)] w-20 shrink-0 pt-1.5">
                  {t('deckStudio.field.notes')}
                </label>
                <textarea
                  value={(typeof slide === 'object' && slide?.notes) || ''}
                  onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                  rows={1}
                  disabled={!slide}
                  placeholder={t('deckStudio.field.notesPlaceholder')}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)] disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* DOM inspector — only in Edit mode */}
          {htmlEditMode && slide && (
            <div className="shrink-0 md:w-72 border-t md:border-t-0 md:border-l border-[var(--border)] bg-[var(--surface-2)] flex flex-col min-h-0 max-h-[45vh] md:max-h-none animate-fade-in">
              <HtmlSlideInspector
                html={slideHtml(slide)}
                selectedPaths={htmlSel?.paths ?? []}
                selectedInfo={htmlSel?.info ?? null}
                onSelectPath={(path, additive) => {
                  const cur = htmlSel?.paths || []
                  const next = additive ? (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]) : [path]
                  htmlEditorRef.current?.select(next)
                }}
                onStyle={(style) => htmlEditorRef.current?.applyStyle(htmlSel?.paths, style)}
                onText={(text) => {
                  const p = htmlSel?.paths?.[0]
                  if (!p) return
                  setHtmlSel((s) => (s ? { ...s, info: { ...s.info, text } } : s))
                  htmlEditorRef.current?.setText(p, text)
                }}
                onAttr={(attr, value) => {
                  const p = htmlSel?.paths?.[0]
                  if (p) htmlEditorRef.current?.setAttr(p, attr, value)
                }}
                onOp={(op) => htmlOp(op)}
                onMove={(from, to, position) => htmlEditorRef.current?.move(from, to, position)}
              />
            </div>
          )}
        </div>
      )}
      {presenting && deck && <PresentMode deck={deck} template={template} onClose={() => setPresenting(false)} />}
      <HtmlEditContextMenu
        menu={htmlMenu}
        canPaste={!!htmlClip?.length}
        onAction={(action) => htmlOp(action)}
        onClose={() => setHtmlMenu(null)}
      />

      {/* unsaved-edits guard: closing the Studio mid-edit asks Save/Discard/Cancel */}
      {closeConfirm && (
        <div className="fixed inset-0 z-[140] grid place-items-center bg-black/50 animate-fade-in" onClick={() => setCloseConfirm(false)}>
          <div className="w-[min(92vw,26rem)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text)]">{t('deckStudio.htmlEdit.closeConfirmTitle')}</h3>
            <p className="text-[13px] text-[var(--muted)] mt-1.5 leading-relaxed">{t('deckStudio.htmlEdit.closeConfirmBody')}</p>
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                onClick={() => setCloseConfirm(false)}
                className="rounded-lg border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-3)] font-semibold text-xs px-3 py-2 transition"
              >
                {t('deckStudio.htmlEdit.closeConfirmCancel')}
              </button>
              <button
                onClick={confirmCloseDiscard}
                className="rounded-lg border border-[var(--border)] text-[var(--danger,#e5484d)] hover:bg-[var(--surface-3)] font-semibold text-xs px-3 py-2 transition"
              >
                {t('deckStudio.htmlEdit.closeConfirmDiscard')}
              </button>
              <button
                onClick={confirmCloseSave}
                disabled={htmlSaving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] text-white hover:brightness-110 disabled:opacity-50 font-semibold text-xs px-3.5 py-2 transition"
              >
                {htmlSaving && <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />}
                {t('deckStudio.htmlEdit.closeConfirmSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
