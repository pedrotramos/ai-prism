import { useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useI18n } from '../../lib/i18n.tsx'
import { projectsApi } from './projectsApi.js'
import { can, contextSummary, fileContextState, precheckUploads } from './projectsLogic.js'
import { FailureNotice, Section, ghostBtn, iconBtn } from './ui.jsx'

const fmtBytes = (n, locale) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString(locale, { maximumFractionDigits: 0 })} KB`
  return `${(n / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`
}

// what a chat in this project reads of a file, in words (the server decides it,
// with the same selection the turn uses; this only shows it)
const STATE_ICON = { full: Icon.Check, partial: Icon.AlertTriangle, excluded: Icon.AlertTriangle, unknown: Icon.File }

export default function FilesSection({ projectId, role, limits, files, context, loadError, onReload, onRefused, onChanged }) {
  const { t, locale } = useI18n()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [refused, setRefused] = useState([])
  const [removingId, setRemovingId] = useState(null)
  const [note, setNote] = useState('')
  const editable = can(role, 'files')
  const summary = contextSummary(context)
  const accept = (limits?.supportedExtensions || []).map((e) => `.${e}`).join(',')

  const pick = async (e) => {
    const picked = [...(e.target.files || [])]
    e.target.value = ''
    if (!picked.length) return
    setError(null)
    setNote('')
    const { ok, rejected } = precheckUploads(picked, limits, files.length)
    setRefused(rejected)
    if (!ok.length) return
    setBusy(true)
    try {
      await projectsApi.upload(projectId, ok)
      setNote(t('projects.files.uploaded', { n: ok.length }))
      await onReload()
      onChanged?.()
    } catch (err) {
      setError(err)
      onRefused(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (f) => {
    setRemovingId(f.id)
    setError(null)
    setNote('')
    try {
      await projectsApi.removeFile(projectId, f.id)
      setNote(t('projects.files.removed', { name: f.name }))
      await onReload()
    } catch (err) {
      setError(err)
      onRefused(err)
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <Section
      title={t('projects.files.title')}
      hint={t('projects.files.hint')}
      action={
        editable && (
          <>
            <input ref={inputRef} type="file" multiple hidden tabIndex={-1} accept={accept || undefined} onChange={pick} data-testid="project-file-input" />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className={ghostBtn}>
              <Icon.Upload size={14} /> {busy ? t('projects.files.uploading') : t('projects.files.upload')}
            </button>
          </>
        )
      }
    >
      {!editable && <p className="text-label text-[var(--muted)]">{t('projects.files.readOnly')}</p>}
      {summary && (
        <p className="text-label text-[var(--muted)]">
          {t('projects.files.budget', { used: summary.used.toLocaleString(locale), budget: summary.budget.toLocaleString(locale) })}
          {summary.excluded > 0 && ` ${t('projects.files.excludedCount', { n: summary.excluded })}`}
        </p>
      )}
      {limits && editable && (
        <p className="text-label text-[var(--muted)]">
          {t('projects.files.limits', {
            size: fmtBytes(limits.fileMaxBytes, locale),
            types: (limits.supportedExtensions || []).join(', '),
          })}
        </p>
      )}
      {refused.length > 0 && (
        <div role="alert" className="rounded-control border border-[var(--border)] bg-[var(--danger-soft)] px-3 py-2.5 text-body text-[var(--text)]">
          <p className="font-semibold">{t('projects.files.notUploaded')}</p>
          <ul className="list-disc pl-5">
            {refused.map((r) => (
              <li key={r.name}>
                <span className="font-medium">{r.name}</span>: {t(`projects.files.reject.${r.reason}`, { size: fmtBytes(limits?.fileMaxBytes || 0, locale), n: limits?.filesPerUpload, cap: limits?.filesPerProject })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <FailureNotice error={error} ctx="files" onDismiss={() => setError(null)} />
      <p role="status" className="text-label text-[var(--muted)] empty:hidden">
        {note}
      </p>
      {loadError && <FailureNotice error={loadError} ctx="files" onRetry={onReload} />}
      {files.length === 0 ? (loadError ? null : (
        <p className="text-body text-[var(--muted)]">{editable ? t('projects.files.empty') : t('projects.files.emptyReadOnly')}</p>
      )) : (
        <ul className="divide-y divide-[var(--border)]">
          {files.map((f) => {
            const state = fileContextState(f)
            const StateIcon = STATE_ICON[state]
            return (
              <li key={f.id} className="flex items-center gap-3 py-2">
                <Icon.File size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-body text-[var(--text)] truncate" title={f.name}>
                    {f.name}
                  </p>
                  <p className="text-label text-[var(--muted)] flex flex-wrap items-center gap-x-2">
                    <span>{fmtBytes(f.size_bytes, locale)}</span>
                    {f.context_tokens != null && <span>{t('projects.files.tokens', { n: f.context_tokens.toLocaleString(locale) })}</span>}
                    <span className={`inline-flex items-center gap-1 font-semibold ${state === 'excluded' || state === 'partial' ? 'text-[var(--warn-text,var(--text))]' : ''}`}>
                      <StateIcon size={12} /> {t(`projects.files.context.${state}`)}
                    </span>
                    {f.truncated_at_upload && <span>{t('projects.files.truncated')}</span>}
                  </p>
                </div>
                {editable && (
                  <button type="button" onClick={() => remove(f)} disabled={removingId === f.id} className={`${iconBtn} hover:text-[var(--danger)]`} aria-label={t('projects.files.remove', { name: f.name })} title={t('common.delete')}>
                    <Icon.Trash size={15} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
