import { useEffect, useId, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.tsx'
import { notifyUsageChanged } from './CostMeter.jsx'
import RichTextEditor from './RichTextEditor.jsx'
import { getJSON, postJSON, patchJSON } from '../api.ts'
import StudioAIPanel from './studio/StudioAIPanel.jsx'
import StudioExportMenu from './studio/StudioExportMenu.jsx'
import { SaveStatus, StudioCloseButton, StudioConfirmDialog, useHistoryBack, useIsMobile, useSaveStatus, useStudioDialog } from './studio/StudioChrome.jsx'

// Full-screen studio for a generated `document` — the prose sibling of Deck/
// Spreadsheet Studio. The model writes markdown; the Studio renders it as rich
// text (react-markdown), lets the user tweak it with AI (content OR style) via
// POST /api/documents/:id/tweak, edit by hand — either in a WYSIWYG rich-text
// editor (default, for non-technical users) or in raw markdown (advanced) — and
// export to DOCX, Markdown, or PDF (PDF = browser print of the rendered document).
//
// Keyboard: Esc leaves hand-editing first (asking before unsaved changes are
// dropped), and only closes the studio when nothing is being edited.

function TweakOverlay({ instruction }) {
  const t = useT()
  const STEPS = [t('docStudio.step1'), t('docStudio.step2'), t('docStudio.step3')]
  const [step, setStep] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2200)
    return () => clearInterval(id)
  }, [instruction]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="status" className="absolute inset-0 z-raised grid place-items-center bg-bg/70 backdrop-blur-sm">
      <div className="text-center max-w-md px-6">
        <span className="inline-block w-6 h-6 rounded-pill border-2 border-accent border-t-transparent motion-safe:animate-spin" aria-hidden />
        <div className="mt-3 text-body text-muted italic">“{instruction}”</div>
        <div className="mt-1 text-label text-faint">{STEPS[step]}</div>
      </div>
    </div>
  )
}

export default function DocumentStudio({ open, documentId, onClose, pushToast, models, model }) {
  const t = useT()
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [editing, setEditing] = useState(false) // hand-edit mode (WYSIWYG or raw)
  const [rawMode, setRawMode] = useState(false) // within editing: raw markdown (advanced) vs WYSIWYG
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [tweak, setTweak] = useState('')
  const [tweaking, setTweaking] = useState(false)
  const [tweakCost, setTweakCost] = useState(null) // { usage, model } of the last AI edit
  const [lastInstruction, setLastInstruction] = useState('')
  // Pending AI edit shown in the document with Accept/Discard. null = none. The
  // edit is NOT persisted until accepted (server ran it in preview mode), so
  // closing or discarding leaves the saved document untouched.
  const [tweakPreview, setTweakPreview] = useState(null) // null | { before: { title, markdown }, label }
  const [exporting, setExporting] = useState(false)
  // unsaved hand edits: leaving edit mode or the studio asks first — null | 'exit' | 'close'
  const [confirm, setConfirm] = useState(null)
  const save = useSaveStatus()
  const mobile = useIsMobile()
  const rootRef = useRef(null)
  const titleId = useId()
  const printRef = useRef(null)

  const dirty = editing && !!doc && draft !== (doc.markdown || '')
  const state = useRef({})
  // live state for keyboard handlers and for writes that run later (queued
  // behind an older save, or re-run by Retry): they read it when they RUN
  state.current = { editing, dirty, tweaking, saving, confirm, doc, draft, tweakPreview }

  useEffect(() => {
    if (!open || !documentId) return
    setLoading(true)
    setLoadError(null)
    setEditing(false)
    setTweakPreview(null)
    setConfirm(null)
    save.reset()
    getJSON(`/api/documents/${documentId}`)
      .then((r) => {
        setDoc(r.document)
        setDraft(r.document?.markdown || '')
      })
      .catch((e) => setLoadError(e.message || t('docStudio.loadError')))
      .finally(() => setLoading(false))
  }, [open, documentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const leaveEdit = () => {
    setDraft(doc?.markdown || '')
    setEditing(false)
    // a failed Save of the draft just thrown away has nothing left to retry
    if (save.status === 'error') save.reset()
  }
  const requestLeaveEdit = () => (state.current.dirty ? setConfirm('exit') : leaveEdit())
  const requestClose = () => {
    if (state.current.dirty) {
      setConfirm('close')
      return false
    }
    onClose?.()
    return true
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const s = state.current
      if (s.confirm || s.tweaking || s.saving) return
      if (s.editing) {
        e.preventDefault()
        requestLeaveEdit()
        return
      }
      onClose?.()
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, doc]) // eslint-disable-line react-hooks/exhaustive-deps

  useStudioDialog(rootRef, open)
  useHistoryBack(open && mobile, requestClose)

  if (!open) return null

  // Run the AI edit in PREVIEW mode: the server returns the revised document
  // WITHOUT saving it. We show it and offer Accept/Discard — the change only
  // reaches the database once the user accepts (acceptTweak).
  const runTweak = async () => {
    const instruction = tweak.trim()
    if (!instruction || tweaking || saving) return
    setLastInstruction(instruction)
    setTweaking(true)
    try {
      const r = await postJSON(`/api/documents/${documentId}/tweak`, { instruction, model, preview: true })
      if (r.document) {
        setTweakPreview({ before: { title: doc.title, markdown: doc.markdown }, label: instruction })
        setDoc(r.document)
        setDraft(r.document.markdown || '')
        setTweak('')
        if (r.usage) setTweakCost({ usage: r.usage, model: r.model })
        notifyUsageChanged() // the AI edit is on the taxímetro now
      }
    } catch (e) {
      pushToast?.(e.message || t('docStudio.tweakError'))
    } finally {
      setTweaking(false)
    }
  }

  // Accept the pending edit → persist it (PATCH revalidates + saves). Kept as a
  // separate step so an AI change is never written to the document the user
  // didn't confirm — and, once confirmed, it IS saved; a failure stays on
  // screen ("Couldn't save · Retry") with the preview still pending.
  const acceptTweak = async () => {
    if (!tweakPreview || tweaking || saving) return
    setSaving(true)
    await save.run(writePreview)
    setSaving(false)
  }

  // Discard the pending edit → restore the pre-edit document (nothing was saved).
  // A failed Accept of this preview is moot now: the error clears, so Retry can
  // never write the discarded AI text.
  const discardTweak = () => {
    if (!tweakPreview || saving) return
    setDoc((d) => ({ ...d, ...tweakPreview.before }))
    setDraft(tweakPreview.before.markdown || '')
    setTweakPreview(null)
    setTweakCost(null)
    save.reset()
  }

  // returns true once saved; a failure keeps the editor open with Retry
  const saveEdit = async () => {
    if (saving) return false
    setSaving(true)
    const ok = await save.run(writeDraft)
    setSaving(false)
    return ok
  }

  // The writes. Each reads the live state when it runs, so Retry saves the
  // draft as it is NOW (not the one that failed) and a preview discarded in the
  // meantime is never written.
  async function writePreview() {
    const s = state.current
    if (!s.tweakPreview || !s.doc) return true // discarded: nothing to write
    const r = await patchJSON(`/api/documents/${documentId}`, { title: s.doc.title, markdown: s.doc.markdown })
    if (r.document) {
      setDoc(r.document)
      setDraft(r.document.markdown || '')
    }
    setTweakPreview(null)
    return true
  }
  async function writeDraft() {
    const s = state.current
    if (!s.editing || !s.doc) return true // the draft was discarded: nothing to write
    const sent = s.draft
    const r = await patchJSON(`/api/documents/${documentId}`, { title: s.doc.title, markdown: sent })
    if (r.document) setDoc(r.document)
    // typing that continued during the request stays open (and dirty)
    if (state.current.draft === sent) setEditing(false)
    return true
  }
  save.retryRef.current = () => {
    const s = state.current
    if (s.editing) return writeDraft()
    if (s.tweakPreview) return writePreview()
    return Promise.resolve(true)
  }

  const download = async (format) => {
    setExporting(true)
    try {
      const res = await fetch(`/api/documents/${documentId}/export?format=${format}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(doc.title || 'documento').replace(/[^\w-]+/g, '_').slice(0, 60)}.${format === 'md' ? 'md' : 'docx'}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      pushToast?.(e.message || t('docStudio.exportError'))
    } finally {
      setExporting(false)
    }
  }

  // PDF: print just the rendered document. A print stylesheet (index.css)
  // hides everything except .doc-print-area when printing.
  const printPdf = () => window.print()

  const confirmLeave = (after) => {
    setConfirm(null)
    leaveEdit()
    if (after === 'close') onClose?.()
  }

  return (
    <div
      ref={rootRef}
      data-studio="doc"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="doc-print-ancestor fixed inset-0 z-studio flex flex-col bg-bg motion-safe:animate-fade-in"
    >
      {/* header: back/close · title · save status · edit · export */}
      <header className="min-h-14 shrink-0 flex items-center gap-2 px-2 md:px-3 py-1.5 border-b border-border no-print">
        <StudioCloseButton mobile={mobile} onClick={requestClose} />
        <Icon.FileText size={17} className="text-accent shrink-0 max-sm:hidden" aria-hidden />
        <h1 id={titleId} className="font-semibold text-body min-w-0 flex-1 line-clamp-2 md:truncate">
          {doc?.title || t('docBlock.defaultTitle')}
        </h1>
        <SaveStatus status={save.status} error={save.error} onRetry={save.retry} dirty={dirty} />
        <button
          type="button"
          onClick={() => (editing ? requestLeaveEdit() : (setDraft(doc?.markdown || ''), setRawMode(false), setEditing(true)))}
          disabled={!doc || !!tweakPreview}
          aria-pressed={editing}
          aria-label={t('docStudio.edit')}
          title={t('docStudio.edit')}
          className={`min-h-8 min-w-8 max-md:min-h-10 max-md:min-w-10 inline-flex items-center justify-center gap-1.5 rounded-control px-2 text-body font-medium transition-colors duration-fast disabled:text-disabled-text ${
            editing ? 'bg-accent-soft text-accent-text' : 'hover:bg-surface-3 text-muted'
          }`}
        >
          <Icon.Edit size={15} aria-hidden /> <span className="max-md:hidden">{t('docStudio.edit')}</span>
        </button>
        <StudioExportMenu
          busy={exporting}
          disabled={!doc}
          options={[
            { id: 'docx', label: t('docStudio.export.docx'), description: t('docStudio.export.docxBody'), onSelect: () => download('docx') },
            { id: 'md', label: t('docStudio.export.md'), description: t('docStudio.export.mdBody'), onSelect: () => download('md') },
            { id: 'pdf', label: t('docStudio.export.pdf'), description: t('docStudio.export.pdfBody'), onSelect: printPdf },
          ]}
        />
      </header>

      {/* body: the document, and the shared AI panel (side on lg, below otherwise) */}
      <div className="doc-print-ancestor flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* document area */}
        <div role="region" aria-labelledby={titleId} tabIndex={0} className="doc-print-ancestor flex-1 min-w-0 min-h-0 overflow-y-auto relative focus-visible:outline-offset-[-2px]">
          {loading && <div role="status" className="p-8 text-body text-muted">{t('docStudio.loading')}</div>}
          {loadError && <div role="alert" className="p-8 text-body text-danger">{loadError}</div>}
          {tweaking && <TweakOverlay instruction={lastInstruction} />}
          {doc && !loading && (
            editing ? (
              <div className="max-w-6xl mx-auto p-4 md:p-8">
                <div className="overflow-hidden rounded-card border border-border bg-surface">
                  {rawMode ? (
                    // advanced: raw markdown source + live preview, side by side
                    <div className="grid min-h-[60vh] lg:grid-cols-2">
                      <div className="flex min-h-[50vh] flex-col border-b border-border lg:border-b-0 lg:border-r">
                        <label htmlFor="doc-studio-md" className="shrink-0 border-b border-border-soft px-4 py-2 text-caption font-semibold uppercase text-faint">
                          {t('docStudio.markdownSource')}
                        </label>
                        <textarea
                          id="doc-studio-md"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          spellCheck
                          autoFocus
                          className="min-h-[50vh] flex-1 resize-none bg-transparent p-4 font-mono text-body"
                        />
                      </div>
                      <div className="min-h-[50vh] bg-bg">
                        <div className="sticky top-0 z-raised border-b border-border-soft bg-bg/90 px-4 py-2 text-caption font-semibold uppercase text-faint backdrop-blur">
                          {t('docStudio.livePreview')}
                        </div>
                        <div className="prose-chat prose-doc p-5 md:p-7" aria-live="polite">
                          <Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown>
                        </div>
                      </div>
                    </div>
                  ) : (
                    // default: WYSIWYG rich-text editor (click-and-type)
                    <RichTextEditor markdown={draft} onChange={setDraft} />
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 justify-between">
                  <button
                    type="button"
                    onClick={() => setRawMode((r) => !r)}
                    className="min-h-8 flex items-center gap-1.5 rounded-control px-2.5 text-label font-medium text-muted hover:bg-surface-3"
                    title={t('docStudio.toggleRawHint')}
                  >
                    <Icon.Edit size={14} aria-hidden />
                    {rawMode ? t('docStudio.switchToRich') : t('docStudio.switchToMarkdown')}
                  </button>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={requestLeaveEdit} className="min-h-9 px-3 rounded-control text-body text-muted hover:bg-surface-3">
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={saving}
                      className="min-h-9 px-3 rounded-control text-body font-semibold bg-accent-strong text-on-accent hover:brightness-110 disabled:bg-disabled disabled:text-disabled-text"
                    >
                      {saving ? t('common.saving') : t('docStudio.save')}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              // rendered rich text — this is also the print area for PDF export
              <div ref={printRef} className="doc-print-area max-w-3xl mx-auto p-6 md:p-10">
                <div className="prose-chat prose-doc">
                  <Markdown remarkPlugins={[remarkGfm]}>{doc.markdown || ''}</Markdown>
                </div>
              </div>
            )
          )}
        </div>

        {/* the shared AI panel — hidden while editing by hand (one editor at a time) */}
        {!editing && doc && (
          <aside className="shrink-0 lg:w-80 max-lg:max-h-[45vh] overflow-y-auto border-t lg:border-t-0 lg:border-l border-border p-4 no-print bg-surface">
            <StudioAIPanel
              hint={t('docStudio.aiHint')}
              value={tweak}
              onChange={setTweak}
              onSubmit={runTweak}
              placeholder={t('docStudio.aiPlaceholder')}
              busy={tweaking}
              preview={
                tweakPreview
                  ? { label: tweakPreview.label, hint: t('docStudio.tweak.reviewHint'), onAccept: acceptTweak, onDiscard: discardTweak, saving }
                  : null
              }
              cost={tweakCost}
              models={models}
            />
          </aside>
        )}
      </div>

      {confirm && (
        <StudioConfirmDialog
          title={t('docStudio.discardTitle')}
          body={t('docStudio.discardBody')}
          onCancel={() => setConfirm(null)}
          actions={[
            { id: 'keep', label: t('docStudio.keepEditing'), default: true, onClick: () => setConfirm(null) },
            { id: 'discard', label: t('docStudio.discardConfirm'), tone: 'danger', onClick: () => confirmLeave(confirm) },
            {
              id: 'save',
              label: t('docStudio.saveAndLeave'),
              tone: 'primary',
              busy: saving,
              onClick: async () => {
                const after = confirm
                if (await saveEdit()) {
                  setConfirm(null)
                  if (after === 'close') onClose?.()
                }
              },
            },
          ]}
        />
      )}
    </div>
  )
}
