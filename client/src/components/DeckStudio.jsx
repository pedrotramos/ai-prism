import { useCallback, useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import HtmlSlideFrame, { buildDeckTokenStyle } from './deck/HtmlSlideFrame.tsx'
import HtmlSlideEditor from './deck/HtmlSlideEditor.tsx'
import HtmlSlideInspector from './deck/HtmlSlideInspector.tsx'
import HtmlEditToolbar from './deck/HtmlEditToolbar.tsx'
import HtmlEditContextMenu from './deck/HtmlEditContextMenu.tsx'
import { extractOpsFromSlides } from '../lib/domToSlideOps.ts'
import { buildDeckAssetMap } from '../lib/deckAssets.ts'
import { getJSON } from '../api.ts'
import { useT } from '../lib/i18n.jsx'
import { notifyUsageChanged } from './CostMeter.jsx'
import { usePromptImages } from '../hooks/usePromptImages.ts'
import { tweakImagePayload } from '../lib/promptImages.ts'
import StudioAIPanel from './studio/StudioAIPanel.tsx'
import StudioExportMenu from './studio/StudioExportMenu.tsx'
import {
  SaveStatus,
  StudioCloseButton,
  StudioConfirmDialog,
  StudioIconButton,
  StudioSnackbar,
  prefersReducedMotion,
  useHistoryBack,
  useIsMobile,
  useSaveStatus,
  useStudioDialog,
} from './studio/StudioChrome.tsx'
import { clearDeckUndo, deckFingerprint, isHtmlDeckShape, readDeckUndo, restoreSlide, undoTimeLeft, writeDeckUndo } from './deck/deckStudioModel.ts'
import { DECK_IMAGE_MAX_BYTES, DECK_MAX_IMAGES, budgetMessage, deckRequest, filesOverBudget, imagesOverBudget, noteOverBudget } from './deck/deckInputBudgets.ts'

// The AI-edit attachments with their budget said out loud (W2-16): the attach
// hook drops an image over 6 MiB, or past the 4th, without a word; this wrapper
// tells the user which ones were not attached and why. Same handle shape as
// usePromptImages, so StudioAIPanel is unchanged.
//
// The 4-image budget is settled SYNCHRONOUSLY: the hook reads files async and
// its state lands a render later, so two selections in quick succession would
// each see the same count and the hook would cut the overflow silently (QA
// W2-16 r1). `slots` counts attached + in-flight images, is reserved the
// moment a batch arrives, and only the files that got a slot reach the hook;
// the rest are announced. Once nothing is in flight, the rendered count is the
// truth again (a removal, or a file the hook could not decode).
function useAttachBudget(images, pushToast, t) {
  const { addFiles: add } = images
  const slots = useRef(0)
  const inFlight = useRef(0)
  if (inFlight.current === 0) slots.current = images.images.length
  const addFiles = useCallback(
    (list) => {
      const files = Array.from(list || [])
      const { admitted, tooLarge, overCount } = filesOverBudget(slots.current, files)
      slots.current += admitted.length
      if (tooLarge.length) pushToast?.({ message: t('deckStudio.budget.filesTooLarge', { limit: `${DECK_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`, names: tooLarge.join(', ') }), tone: 'error' })
      if (overCount) pushToast?.({ message: t('deckStudio.budget.filesOverCount', { limit: DECK_MAX_IMAGES }), tone: 'error' })
      if (!admitted.length) return Promise.resolve()
      inFlight.current++
      return Promise.resolve(add(admitted)).finally(() => {
        inFlight.current--
      })
    },
    [add, pushToast, t],
  )
  const onPaste = useCallback(
    (e) => {
      const files = []
      for (const it of e.clipboardData?.items || []) {
        if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
          const blob = it.getAsFile()
          if (blob) files.push(blob)
        }
      }
      if (!files.length) return false
      e.preventDefault()
      addFiles(files)
      return true
    },
    [addFiles],
  )
  return { ...images, addFiles, onPaste }
}

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
  // a projector surface: black letterbox and white controls in both themes
  /* data:start projector surface: fixed colours in both themes */
  return (
    <div role="dialog" aria-modal="true" aria-label={deck.title} className="fixed inset-0 z-fullscreen bg-black text-white flex flex-col items-center justify-center motion-safe:animate-fade-in">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-raised min-w-10 min-h-10 grid place-items-center rounded-control opacity-60 hover:opacity-100 hover:bg-white/10"
        aria-label={t('deckStudio.present.exit')}
        title={t('deckStudio.present.exit')}
      >
        <Icon.Close size={20} aria-hidden />
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
          className="w-full shadow-modal"
        />
      </div>
      <div className="absolute bottom-4 opacity-60 text-caption tabular-nums select-none" aria-live="polite">
        {t('deckStudio.present.nav', { current: index + 1, total: n })}
      </div>
      {slide?.notes && (
        <div className="absolute bottom-10 max-w-2xl text-center opacity-60 text-caption px-6 line-clamp-2" title={slide.notes}>
          🗒 {slide.notes}
        </div>
      )}
    </div>
  )
  /* data:end */
}

function emptySlide() {
  return { html: '<section class="slide"></section>' }
}


// Shown on the stage while a pure-HTML deck is streaming and the current slide
// hasn't arrived yet — a shimmering 16:9 placeholder (title bar + content
// blocks) so the auto-opened Studio reads as "building", not a blank white box.
function HtmlSlideSkeleton({ streaming, label }) {
  /* data:start skeleton proportions mirror a 16:9 slide */
  return (
    <div className="w-full aspect-video rounded-card shadow-raised overflow-hidden border border-border bg-surface-2" aria-hidden>
      <div className="h-full w-full p-[6%] flex flex-col gap-[3%]">
        <div className="h-[4%] w-[22%] rounded-badge bg-surface-3 motion-safe:animate-pulse" />
        <div className="h-[9%] w-[70%] rounded-badge bg-surface-3 motion-safe:animate-pulse" />
        <div className="flex-1 grid grid-cols-3 gap-[3%] mt-[2%]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card bg-surface-3 motion-safe:animate-pulse" /* data */ style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
        {streaming && label && <div className="text-center text-caption text-muted pt-[1%]">{label}</div>}
      </div>
    </div>
  )
  /* data:end */
}

// Live build progress (Goal-Gradient): "Building slide N of M" with a bar when
// the stream announced the total (outline and tool-driven paths send `total`),
// "Building slide N…" when it did not (the model writing the deck inline).
function StreamProgress({ received, total }) {
  const t = useT()
  const known = Number.isInteger(total) && total > 0
  const n = known ? Math.min(received + 1, total) : received + 1
  const text = known ? t('deckStudio.stream.progress', { n, total }) : t('deckStudio.stream.progressOpen', { n })
  return (
    <div
      role="progressbar"
      aria-label={t('deckStudio.stream.progressLabel')}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? total : undefined}
      aria-valuenow={known ? received : undefined}
      aria-valuetext={text}
      className="flex items-center gap-2 min-w-0 text-label text-muted"
    >
      <span className="inline-block w-2 h-2 rounded-pill bg-accent motion-safe:animate-pulse shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
      {known && (
        <span className="hidden sm:block w-24 h-1.5 rounded-pill bg-surface-3 overflow-hidden shrink-0" aria-hidden>
          <span className="block h-full bg-accent transition-[width] duration-base" /* data */ style={{ width: `${Math.round((received / total) * 100)}%` }} />
        </span>
      )}
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
  // AI tweak (HTML decks): instruction + scope ('slide' | 'element' | 'deck')
  const [tweak, setTweak] = useState('')
  const [tweakScope, setTweakScope] = useState('slide')
  const [tweaking, setTweaking] = useState(false)
  // images attached to the AI tweak prompt (paste or attach) — sent as vision
  // input so the model can edit from a reference screenshot/design (item 9)
  const promptImages = usePromptImages()
  const tweakImages = useAttachBudget(promptImages, pushToast, t)
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
  const htmlDirtyRef = useRef(false)
  htmlDirtyRef.current = htmlDirty
  const htmlBaseline = useRef(null)
  const [htmlSaving, setHtmlSaving] = useState(false)
  const htmlEditModeRef = useRef(false)
  // leaving Edit mode or the Studio with unsaved manual edits asks Save /
  // Discard / Cancel instead of silently dropping them: null | 'close' | 'exit'
  const [closeConfirm, setCloseConfirm] = useState(null)
  // every write (autosave and explicit Save) reports here: Saving… / Saved /
  // Couldn't save + Retry — a failure stays on screen instead of a passing toast
  const save = useSaveStatus()
  const deckRef = useRef(null)
  deckRef.current = deck
  // optimistic concurrency (N6): the revision the working deck is based on (kept out of
  // `deck` so tracking it never triggers an autosave) and, after a 409 deck_conflict,
  // { deck: the server's current deck, open } — saves stop until the user picks a side
  const revisionRef = useRef(null)
  const [conflict, setConflictState] = useState(null)
  const [aiBusy, setAiBusy] = useState(false) // another AI edit holds this deck (409 deck_busy)
  const conflictRef = useRef(null)
  const setConflict = (c) => {
    conflictRef.current = c
    setConflictState(c)
  }
  // delete-slide undo offer { deckId, index, slide, at, n, afterHash } (see readDeckUndo);
  // the ref lets a save that lands later stamp the offer with what it wrote
  const [undoDel, setUndoDelState] = useState(null)
  const undoRef = useRef(null)
  const setUndoDel = (u) => {
    undoRef.current = u
    setUndoDelState(u)
  }
  // Peak-End: "Deck ready · N slides" once a live-built deck lands
  const [completion, setCompletion] = useState(null)
  const wasStreaming = useRef(false)
  const mobile = useIsMobile()
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open || !deckId) return
    skipNextSave.current = true
    setLoading(true)
    setLoadError(null)
    setActiveIndex(0)
    Promise.all([getJSON(`/api/decks/${deckId}`), getJSON('/api/deck-templates/selected')])
      .then(([d, t]) => {
        setDeck(d.deck)
        revisionRef.current = Number.isInteger(d.deck?.revision) ? d.deck.revision : null
        setConflict(null)
        setTemplate(t.template || null)
        save.reset()
        setUndoDel(readDeckUndo(d.deck))
        if (wasStreaming.current) {
          wasStreaming.current = false
          setCompletion({ n: d.deck?.slides?.length || 0 })
        }
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
    wasStreaming.current = true
    setCompletion(null)
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
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      // widgets that own their arrow keys (the AI scope radios, tabs, sliders…)
      const ownsArrows = !!t?.closest?.('[role="radio"],[role="tab"],[role="slider"],[role="option"],[role="listbox"],[role="combobox"],[role="spinbutton"],[role="grid"]')
      // the deck is a side panel on desktop: only keys aimed at it change slide,
      // so the chat beside it keeps its own arrow-key scrolling
      const inStudio = !!rootRef.current?.contains(t)
      const meta = ev.metaKey || ev.ctrlKey
      const hk = hotkeysRef.current
      if (hk.blocked || ev.defaultPrevented) return
      // menus, dialogs and the thumbnail drag own their keys
      if (t?.closest?.('[role="menu"],[role="dialog"]:not([data-studio]),[role="alertdialog"]')) return
      // arrows / PageUp-Down / Home-End change slide unless the user is typing
      // or a selection is being edited on the canvas (the frame nudges it)
      const navKeys = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }
      if (inStudio && !inField && !ownsArrows && !(ev.metaKey || ev.ctrlKey || ev.altKey) && !(hk.htmlActive && hk.hasSel)) {
        if (ev.key in navKeys) {
          ev.preventDefault()
          hk.nav?.(navKeys[ev.key])
          return
        }
        if (ev.key === 'Home' || ev.key === 'End') {
          ev.preventDefault()
          ev.key === 'Home' ? hk.home?.() : hk.end?.()
          return
        }
      }
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
          // first Esc drops the selection, the next one leaves Edit mode
          hk.escape?.()
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
    saveTimer.current = setTimeout(() => save.run(writeLatest), 500)
    return () => clearTimeout(saveTimer.current)
  }, [deck]) // eslint-disable-line react-hooks/exhaustive-deps

  // the undo offer expires after 30 minutes even if the Studio stays open
  // (readDeckUndo only enforces it on load); Undo also re-checks on use
  useEffect(() => {
    if (!undoDel) return undefined
    const id = setTimeout(() => {
      clearDeckUndo(undoDel.deckId)
      setUndoDel(null)
    }, Math.max(0, undoTimeLeft(undoDel)))
    return () => clearTimeout(id)
  }, [undoDel]) // eslint-disable-line react-hooks/exhaustive-deps

  // the Completion banner fades after a few seconds (it is also announced)
  useEffect(() => {
    if (!completion) return undefined
    const id = setTimeout(() => setCompletion(null), 8000)
    return () => clearTimeout(id)
  }, [completion])

  // phones: the system Back leaves the Studio (asks first with unsaved edits)
  useHistoryBack(open && mobile, () => {
    if (htmlEditModeRef.current && isHtmlDeckRef.current && htmlDirtyRef.current) {
      setCloseConfirm('close')
      return false
    }
    onClose?.()
    return true
  })
  // on phones the Studio covers the app: a modal dialog with its own Tab loop
  useStudioDialog(rootRef, open && mobile)

  if (!open) return null

  // one PATCH of the current working deck — the autosave and Retry both call
  // this, so a retry writes what is on screen now, not a stale snapshot
  // Runs inside the serialized save queue, so it reads the deck when it RUNS.
  function writeLatest() {
    const d = deckRef.current
    if (!d?.id) return Promise.resolve(true)
    // a conflict is waiting for a decision: never re-send (no autosave loop on 409);
    // Retry brings the dialog back instead
    if (conflictRef.current) {
      setConflict({ ...conflictRef.current, open: true })
      return Promise.reject(new Error(t('deckStudio.conflict.title')))
    }
    // only a write that STARTED after the deletion may stamp its offer: one
    // already in flight carries the slide and would make a stale offer look valid
    const offerId = undoRef.current?.id
    const body = { title: d.title, slides: d.slides, audience: d.audience, author: d.author, narrative: d.narrative }
    if (Number.isInteger(revisionRef.current)) body.baseRevision = revisionRef.current
    // input budgets (W2-16): a note over 9 MiB is refused here, before the
    // upload, and by the server; either way the write fails like any failed
    // save (Couldn't save + Retry) with the limit named, and the deck on
    // screen stays as typed, editable, until it fits
    const over = noteOverBudget(d.slides)
    if (over) return Promise.reject(new Error(budgetMessage(t, over)))
    return deckRequest('PATCH', `/api/decks/${d.id}`, body).catch((e) => {
      if (e.conflict) {
        setConflict({ deck: e.conflict, open: true })
        throw new Error(t('deckStudio.conflict.title'))
      }
      throw e.budget ? new Error(budgetMessage(t, e.budget)) : e
    }).then((r) => {
      if (Number.isInteger(r?.deck?.revision)) revisionRef.current = r.deck.revision
      // an open undo offer is stamped with the content the SERVER now holds (its
      // response; the request body for a server that does not echo it) — a
      // reload with any other content means someone else changed the deck
      const u = undoRef.current
      if (u && offerId && u.id === offerId && u.deckId === d.id) {
        const stamped = { ...u, afterHash: deckFingerprint(r?.deck || body) }
        undoRef.current = stamped
        writeDeckUndo(stamped)
      }
      // Let the chat's deck card (DeckBlock) know its persisted deck changed so
      // it can re-fetch and reflect live edits (its block.slides is a snapshot
      // frozen at generation time). Fire only after the write lands.
      window.dispatchEvent(new CustomEvent('prism:deck-saved', { detail: { deckId: d.id } }))
      return true
    })
  }
  // commit an Edit-mode save: write, then the written deck is the new baseline
  async function writeCommitted() {
    await writeLatest()
    htmlBaseline.current = deckRef.current
    setHtmlDirty(false)
    return true
  }
  // Retry writes what is on screen NOW (Edit mode: that is a Save)
  save.retryRef.current = () => (htmlEditModeRef.current && isHtmlDeckRef.current ? writeCommitted() : writeLatest())

  const slide = deck?.slides?.[activeIndex]
  // a speaker note over its budget (any slide): shown under the notes field
  const noteBudget = noteOverBudget(deck?.slides)
  // HTML deck (deck-html engine): slides are self-contained <section> strings
  // the API spreads the row's meta onto the deck (format: 'html' at the top);
  // streamed decks carry meta.format; a slide with notes is {html, notes}, so
  // the first slide's type alone is not enough (it made a deck with a note on
  // slide 1 read as "legacy")
  const isHtmlDeck = isHtmlDeckShape(deck)
  isHtmlDeckRef.current = isHtmlDeck
  const singleSel = htmlSel?.paths?.length === 1 && !htmlSel.info?.multi
  const effectiveScope = tweakScope === 'element' && !singleSel ? 'slide' : tweakScope

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
    // input budgets (W2-16): nothing is sent over them; the instruction and
    // the attachments stay so the user can fix and resend
    const images = tweakImagePayload(tweakImages.images)
    const over = noteOverBudget(deck.slides) || imagesOverBudget(images)
    if (over) {
      pushToast?.({ message: budgetMessage(t, over), tone: 'error' })
      return
    }
    setTweaking(true)
    setTweakCost(null) // don't flash the previous edit's cost while this one runs
    try {
      const wholeDeck = effectiveScope === 'deck'
      const selPayload =
        effectiveScope === 'element'
          ? { path: htmlSel.paths[0], htmlOuter: extractNodesHtml(slideHtml(deck.slides[activeIndex]), htmlSel.paths)[0] || null }
          : null
      const r = await deckRequest('POST', `/api/decks/${deck.id}/tweak`, {
        instruction,
        slideIndex: wholeDeck ? null : activeIndex,
        selection: selPayload,
        // Send the working copy so the AI edits what the user is looking at —
        // including manual edits that haven't been saved yet — not the last
        // persisted version (item 4).
        slides: deck.slides,
        baseRevision: revisionRef.current ?? undefined,
        // attached images (item 9): `dataUrl` is the ORIGINAL the server splices
        // in when the model inserts it as a real asset (keeps SVG vector). A
        // raster is also what the model SEES, so it travels once; only an SVG
        // sends a separate raster `visionUrl`. See parseInlineImages.
        images,
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
      notifyUsageChanged() // the AI edit is on the taxímetro now
      setTweak('')
      tweakImages.clear()
    } catch (e) {
      if (e.conflict) setConflict({ deck: e.conflict, open: true })
      else if (e.busy) setAiBusy(true)
      else if (e.budget) pushToast?.({ message: budgetMessage(t, e.budget), tone: 'error' })
      else pushToast?.(e.message || t('deckStudio.tweakError'))
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
    clearTimeout(saveTimer.current)
    const ok = await save.run(writeCommitted)
    setHtmlSaving(false)
    return ok
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

  // ---- deck_conflict (N6): another tab / session saved first ---------------------
  // Reload theirs: take the server's deck as the working copy (this tab's unsaved edits go).
  const conflictReload = () => {
    const c = conflictRef.current
    if (!c) return
    skipNextSave.current = true
    setDeck(c.deck)
    revisionRef.current = Number.isInteger(c.deck?.revision) ? c.deck.revision : null
    setConflict(null)
    save.reset()
    setTweakPreview(null)
    setTweakCost(null)
    htmlEditPreview.current = null
    htmlHist.current = { past: [], future: [] }
    setHtmlHistTick((n) => n + 1)
    setHtmlSel(null)
    setHtmlDirty(false)
    htmlBaseline.current = c.deck
    const idx = Math.min(activeIndex, Math.max(0, (c.deck?.slides?.length || 1) - 1))
    if (idx !== activeIndex) setActiveIndex(idx)
    if (c.deck?.slides?.[idx]) htmlEditorRef.current?.setHtml(slideHtml(c.deck.slides[idx]), true)
  }
  // Keep mine: re-send this tab's deck on top of theirs, explicitly, with the new base.
  const conflictOverwrite = () => {
    const c = conflictRef.current
    if (!c) return
    revisionRef.current = Number.isInteger(c.deck?.revision) ? c.deck.revision : null
    setConflict(null)
    clearTimeout(saveTimer.current)
    save.run(htmlEditModeRef.current && isHtmlDeckRef.current ? writeCommitted : writeLatest)
  }

  // Closing the Studio with unsaved manual edits must not drop them silently:
  // intercept the close and raise a Save / Discard / Cancel confirmation. When
  // clean (or not editing), close straight through.
  const requestClose = () => {
    if (htmlEditMode && isHtmlDeck && htmlDirty) {
      setCloseConfirm('close')
      return
    }
    onClose?.()
  }
  // Esc (or the toolbar) leaves Edit mode; with unsaved edits it asks first
  const leaveEditMode = () => {
    setHtmlSel(null)
    htmlEditorRef.current?.clear()
    setHtmlEditMode(false)
  }
  const requestExitEdit = () => {
    if (htmlDirty) {
      setCloseConfirm('exit')
      return
    }
    leaveEditMode()
  }
  const confirmSave = async () => {
    const mode = closeConfirm
    const ok = await saveHtmlEdits()
    if (!ok) return // the failure stays on screen (Save status + Retry)
    setCloseConfirm(null)
    leaveEditMode()
    if (mode === 'close') onClose?.()
  }
  const confirmDiscard = () => {
    const mode = closeConfirm
    discardHtmlEdits()
    setCloseConfirm(null)
    leaveEditMode()
    if (mode === 'close') onClose?.()
  }
  const goSlide = (i) => setActiveIndex(Math.max(0, Math.min((deck?.slides?.length || 1) - 1, i)))

  // keep the global hotkey handler pointed at the live HTML-edit closures
  hotkeysRef.current = {
    blocked: presenting || !!closeConfirm,
    htmlActive: htmlEditMode && isHtmlDeck,
    escape: () => (htmlSel?.paths?.length ? hotkeysRef.current.clearSel() : requestExitEdit()),
    nav: (d) => isHtmlDeck && deck?.slides?.length && goSlide(activeIndex + d),
    home: () => goSlide(0),
    end: () => goSlide((deck?.slides?.length || 1) - 1),
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

  // No confirmation (Flow): deleting is one click and fully undoable — the
  // offer persists across a reload (sessionStorage) and Undo writes the slide
  // back through the autosave.
  const deleteSlide = () => {
    if (!deck || deck.slides.length <= 1) return
    const index = activeIndex
    // afterHash stays null until the deletion's own save lands (writeLatest)
    const at = Date.now()
    const u = { id: `${at}-${Math.random().toString(36).slice(2)}`, deckId: deck.id, index, slide: deck.slides[index], at, n: index + 1, afterHash: null }
    setDeck((d) => ({ ...d, slides: d.slides.filter((_, i) => i !== index) }))
    setActiveIndex((i) => Math.max(0, Math.min(i, deck.slides.length - 2)))
    setUndoDel(u)
    writeDeckUndo(u)
  }
  const undoDelete = () => {
    if (!undoDel) return
    const u = undoDel
    if (undoTimeLeft(u) <= 0) return dismissUndo()
    setDeck((d) => ({ ...d, slides: restoreSlide(d.slides, u.index, u.slide) }))
    setActiveIndex(Math.min(u.index, deck.slides.length))
    setUndoDel(null)
    clearDeckUndo(u.deckId)
  }
  const dismissUndo = () => {
    if (undoDel) clearDeckUndo(undoDel.deckId)
    setUndoDel(null)
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

  const canTweak = isHtmlDeck && !!deck && !deck.streaming && !!deck.id && !!slide
  /* data */ const stageMax = { maxWidth: 'calc((100dvh - 24rem) * 1.7778)' }
  const received = deck?.slides ? deck.slides.filter(Boolean).length : 0
  const aiPlaceholder =
    effectiveScope === 'deck'
      ? t('deckStudio.tweak.placeholderDeck')
      : effectiveScope === 'element'
        ? t('deckStudio.htmlEdit.aiPlaceholderEl')
        : t('deckStudio.tweak.placeholderSlide')

  // a <section> (region) on desktop scopes its <header>; a dialog on phones
  const Root = mobile ? 'div' : 'section'
  return (
    <Root
      ref={rootRef}
      data-studio="deck"
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile ? 'true' : undefined}
      aria-label={deck?.title || t('deckStudio.title')}
      tabIndex={-1}
      className={`fixed inset-0 z-studio flex flex-col bg-bg motion-safe:animate-fade-in
                 md:static md:inset-auto md:z-auto md:h-full
                 md:border-l md:border-border ${
                   focus || (htmlEditMode && isHtmlDeck)
                     ? 'md:flex-1 md:min-w-0'
                     : 'md:shrink-0 md:w-[45%] md:min-w-[420px] md:max-w-[760px]'
                 }`}
    >
      {/* header: back/close · title (wraps to 2 lines on phones) · mode · present · export */}
      <header className="shrink-0 min-h-14 flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1.5 border-b border-border">
        <StudioCloseButton mobile={mobile} onClick={requestClose} />
        <Icon.Presentation size={18} className="text-accent shrink-0 max-sm:hidden" aria-hidden />
        {deck ? (
          <textarea
            value={deck.title}
            rows={1}
            // textareas size to their content (index.css field-sizing): on phones
            // a long title wraps, capped at two lines; on desktop it stays one line
            wrap={mobile ? 'soft' : 'off'}
            aria-label={t('deckStudio.titleLabel')}
            onChange={(e) => {
              const title = e.target.value.replace(/\n/g, ' ')
              setDeck((d) => ({ ...d, title }))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            // grow to fill the header's free space and share the row with the
            // toolbar; on phones it wraps to two lines instead of "Q3 FY…"
            className="font-semibold text-body leading-snug bg-transparent border-b border-transparent focus:border-accent min-w-0 flex-1 resize-none overflow-hidden py-0.5 max-md:py-2.5 max-md:max-h-16 max-md:min-h-11"
          />
        ) : (
          <span className="font-semibold text-body min-w-0 flex-1 truncate">{t('deckStudio.title')}</span>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {isHtmlDeck && deck && !deck.streaming && !htmlEditMode && (
            <button
              type="button"
              onClick={() => setHtmlEditMode(true)}
              aria-label={t('deckStudio.htmlEdit.toggle')}
              title={t('deckStudio.htmlEdit.toggleTitle')}
              className="min-h-8 max-md:min-h-11 min-w-8 max-md:min-w-11 inline-flex items-center justify-center gap-1.5 rounded-control font-semibold text-label px-2 text-muted hover:text-fg hover:bg-surface-3 transition-colors duration-fast"
            >
              <Icon.Pencil size={14} aria-hidden /> <span className="max-sm:hidden">{t('deckStudio.htmlEdit.toggle')}</span>
            </button>
          )}
          {isHtmlDeck && deck && !deck.streaming && htmlEditMode && (
            // commit-based manual editing: explicit Discard / Save; both leave Edit mode
            <>
              <button
                type="button"
                onClick={() => {
                  discardHtmlEdits()
                  leaveEditMode()
                }}
                className="min-h-8 max-md:min-h-10 rounded-control font-semibold text-label px-2.5 border border-border text-muted hover:bg-surface-3 transition-colors duration-fast"
                title={t('deckStudio.htmlEdit.discardEditsTitle')}
              >
                {t('deckStudio.htmlEdit.discardEdits')}
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (await saveHtmlEdits()) leaveEditMode()
                }}
                disabled={!htmlDirty || htmlSaving}
                className="min-h-8 max-md:min-h-10 inline-flex items-center gap-1.5 rounded-control font-semibold text-label px-3 bg-accent-strong text-on-accent hover:brightness-110 disabled:bg-disabled disabled:text-disabled-text transition-colors duration-fast"
                title={t('deckStudio.htmlEdit.saveEditsTitle')}
              >
                {htmlSaving && <span className="w-3 h-3 rounded-pill border-2 border-current border-t-transparent motion-safe:animate-spin" aria-hidden />}
                {t('deckStudio.htmlEdit.saveEdits')}
              </button>
            </>
          )}
          <StudioIconButton
            label={focus ? t('deckStudio.toolbar.shrink') : t('deckStudio.toolbar.expand')}
            onClick={onToggleFocus}
            className="max-md:hidden"
          >
            {focus ? <Icon.Shrink size={16} aria-hidden /> : <Icon.Expand size={16} aria-hidden />}
          </StudioIconButton>
          {/* deck actions apply only to editable HTML decks — a legacy deck shows
              just the close button + the "old format" notice below */}
          {isHtmlDeck && (
            <>
              <StudioIconButton label={t('deckStudio.toolbar.present')} onClick={() => setPresenting(true)} disabled={!deck || !received}>
                <Icon.Play size={16} aria-hidden />
              </StudioIconButton>
              <StudioExportMenu
                busy={exporting}
                disabled={!deck || deck.streaming || !deck.id}
                options={[
                  {
                    id: 'universal',
                    label: t('deckStudio.export.universalTitle'),
                    description: t('deckStudio.export.universalBody'),
                    onSelect: () => exportPptx('universal'),
                  },
                  {
                    id: 'brand',
                    label: t('deckStudio.export.brandTitle'),
                    description: t('deckStudio.export.brandBody'),
                    badge: t('deckStudio.export.brandBadge'),
                    onSelect: () => exportPptx('brand'),
                  },
                ]}
              />
            </>
          )}
        </div>
      </header>

      {loadError && !loading ? (
        <div className="flex-1 grid place-items-center">
          <div role="alert" className="flex flex-col items-center gap-3 text-center px-6">
            <p className="text-body text-muted max-w-sm">{t('deckStudio.loadFailed', { error: loadError })}</p>
            <button
              type="button"
              onClick={() => setLoadTick((n) => n + 1)}
              className="min-h-9 rounded-control bg-accent-strong text-on-accent hover:brightness-110 font-semibold text-body px-4 transition-colors duration-fast"
            >
              {t('deckStudio.retry')}
            </button>
          </div>
        </div>
      ) : loading || !deck ? (
        <div role="status" className="flex-1 grid place-items-center text-body text-faint">{t('deckStudio.loading')}</div>
      ) : !isHtmlDeck ? (
        // Legacy deck: generated by the old semantic-tree engine (removed). Its
        // slides aren't HTML, so the HTML Studio can't render or edit them —
        // show a clear notice instead of a blank canvas that reads as "broken".
        <div className="flex-1 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center px-6 max-w-sm">
            <Icon.Presentation size={28} className="text-faint" aria-hidden />
            <p className="text-body font-semibold text-fg">{t('deckStudio.legacy.title')}</p>
            <p className="text-body text-muted">{t('deckStudio.legacy.body')}</p>
          </div>
        </div>
      ) : (
        // Pure-HTML deck layout (Claude-Design-style): thumbnail rail · slide
        // toolbar + stage + AI panel + speaker notes · (Edit mode) DOM inspector.
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* thumbnail rail */}
          <nav aria-label={t('deckStudio.slides')} className="shrink-0 md:w-52 border-b md:border-b-0 md:border-r border-border overflow-x-auto md:overflow-x-visible md:overflow-y-auto p-3">
            <ol className="flex md:flex-col gap-2">
              {deck.slides.map((s, i) => (
                <li
                  key={i}
                  draggable={!deck.streaming}
                  onDragStart={() => (dragFrom.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragFrom.current != null) reorder(dragFrom.current, i)
                    dragFrom.current = null
                  }}
                  className="relative shrink-0 w-32 md:w-auto motion-safe:animate-fade-in"
                  /* data */ style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                >
                  {s ? (
                    <HtmlSlideFrame decorative html={typeof s === 'string' ? s : s?.html} template={template} title={`${deck.title} — ${i + 1}`} className="rounded-card" />
                  ) : (
                    <div className="aspect-video rounded-card bg-surface-2 motion-safe:animate-pulse" aria-hidden />
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveIndex(i)}
                    aria-label={t('deckStudio.slideN', { n: i + 1 })}
                    aria-current={i === activeIndex ? 'true' : undefined}
                    className={`absolute inset-0 rounded-card ring-2 transition-shadow duration-fast ${
                      i === activeIndex ? 'ring-accent' : 'ring-transparent hover:ring-border'
                    }`}
                  />
                  <span aria-hidden className="pointer-events-none absolute -top-1.5 -left-1.5 w-5 h-5 rounded-pill bg-surface-3 border border-border text-caption font-semibold grid place-items-center">
                    {i + 1}
                  </span>
                </li>
              ))}
            </ol>
          </nav>

          {/* slide toolbar · create toolbar · stage · AI panel · speaker notes */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div role="toolbar" aria-label={t('deckStudio.slideActions')} className="shrink-0 flex items-center gap-1 px-3 md:px-4 py-1 border-b border-border-soft">
              {deck.streaming ? (
                <StreamProgress received={received} total={deck.total} />
              ) : completion ? (
                <span role="status" className="inline-flex items-center gap-1.5 text-label font-semibold text-success min-w-0">
                  <Icon.Check size={14} aria-hidden />
                  <span className="truncate">{completion.n === 1 ? t('deckStudio.stream.doneOne') : t('deckStudio.stream.doneMany', { n: completion.n })}</span>
                </span>
              ) : (
                <span className="text-label text-muted tabular-nums whitespace-nowrap">
                  {t('deckStudio.stage', { n: Math.min(activeIndex + 1, deck.slides.length), total: deck.slides.length })}
                </span>
              )}
              <span className="ml-auto" />
              {!deck.streaming && <SaveStatus status={save.status} error={save.error} onRetry={save.retry} dirty={htmlEditMode && htmlDirty} />}
              <StudioIconButton label={t('deckStudio.toolbar.addSlide')} onClick={addSlide} disabled={deck.streaming}>
                <Icon.Plus size={17} aria-hidden />
              </StudioIconButton>
              <StudioIconButton label={t('deckStudio.toolbar.duplicate')} onClick={duplicateSlide} disabled={deck.streaming || !slide}>
                <Icon.Copy size={16} aria-hidden />
              </StudioIconButton>
              <span role="separator" aria-orientation="vertical" className="w-px h-5 bg-border mx-1 shrink-0" />
              <StudioIconButton label={t('deckStudio.toolbar.deleteSlide')} tone="danger" onClick={deleteSlide} disabled={deck.streaming || deck.slides.length <= 1}>
                <Icon.Trash size={16} aria-hidden />
              </StudioIconButton>
            </div>

            {/* create-asset toolbar (Edit mode only) */}
            {htmlEditMode && slide && (
              <div className="shrink-0 flex items-center justify-center gap-2 px-6 pt-3 pb-1 motion-safe:animate-fade-in">
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
            {/* the stage is centred in the free height (ux#30) */}
            {/* tabIndex -1: a click on the stage puts keyboard focus in the Studio (arrows change slide) */}
            <div data-deck-stage tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 py-3 flex flex-col">
              <div className="my-auto mx-auto w-full" /* data */ style={stageMax}>
                {slide ? (
                  htmlEditMode ? (
                    <HtmlSlideEditor
                      ref={htmlEditorRef}
                      html={slideHtml(slide)}
                      template={template}
                      tool={htmlTool}
                      title={`${deck.title} — ${activeIndex + 1}`}
                      className={`w-full rounded-card shadow-raised ring-1 ring-accent/40 ${htmlTool !== 'select' ? 'cursor-crosshair' : ''}`}
                      onSelect={(paths, info) => setHtmlSel({ paths, info })}
                      onDeselect={() => setHtmlSel(null)}
                      onChange={(newHtml) => setHtmlSlide(activeIndex, newHtml)}
                      onContextMenu={(m) => setHtmlMenu(m)}
                      onDismissMenu={() => setHtmlMenu(null)}
                      onToolDone={() => setHtmlTool('select')}
                      onEscape={() => hotkeysRef.current.escape?.()}
                    />
                  ) : (
                    <HtmlSlideFrame html={slideHtml(slide)} template={template} title={`${deck.title} — ${activeIndex + 1}`} className="w-full rounded-card shadow-raised" />
                  )
                ) : (
                  <HtmlSlideSkeleton streaming={deck.streaming} label={t('deckStudio.building')} />
                )}
                {htmlEditMode && slide && (
                  <p className="text-caption text-faint text-center mt-2">
                    {htmlTool === 'select' ? t('deckStudio.htmlEdit.canvasHint') : t('deckStudio.htmlEdit.drawHint')}
                  </p>
                )}
              </div>
            </div>

            {/* the shared AI panel: this slide / the selection / the whole deck,
                with a reversible preview (Accept / Discard) */}
            {canTweak && (
              <div className="shrink-0 px-3 md:px-6 pb-2">
                <div className="mx-auto w-full" /* data */ style={stageMax}>
                  <StudioAIPanel
                    compact
                    hint={t('deckStudio.ai.hint')}
                    value={tweak}
                    onChange={setTweak}
                    onSubmit={submitHtmlTweak}
                    placeholder={aiPlaceholder}
                    busy={tweaking}
                    images={tweakImages}
                    scope={{
                      value: effectiveScope,
                      onChange: setTweakScope,
                      options: [
                        { id: 'slide', label: t('deckStudio.scope.slide') },
                        ...(singleSel ? [{ id: 'element', label: t('deckStudio.scope.element') }] : []),
                        { id: 'deck', label: t('deckStudio.scope.deck') },
                      ],
                    }}
                    preview={
                      tweakPreview
                        ? { label: tweakPreview.label, hint: t('deckStudio.export.reviewHint'), onAccept: acceptHtmlTweak, onDiscard: discardHtmlTweak, saving: htmlSaving }
                        : null
                    }
                    cost={tweakCost}
                    models={models}
                  />
                </div>
              </div>
            )}

            {/* speaker notes — always editable (converts a string slide to {html,notes}) */}
            <div className="shrink-0 border-t border-border px-3 md:px-6 py-2">
              <div className="mx-auto w-full flex items-start gap-2" /* data */ style={stageMax}>
                <label htmlFor="deck-studio-notes" className="text-caption font-semibold uppercase text-faint w-20 shrink-0 pt-1.5">
                  {t('deckStudio.notesLabel')}
                </label>
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  <textarea
                    id="deck-studio-notes"
                    value={(typeof slide === 'object' && slide?.notes) || ''}
                    onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                    rows={1}
                    disabled={!slide || deck.streaming}
                    placeholder={t('deckStudio.field.notesPlaceholder')}
                    aria-invalid={noteBudget?.slide === activeIndex + 1 || undefined}
                    aria-describedby={noteBudget ? 'deck-studio-notes-budget' : undefined}
                    className={`w-full text-body rounded-control bg-surface-2 border px-2.5 py-1.5 focus:border-accent resize-none placeholder:text-faint disabled:text-disabled-text ${noteBudget?.slide === activeIndex + 1 ? 'border-danger' : 'border-border'}`}
                  />
                  {noteBudget && (
                    <p id="deck-studio-notes-budget" role="alert" data-deck-budget="note" className="text-caption text-danger">
                      {budgetMessage(t, noteBudget)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* DOM inspector — only in Edit mode */}
          {htmlEditMode && slide && (
            <div className="shrink-0 md:w-72 border-t md:border-t-0 md:border-l border-border bg-surface-2 flex flex-col min-h-0 max-h-[45vh] md:max-h-none motion-safe:animate-fade-in">
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
      <HtmlEditContextMenu menu={htmlMenu} canPaste={!!htmlClip?.length} onAction={(action) => htmlOp(action)} onClose={() => setHtmlMenu(null)} />

      {undoDel && deck && undoDel.deckId === deck.id && (
        <StudioSnackbar message={t('deckStudio.slideDeleted', { n: undoDel.n })} actionLabel={t('deckStudio.undo')} onAction={undoDelete} onDismiss={dismissUndo} />
      )}

      {/* another AI edit is running on this deck (N6): nothing was spent, the instruction stays */}
      {aiBusy && (
        <StudioConfirmDialog
          title={t('deckStudio.busy.title')}
          body={t('deckStudio.busy.body')}
          onCancel={() => setAiBusy(false)}
          actions={[{ id: 'ok', label: t('deckStudio.busy.ok'), tone: 'primary', default: true, onClick: () => setAiBusy(false) }]}
        />
      )}

      {/* another tab or session saved this deck first (N6) */}
      {conflict?.open && (
        <StudioConfirmDialog
          title={t('deckStudio.conflict.title')}
          body={t('deckStudio.conflict.body')}
          onCancel={() => setConflict({ ...conflict, open: false })}
          actions={[
            { id: 'reload', label: t('deckStudio.conflict.reload'), tone: 'primary', default: true, onClick: conflictReload },
            { id: 'overwrite', label: t('deckStudio.conflict.overwrite'), tone: 'danger', onClick: conflictOverwrite },
          ]}
        />
      )}

      {/* unsaved-edits guard: leaving Edit mode or the Studio asks Save / Discard / Cancel */}
      {closeConfirm && (
        <StudioConfirmDialog
          title={t('deckStudio.htmlEdit.closeConfirmTitle')}
          body={t('deckStudio.htmlEdit.closeConfirmBody')}
          onCancel={() => setCloseConfirm(null)}
          actions={[
            { id: 'cancel', label: t('deckStudio.htmlEdit.closeConfirmCancel'), default: true, onClick: () => setCloseConfirm(null) },
            { id: 'discard', label: t('deckStudio.htmlEdit.closeConfirmDiscard'), tone: 'danger', onClick: confirmDiscard },
            {
              id: 'save',
              label: closeConfirm === 'close' ? t('deckStudio.htmlEdit.closeConfirmSave') : t('deckStudio.htmlEdit.saveEdits'),
              tone: 'primary',
              busy: htmlSaving,
              onClick: confirmSave,
            },
          ]}
        />
      )}
    </Root>
  )
}
