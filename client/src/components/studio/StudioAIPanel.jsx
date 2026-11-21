import { useId, useRef } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.jsx'
import CostBadge from '../CostBadge.tsx'
import PromptImageStrip from '../PromptImageStrip.tsx'
import { SUBMIT_CHORD } from '../../lib/platform.ts'

// The one "edit with AI" panel of the three studios (deck, spreadsheet,
// document). Same anatomy everywhere (Law of Similarity): heading, a scope
// segmented control, the instruction box (paste or attach a reference image
// when the studio supports it), Apply with the submit chord, and — after a
// run — the reversible preview card (Accept / Discard) with the cost of the
// edit. The studio owns the state and the requests; this component owns the
// look, the semantics and the keyboard contract (⌘/Ctrl+Enter submits, Esc in
// the box only blurs it, so it never closes the studio under the user).
//
// Props
//   hint           intro copy under the heading (studio-specific)
//   value/onChange/onSubmit/placeholder/busy   the instruction box
//   scope          { label, value, onChange, options: [{ id, label, title }] }
//   images         a usePromptImages() handle, or null when not supported
//   preview        null | { label, hint, onAccept, onDiscard, saving }
//   cost           { usage, model } of the last AI edit (or null)
//   models         the model catalogue, for the cost badge
//   compact        a shorter box (the deck docks it under the stage)
export default function StudioAIPanel({
  hint,
  value,
  onChange,
  onSubmit,
  placeholder,
  busy = false,
  scope = null,
  images = null,
  preview = null,
  cost = null,
  models,
  compact = false,
  className = '',
}) {
  const t = useT()
  const headingId = useId()
  const fileRef = useRef(null)
  const canSubmit = !busy && (!!value.trim() || !!images?.images?.length)

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      data-studio-ai-panel
      className={`flex flex-col gap-in-group ${className}`}
    >
      <h2 id={headingId} className="flex items-center gap-2 text-body font-semibold text-fg">
        <Icon.Sparkle size={16} className="text-accent shrink-0" aria-hidden /> {t('studio.ai.title')}
      </h2>
      {hint && !compact && <p className="text-caption text-muted">{hint}</p>}

      {preview ? (
        <div role="group" aria-label={t('studio.ai.previewGroup')} className="rounded-card border border-accent/40 bg-accent-soft p-3 flex flex-col gap-in-group motion-safe:animate-fade-in">
          <p className="text-label text-fg break-words">{t('studio.ai.previewLabel', { label: preview.label })}</p>
          {preview.hint && <p className="text-caption text-muted">{preview.hint}</p>}
          {cost && <CostBadge usage={cost.usage} model={cost.model} models={models} className="text-caption" />}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={preview.onDiscard}
              disabled={preview.saving}
              className="flex-1 min-h-8 rounded-control border border-border bg-surface hover:bg-surface-3 text-muted text-label font-medium px-3 disabled:bg-disabled disabled:text-disabled-text"
            >
              {t('studio.ai.discard')}
            </button>
            <button
              type="button"
              onClick={preview.onAccept}
              disabled={preview.saving}
              className="flex-1 min-h-8 inline-flex items-center justify-center gap-1.5 rounded-control bg-accent-strong text-on-accent hover:brightness-110 text-label font-semibold px-3 disabled:bg-disabled disabled:text-disabled-text"
            >
              {preview.saving ? (
                <span className="inline-block w-3 h-3 rounded-pill border-2 border-current border-t-transparent motion-safe:animate-spin" aria-hidden />
              ) : (
                <Icon.Check size={13} aria-hidden />
              )}
              {t('studio.ai.accept')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {scope && (
            <div>
              <div id={`${headingId}-scope`} className="text-caption font-medium text-muted mb-1">
                {scope.label || t('studio.ai.scope')}
              </div>
              <div role="radiogroup" aria-labelledby={`${headingId}-scope`} className="flex rounded-control bg-surface border border-border p-0.5 text-label">
                {scope.options.map((o) => {
                  const on = scope.value === o.id
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => scope.onChange(o.id)}
                      disabled={busy}
                      title={o.title || o.label}
                      className={`flex-1 min-w-0 min-h-8 truncate rounded-control px-2 font-medium transition-colors duration-fast ${
                        on ? 'bg-accent-strong text-on-accent' : 'text-muted hover:text-fg'
                      }`}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {images && <PromptImageStrip images={images.images} onRemove={images.removeAt} />}
          <div className="relative">
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (canSubmit) onSubmit()
                } else if (e.key === 'Escape') {
                  // leave the box, never the studio
                  e.stopPropagation()
                  e.currentTarget.blur()
                }
              }}
              onPaste={images?.onPaste}
              placeholder={placeholder}
              aria-label={placeholder || t('studio.ai.instruction')}
              rows={compact ? 2 : 4}
              disabled={busy}
              className={`w-full resize-none rounded-control bg-surface border border-border px-3 py-2 text-body focus:border-accent placeholder:text-faint disabled:text-disabled-text ${images ? 'pr-11' : ''}`}
            />
            {images && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  aria-label={t('studio.ai.attachImage')}
                  title={t('studio.ai.attachImage')}
                  className="absolute top-1 right-1 min-w-8 min-h-8 grid place-items-center rounded-control hover:bg-surface-3 text-muted disabled:text-disabled-text"
                >
                  <Icon.Paperclip size={16} aria-hidden />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    images.addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="min-h-9 flex items-center justify-center gap-2 rounded-control bg-accent-strong text-on-accent hover:brightness-110 font-semibold text-body px-3 transition-colors duration-fast disabled:bg-disabled disabled:text-disabled-text"
          >
            {busy ? (
              <>
                <span className="inline-block w-3.5 h-3.5 rounded-pill border-2 border-current border-t-transparent motion-safe:animate-spin" aria-hidden />
                {t('studio.ai.applying')}
              </>
            ) : (
              <>
                <Icon.Send size={14} aria-hidden /> {t('studio.ai.apply')}
                <span className="opacity-70 text-caption font-normal" aria-hidden>{SUBMIT_CHORD}</span>
              </>
            )}
          </button>
          {cost && !busy && (
            <div className="text-caption text-faint text-right">
              <CostBadge usage={cost.usage} model={cost.model} models={models} />
            </div>
          )}
        </>
      )}
    </section>
  )
}
