import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import CostBadge from './CostBadge.jsx'
import RichTextEditor from './RichTextEditor.jsx'
import { getJSON, postJSON, patchJSON } from '../api.js'

// Full-screen studio for a generated `document` — the prose sibling of Deck/
// Spreadsheet Studio. The model writes markdown; the Studio renders it as rich
// text (react-markdown), lets the user tweak it with AI (content OR style) via
// POST /api/documents/:id/tweak, edit by hand — either in a WYSIWYG rich-text
// editor (default, for non-technical users) or in raw markdown (advanced) — and
// export to DOCX, Markdown, or PDF (PDF = browser print of the rendered document).

function TweakOverlay({ instruction }) {
  const t = useT()
  const STEPS = [t('docStudio.step1'), t('docStudio.step2'), t('docStudio.step3')]
  const [step, setStep] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2200)
    return () => clearInterval(id)
  }, [instruction]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--bg)]/70 backdrop-blur-sm">
      <div className="text-center max-w-md px-6">
        <span className="inline-block w-6 h-6 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
        <div className="mt-3 text-sm text-[var(--muted)] italic">“{instruction}”</div>
        <div className="mt-1 text-xs text-[var(--faint)]">{STEPS[step]}</div>
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
  const printRef = useRef(null)

  useEffect(() => {
    if (!open || !documentId) return
    setLoading(true)
    setLoadError(null)
    setEditing(false)
    setTweakPreview(null)
    getJSON(`/api/documents/${documentId}`)
      .then((r) => {
        setDoc(r.document)
        setDraft(r.document?.markdown || '')
      })
      .catch((e) => setLoadError(e.message || t('docStudio.loadError')))
      .finally(() => setLoading(false))
  }, [open, documentId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !tweaking && !saving) onClose?.()
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, tweaking, saving])

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
      }
    } catch (e) {
      pushToast?.(e.message || t('docStudio.tweakError'))
    } finally {
      setTweaking(false)
    }
  }

  // Accept the pending edit → persist it (PATCH revalidates + saves). Kept as a
  // separate step so an AI change is never written to the document the user
  // didn't confirm — and, once confirmed, it IS saved (never silently lost).
  const acceptTweak = async () => {
    if (!tweakPreview || tweaking || saving) return
    setSaving(true)
    try {
      const r = await patchJSON(`/api/documents/${documentId}`, { title: doc.title, markdown: doc.markdown })
      if (r.document) { setDoc(r.document); setDraft(r.document.markdown || '') }
      setTweakPreview(null)
    } catch (e) {
      pushToast?.(e.message || t('docStudio.saveError'))
    } finally {
      setSaving(false)
    }
  }

  // Discard the pending edit → restore the pre-edit document (nothing was saved).
  const discardTweak = () => {
    if (!tweakPreview || saving) return
    setDoc((d) => ({ ...d, ...tweakPreview.before }))
    setDraft(tweakPreview.before.markdown || '')
    setTweakPreview(null)
    setTweakCost(null)
  }

  const saveEdit = async () => {
    if (saving) return
    setSaving(true)
    try {
      const r = await patchJSON(`/api/documents/${documentId}`, { title: doc.title, markdown: draft })
      if (r.document) setDoc(r.document)
      setEditing(false)
    } catch (e) {
      pushToast?.(e.message || t('docStudio.saveError'))
    } finally {
      setSaving(false)
    }
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

  return (
    <div className="doc-print-ancestor fixed inset-0 z-[80] flex flex-col bg-[var(--bg)] animate-fade-in">
      {/* header */}
      <div className="h-14 shrink-0 flex items-center gap-2 px-3 md:px-5 border-b border-[var(--border)] no-print">
        <button onClick={onClose} className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]" title={t('docStudio.close')}>
          <Icon.Close size={20} />
        </button>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Icon.FileText size={17} className="text-[var(--accent)] shrink-0" />
          <span className="font-semibold truncate">{doc?.title || t('docBlock.defaultTitle')}</span>
        </div>
        {/* export menu */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { setDraft(doc?.markdown || ''); setRawMode(false); setEditing((e) => !e) }}
            disabled={!!tweakPreview}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
              editing ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'hover:bg-[var(--surface-3)] text-[var(--muted)]'
            }`}
            title={t('docStudio.edit')}
          >
            <Icon.Edit size={15} /> <span className="hidden md:inline">{t('docStudio.edit')}</span>
          </button>
          <button onClick={() => download('docx')} disabled={exporting} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-50" title={t('docStudio.exportDocx')}>
            <Icon.Download size={15} /> DOCX
          </button>
          <button onClick={() => download('md')} disabled={exporting} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-50" title={t('docStudio.exportMd')}>
            <Icon.Download size={15} /> MD
          </button>
          <button onClick={printPdf} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-[var(--surface-3)] text-[var(--muted)]" title={t('docStudio.exportPdf')}>
            <Icon.Download size={15} /> PDF
          </button>
        </div>
      </div>

      {/* body */}
      <div className="doc-print-ancestor flex-1 min-h-0 flex">
        {/* document area */}
        <div className="doc-print-ancestor flex-1 min-w-0 overflow-y-auto relative">
          {loading && <div className="p-8 text-sm text-[var(--muted)]">{t('docStudio.loading')}</div>}
          {loadError && <div className="p-8 text-sm text-red-400">{loadError}</div>}
          {tweaking && <TweakOverlay instruction={lastInstruction} />}
          {doc && !loading && (
            editing ? (
              <div className="max-w-6xl mx-auto p-4 md:p-8">
                <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                  {rawMode ? (
                    // advanced: raw markdown source + live preview, side by side
                    <div className="grid min-h-[60vh] lg:grid-cols-2">
                      <div className="flex min-h-[50vh] flex-col border-b border-[var(--border)] lg:border-b-0 lg:border-r">
                        <div className="shrink-0 border-b border-[var(--border-soft)] px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--faint)]">
                          {t('docStudio.markdownSource')}
                        </div>
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          spellCheck
                          autoFocus
                          className="min-h-[50vh] flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed outline-none"
                        />
                      </div>
                      <div className="min-h-[50vh] bg-[var(--bg)]">
                        <div className="sticky top-0 z-[1] border-b border-[var(--border-soft)] bg-[var(--bg)]/90 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--faint)] backdrop-blur">
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
                <div className="mt-3 flex items-center gap-2 justify-between">
                  <button
                    onClick={() => setRawMode((r) => !r)}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-3)]"
                    title={t('docStudio.toggleRawHint')}
                  >
                    <Icon.Edit size={14} />
                    {rawMode ? t('docStudio.switchToRich') : t('docStudio.switchToMarkdown')}
                  </button>
                  <div className="flex items-center gap-2">
                    <button onClick={() => { setDraft(doc.markdown || ''); setEditing(false) }} className="px-3 py-1.5 rounded-lg text-sm text-[var(--muted)] hover:bg-[var(--surface-3)]">
                      {t('common.cancel')}
                    </button>
                    <button onClick={saveEdit} disabled={saving} className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-[var(--accent)] text-white hover:brightness-110 disabled:opacity-50">
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

        {/* AI tweak panel */}
        {!editing && (
          <div className="w-72 shrink-0 border-l border-[var(--border)] p-4 hidden lg:flex flex-col gap-3 no-print bg-[var(--surface)]">
            <div className="text-sm font-semibold flex items-center gap-2">
              <Icon.Sparkle size={15} className="text-[var(--accent)]" /> {t('docStudio.aiTitle')}
            </div>
            <p className="text-xs text-[var(--muted)] leading-relaxed">{t('docStudio.aiHint')}</p>
            {tweakPreview ? (
              /* pending AI edit: review it in the document, then confirm to save */
              <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-3 flex flex-col gap-2">
                <div className="text-xs text-[var(--text)]">
                  {t('docStudio.tweak.previewLabel', { label: tweakPreview.label })}
                </div>
                <p className="text-[11px] text-[var(--muted)] leading-relaxed">{t('docStudio.tweak.reviewHint')}</p>
                {tweakCost && (
                  <div className="text-[11px] text-[var(--faint)]">
                    <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} />
                  </div>
                )}
                <div className="flex gap-2 mt-0.5">
                  <button
                    onClick={discardTweak}
                    disabled={saving}
                    className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-[var(--muted)] text-xs font-medium py-1.5 disabled:opacity-50"
                  >
                    {t('docStudio.tweak.discard')}
                  </button>
                  <button
                    onClick={acceptTweak}
                    disabled={saving}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] hover:brightness-110 text-white text-xs font-semibold py-1.5 disabled:opacity-50"
                  >
                    {saving
                      ? <span className="inline-block w-3 h-3 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                      : <Icon.Check size={13} />}
                    {t('docStudio.tweak.accept')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <textarea
                  value={tweak}
                  onChange={(e) => setTweak(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runTweak()
                  }}
                  placeholder={t('docStudio.aiPlaceholder')}
                  className="w-full h-28 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                />
                <button
                  onClick={runTweak}
                  disabled={!tweak.trim() || tweaking}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm py-2 transition"
                >
                  <Icon.Wand size={15} /> {t('docStudio.apply')}
                </button>
                {tweakCost && !tweaking && (
                  <div className="text-[11px] text-[var(--faint)] text-right">
                    <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
