import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { useModalDialog } from '../lib/useModalDialog.js'
import { inputCls } from './SettingsControls.jsx'
import { memoryRequest, memoryErrorKey, categoryOptions, buildPayload, isSensitiveCategory } from '../lib/memoryUi.js'

// Settings → Preferences → Memory (W3-3): the caller's own cross-conversation
// memory (GET/POST/PATCH/DELETE /api/memory). Four distinct list states, never
// confused: loading, ready (possibly empty), disabled (403 memory_disabled: the
// org turned memory off; no list, only "forget everything") and error (with a
// retry). Content is personal data: it is only rendered here, never logged.

const btn =
  'inline-flex items-center justify-center gap-1.5 min-h-11 md:min-h-9 px-3 rounded-control border border-[var(--border)] text-label font-medium hover:bg-[var(--surface-2)] transition duration-fast disabled:opacity-50'
const iconBtn =
  'grid place-items-center min-h-11 min-w-11 md:min-h-9 md:min-w-9 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition duration-fast'
const primaryBtn =
  'inline-flex items-center justify-center gap-1.5 min-h-11 md:min-h-9 px-3 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] text-label font-semibold hover:opacity-90 transition duration-fast disabled:opacity-50'

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Add / edit form. One component for both, so the opt-in and error rules are stated once. */
function EntryForm({ entry, data, onSubmit, onCancel, busy, errorText }) {
  const t = useT()
  const id = useId()
  const boxRef = useRef(null)
  const [content, setContent] = useState(entry?.content || '')
  const [category, setCategory] = useState(entry?.category || 'other')
  const [optIn, setOptIn] = useState(!!entry?.sensitiveOptIn)
  const { categories, sensitiveCategories, limits } = data
  const options = categoryOptions(categories, sensitiveCategories, { optIn, current: entry?.category })

  useEffect(() => {
    const el = boxRef.current
    el?.focus({ preventScroll: true })
    el?.setSelectionRange?.(el.value.length, el.value.length)
  }, [])

  const toggleOptIn = (on) => {
    setOptIn(on)
    // a sensitive category cannot outlive the opt-in that allowed it
    if (!on && isSensitiveCategory(category, sensitiveCategories) && category !== entry?.category) setCategory('other')
  }
  const submit = () => {
    if (busy || !content.trim()) return
    onSubmit(buildPayload({ content, category, optIn }, sensitiveCategories))
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div>
        <label htmlFor={`${id}-text`} className="block text-label font-medium text-[var(--muted)] mb-1">
          {t('memory.field.content')}
        </label>
        <textarea
          ref={boxRef}
          id={`${id}-text`}
          rows={3}
          value={content}
          maxLength={limits.contentMaxChars}
          aria-describedby={errorText ? `${id}-err` : `${id}-count`}
          aria-invalid={errorText ? true : undefined}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              submit()
            }
          }}
          className={`${inputCls} resize-y`}
        />
        <p id={`${id}-count`} className="mt-1 text-caption text-[var(--faint)] text-right">
          {t('memory.field.count', { n: content.length, max: limits.contentMaxChars })}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div>
          <label htmlFor={`${id}-cat`} className="block text-label font-medium text-[var(--muted)] mb-1">
            {t('memory.field.category')}
          </label>
          <select
            id={`${id}-cat`}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="min-h-11 md:min-h-9 rounded-control border border-[var(--border)] bg-[var(--surface-2)] px-3 text-body outline-none focus:border-[var(--accent)]"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {t(`memory.category.${o.value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <label className="flex items-center gap-2 min-h-11 md:min-h-9 text-body font-medium">
            <input
              type="checkbox"
              checked={optIn}
              onChange={(e) => toggleOptIn(e.target.checked)}
              aria-describedby={`${id}-sens`}
              className="h-4 w-4 accent-[var(--accent-strong)]"
            />
            {t('memory.field.sensitive')}
          </label>
          <p id={`${id}-sens`} className="text-caption text-[var(--muted)]">
            {t('memory.field.sensitiveHint')}
          </p>
        </div>
      </div>
      {errorText && (
        <p id={`${id}-err`} role="alert" className="text-label text-[var(--danger)] flex items-start gap-1">
          <Icon.AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /> {errorText}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !content.trim()} className={primaryBtn}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" onClick={onCancel} className={btn}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

/** The single "forget everything" confirmation: focus trapped, Escape cancels, one submit. */
function ForgetDialog({ count, busy, errorText, onConfirm, onCancel }) {
  const t = useT()
  const titleId = useId()
  const ref = useRef(null)
  useModalDialog(ref, { onClose: busy ? undefined : onCancel, initialFocus: (el) => el.querySelector('[data-cancel]') })
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div aria-hidden className="absolute inset-0 bg-black/50" onClick={busy ? undefined : onCancel} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-memory-confirm
        tabIndex={-1}
        className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-modal animate-fade-in p-5 space-y-4 outline-none"
      >
        <h3 id={titleId} className="font-bold text-heading">
          {t('memory.forget.title')}
        </h3>
        <p className="text-body text-[var(--muted)]">{count == null ? t('memory.forget.bodyUnknown') : t('memory.forget.body', { n: count })}</p>
        {errorText && (
          <p role="alert" className="text-label text-[var(--danger)] flex items-start gap-1">
            <Icon.AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /> {errorText}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" data-cancel onClick={onCancel} disabled={busy} className={btn}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={`${btn} border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] font-semibold`}>
            {busy ? t('memory.forget.working') : t('memory.forget')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function MemorySection() {
  const t = useT()
  const titleId = useId()
  const headingRef = useRef(null)
  const alive = useRef(true)
  const forgetting = useRef(false) // synchronous guard: a double click cannot send two DELETEs
  const saving = useRef(false)
  const focusAfter = useRef(null)
  const [view, setView] = useState('loading') // loading | ready | disabled | error
  const [data, setData] = useState({ items: [], limits: { contentMaxChars: 500, perUserMax: 200 }, categories: [], sensitiveCategories: [] })
  const [editing, setEditing] = useState(null) // null | 'new' | entry id
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(null) // null | { busy, error }

  const load = useCallback(async () => {
    const r = await memoryRequest('GET', '/api/memory')
    if (!alive.current) return
    if (r.ok) {
      setData({ items: [], ...r.data })
      setView('ready')
    } else if (r.status === 403 && r.code === 'memory_disabled') {
      setView('disabled')
    } else {
      setView('error')
    }
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    return () => {
      alive.current = false
    }
  }, [load])

  // move focus after a render that removed the control that had it
  useEffect(() => {
    const f = focusAfter.current
    if (!f) return
    focusAfter.current = null
    if (f === 'heading') headingRef.current?.focus({ preventScroll: true })
    else document.querySelector(`[data-memory-edit="${f}"]`)?.focus({ preventScroll: true })
  })

  const errText = (r) => t(memoryErrorKey(r), { max: r.code === 'memory_limit' ? data.limits.perUserMax : data.limits.contentMaxChars })

  const staleRefresh = async () => {
    // the entry is gone (deleted elsewhere): drop the form and reload instead of keeping a stale row
    setEditing(null)
    setFormError('')
    setNotice(t('memory.err.notFound'))
    focusAfter.current = 'heading'
    await load()
  }

  const submit = async (payload) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setFormError('')
    const isNew = editing === 'new'
    const r = await memoryRequest(isNew ? 'POST' : 'PATCH', isNew ? '/api/memory' : `/api/memory/${encodeURIComponent(editing)}`, payload)
    saving.current = false
    if (!alive.current) return
    setBusy(false)
    if (r.ok) {
      const saved = r.data
      setData((d) => ({ ...d, items: [saved, ...d.items.filter((e) => e.id !== saved.id)] }))
      setEditing(null)
      setNotice(t('memory.saved'))
      focusAfter.current = saved.id
    } else if (r.status === 404 && !isNew) {
      await staleRefresh()
    } else if (r.status === 403 && r.code === 'memory_disabled') {
      setEditing(null)
      setView('disabled')
    } else {
      setFormError(errText(r))
    }
  }

  const remove = async (entry) => {
    const r = await memoryRequest('DELETE', `/api/memory/${encodeURIComponent(entry.id)}`)
    if (!alive.current) return
    if (r.ok || r.status === 404) {
      setData((d) => ({ ...d, items: d.items.filter((e) => e.id !== entry.id) }))
      if (editing === entry.id) setEditing(null)
      setNotice(r.ok ? t('memory.deleted') : t('memory.err.notFound'))
      focusAfter.current = 'heading'
    } else {
      setNotice(errText(r))
    }
  }

  const forgetAll = async () => {
    if (forgetting.current) return
    forgetting.current = true
    setConfirm({ busy: true, error: '' })
    const r = await memoryRequest('DELETE', '/api/memory')
    forgetting.current = false
    if (!alive.current) return
    if (r.ok) {
      const n = Number(r.data?.deleted) || 0
      setData((d) => ({ ...d, items: [] }))
      setEditing(null)
      setConfirm(null)
      setNotice(n === 1 ? t('memory.forgotten.one') : t('memory.forgotten.many', { n }))
      // the dialog hands focus back to its opener on close; the heading is the stable landmark
      setTimeout(() => headingRef.current?.focus({ preventScroll: true }), 0)
    } else {
      setConfirm({ busy: false, error: t('memory.forgetFailed') })
    }
  }

  const count = view === 'ready' ? data.items.length : null
  const startEdit = (id) => {
    setEditing(id)
    setFormError('')
    setNotice('')
  }
  const cancelEdit = () => {
    const was = editing
    setEditing(null)
    setFormError('')
    focusAfter.current = was === 'new' ? 'heading' : was
  }

  return (
    <section aria-labelledby={titleId} data-testid="memory-section" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={titleId} ref={headingRef} tabIndex={-1} className="text-body font-semibold flex items-center gap-2 outline-none">
            <Icon.Sparkle size={16} className="text-[var(--muted)]" aria-hidden /> {t('memory.title')}
          </h4>
          <p className="text-label text-[var(--muted)] mt-0.5">{t('memory.subtitle')}</p>
        </div>
        {view === 'ready' && editing !== 'new' && (
          <button type="button" onClick={() => startEdit('new')} className={btn}>
            <Icon.Plus size={14} aria-hidden /> {t('memory.add')}
          </button>
        )}
      </div>

      {/* what is on, what is remembered, where it is turned off (only while it is on) */}
      {view === 'ready' && (
        <div data-testid="memory-notice" className="rounded-card border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--accent-soft)] p-3">
          <p className="text-body font-semibold">{t('memory.notice.title')}</p>
          <p className="text-label text-[var(--muted)] mt-0.5">{t('memory.notice.body')}</p>
        </div>
      )}

      <p role="status" className="text-label text-[var(--muted)] empty:hidden">
        {notice}
      </p>

      {view === 'loading' && <p className="text-label text-[var(--muted)]">{t('memory.loading')}</p>}

      {view === 'error' && (
        <div className="rounded-card border border-[var(--border)] p-3 space-y-2">
          <p role="alert" className="text-label text-[var(--danger)] flex items-start gap-1">
            <Icon.AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /> {t('memory.loadError')}
          </p>
          <button
            type="button"
            className={btn}
            onClick={() => {
              setView('loading')
              load()
            }}
          >
            {t('memory.retry')}
          </button>
        </div>
      )}

      {view === 'disabled' && (
        <div data-testid="memory-disabled" className="rounded-card border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <p className="text-body font-semibold">{t('memory.disabled.title')}</p>
          <p className="text-label text-[var(--muted)] mt-0.5">{t('memory.disabled.body')}</p>
        </div>
      )}

      {view === 'ready' && editing === 'new' && (
        <div className="rounded-card border border-[var(--border)] p-3">
          <EntryForm data={data} onSubmit={submit} onCancel={cancelEdit} busy={busy} errorText={formError} />
        </div>
      )}

      {view === 'ready' && data.items.length === 0 && editing !== 'new' && (
        <div data-testid="memory-empty" className="rounded-card border border-dashed border-[var(--border)] p-4 text-center">
          <p className="text-body font-medium">{t('memory.empty')}</p>
          <p className="text-label text-[var(--muted)] mt-0.5">{t('memory.emptyHint')}</p>
        </div>
      )}

      {view === 'ready' && data.items.length > 0 && (
        <ul aria-label={t('memory.listLabel')} className="space-y-2">
          {data.items.map((e) => (
            <li key={e.id} data-memory-id={e.id} className="rounded-card border border-[var(--border)] p-3">
              {editing === e.id ? (
                <EntryForm entry={e} data={data} onSubmit={submit} onCancel={cancelEdit} busy={busy} errorText={formError} />
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-body break-words">{e.content}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-[var(--muted)]">
                      <span className="rounded-pill bg-[var(--surface-3)] px-2 py-0.5 font-medium">{t(`memory.category.${e.category}`)}</span>
                      {e.sensitive && <span>{e.sensitiveOptIn ? t('memory.sensitive.used') : t('memory.sensitive.unused')}</span>}
                      {(e.source === 'extracted' || e.source === 'user') && <span>{t(`memory.source.${e.source}`)}</span>}
                    </p>
                  </div>
                  <button type="button" data-memory-edit={e.id} aria-label={t('memory.edit', { text: short(e.content) })} onClick={() => startEdit(e.id)} className={iconBtn}>
                    <Icon.Pencil size={16} aria-hidden />
                  </button>
                  <button type="button" aria-label={t('memory.deleteOne', { text: short(e.content) })} onClick={() => remove(e)} className={iconBtn}>
                    <Icon.Trash size={16} aria-hidden />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {(view === 'ready' || view === 'disabled') && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setConfirm({ busy: false, error: '' })}
            disabled={view === 'ready' && data.items.length === 0}
            className={`${btn} text-[var(--danger)]`}
          >
            <Icon.Trash size={14} aria-hidden /> {t('memory.forget')}
          </button>
        </div>
      )}

      {confirm && <ForgetDialog count={count} busy={confirm.busy} errorText={confirm.error} onConfirm={forgetAll} onCancel={() => setConfirm(null)} />}
    </section>
  )
}
