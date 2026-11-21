import { useEffect, useId, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import { getJSON, postJSON, putJSON, del, postForm } from '../api.ts'
import { useT } from '../lib/i18n.jsx'
import { localizedSkill } from '../lib/systemSkills.ts'
import { useModalDialog } from '../lib/useModalDialog.ts'
import { Switch } from './SettingsControls.jsx'

// Settings tab: the user's authored skills (capabilities the model can be
// routed to — see server/skills.js). Mirrors the claude.ai Skills UI: a list
// with search + an "Add" menu offering three ways to author — Create with
// Claude (drops into a guided chat), Write instructions (a form), Upload a
// SKILL.md/.zip. Admins additionally manage global (org-wide) skills.
export default function SkillsTab({ open, isAdmin, onCreateWithClaude }) {
  const t = useT()
  const [skills, setSkills] = useState(null)
  const addBtnRef = useRef(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editor, setEditor] = useState(null) // { skill } | null  (write/edit modal)
  const [uploadOpen, setUploadOpen] = useState(false)

  const load = async () => {
    try {
      const r = await getJSON('/api/skills')
      setSkills(r.skills || [])
      setError('')
    } catch (e) {
      setError(e.message)
      setSkills([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (skill) => {
    if (!confirm(t('skills.removeConfirm', { title: skill.title }))) return
    try {
      await del(`/api/skills/${skill.id}`)
      setSkills((list) => list.filter((s) => s.id !== skill.id))
    } catch (e) {
      setError(e.message)
    }
  }

  const toggleEnabled = async (skill) => {
    try {
      await putJSON(`/api/skills/${skill.id}`, { ...skill, enabled: !skill.enabled })
      setSkills((list) => list.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s)))
    } catch (e) {
      setError(e.message)
    }
  }

  const q = query.trim().toLowerCase()
  const shown = (skills || []).map((s) => localizedSkill(t, s)).filter(
    (s) => !q || s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.name.includes(q)
  )

  if (skills === null) {
    return <div className="text-body text-[var(--muted)]">{t('skills.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Icon.SkillGlyph size={16} /> Skills
          </h3>
          <p className="text-label text-[var(--muted)] mt-0.5">
            {t('skills.introBeforeSystem')}{' '}
            <span className="text-[var(--muted)]">{t('skills.introSystemWord')}</span>{t('skills.introAfterSystem')}
          </p>
        </div>
        {/* Add menu */}
        <div className="relative shrink-0">
          <button
            ref={addBtnRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-strong)] hover:brightness-110 text-[var(--on-accent)] text-body font-semibold px-3 py-1.5"
          >
            <Icon.Plus size={15} /> {t('skills.add')} <Icon.ChevronDown size={13} />
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 mt-1 z-20 w-60 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl p-1.5 animate-fade-in">
                <button
                  onClick={() => {
                    setAddOpen(false)
                    onCreateWithClaude?.()
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-body text-left hover:bg-[var(--surface-3)]"
                >
                  <Icon.Wand size={16} className="text-[var(--accent)]" /> {t('skills.createWithAI')}
                </button>
                <button
                  onClick={() => {
                    setAddOpen(false)
                    setEditor({ skill: null })
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-body text-left hover:bg-[var(--surface-3)]"
                >
                  <Icon.Edit size={16} className="text-[var(--muted)]" /> {t('skills.writeInstructions')}
                </button>
                <button
                  onClick={() => {
                    setAddOpen(false)
                    setUploadOpen(true)
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-body text-left hover:bg-[var(--surface-3)]"
                >
                  <Icon.Upload size={16} className="text-[var(--muted)]" /> {t('skills.upload')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* search */}
      <div className="relative">
        <Icon.Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
          placeholder={t('skills.searchPlaceholder')}
          aria-label={t('skills.searchPlaceholder')}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-1.5 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      {shown.length === 0 && (
        <div className="text-body text-[var(--muted)] py-6 text-center">
          {q ? t('skills.noMatch', { query }) : t('skills.empty')}
        </div>
      )}

      <div className="space-y-2">
        {shown.map((s) => (
          <div key={s.id} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex items-start gap-3">
              <Icon.SkillGlyph size={16} className="shrink-0 mt-0.5 text-[var(--accent)]" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-body flex items-center gap-2">
                  <span className="truncate">{s.title}</span>
                  {s.scope === 'system' && (
                    <span className="text-caption inline-flex items-center gap-0.5 text-[var(--muted)] border border-[var(--border)] rounded px-1">
                      <Icon.SkillGlyph size={10} /> {t('skills.badgeSystem')}
                    </span>
                  )}
                  {s.scope === 'global' && (
                    <span className="text-caption inline-flex items-center gap-0.5 text-[var(--muted)] border border-[var(--border)] rounded px-1">
                      <Icon.Globe2 size={10} /> {t('skills.badgeGlobal')}
                    </span>
                  )}
                  {!s.enabled && <span className="text-caption text-[var(--faint)]">{t('skills.disabledTag')}</span>}
                </div>
                <div className="text-caption text-[var(--faint)] truncate">{s.description}</div>
              </div>
              {/* system skills are always read-only; global skills are
                  read-only for non-admins */}
              {!s.readOnly && (s.scope !== 'global' || isAdmin) && (
                <div className="flex items-center gap-1 shrink-0">
                  <Switch checked={s.enabled} onChange={() => toggleEnabled(s)} label={t('skills.enabledFor', { name: s.title })} />
                  <button
                    onClick={async () => {
                      // fetch full body for the editor (list omits it)
                      try {
                        const r = await getJSON(`/api/skills/${s.id}`)
                        setEditor({ skill: r.skill })
                      } catch (e) {
                        setError(e.message)
                      }
                    }}
                    title={t('common.edit')}
                    aria-label={`${t('common.edit')}: ${s.title}`}
                    className="grid place-items-center w-8 h-8 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                  >
                    <Icon.Pencil size={13} />
                  </button>
                  <button
                    onClick={() => remove(s)}
                    title={t('common.delete')}
                    aria-label={`${t('common.delete')}: ${s.title}`}
                    className="grid place-items-center w-8 h-8 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--danger)] text-[var(--muted)]"
                  >
                    <Icon.Trash size={13} />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {editor && (
        <SkillEditorModal
          skill={editor.skill}
          isAdmin={isAdmin}
          onClose={() => setEditor(null)}
          returnFocus={() => addBtnRef.current}
          onSaved={() => {
            setEditor(null)
            load()
          }}
          onError={setError}
        />
      )}
      {uploadOpen && (
        <SkillUploadModal
          isAdmin={isAdmin}
          onClose={() => setUploadOpen(false)}
          returnFocus={() => addBtnRef.current}
          onSaved={() => {
            setUploadOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}

// Write / edit modal — mirrors claude.ai's "Write skill instructions": name,
// description, instructions (the body). Scope selector only for admins.
function SkillEditorModal({ skill, isAdmin, onClose, onSaved, onError, returnFocus }) {
  const t = useT()
  const editing = !!skill
  const [name, setName] = useState(skill?.name || '')
  const [title, setTitle] = useState(skill?.title || '')
  const [description, setDescription] = useState(skill?.description || '')
  const [body, setBody] = useState(skill?.body || '')
  const [triggers, setTriggers] = useState((skill?.triggers || []).join(', '))
  const [scope, setScope] = useState(skill?.scope || 'user')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [tried, setTried] = useState(false) // show required-field errors after the first save attempt
  const dialogRef = useRef(null)
  const titleId = useId()
  useModalDialog(dialogRef, { onClose, returnFocus })
  const required = (v) => (tried && !v.trim() ? t('skills.fieldRequired') : '')

  const save = async () => {
    if (busy) return
    setTried(true)
    if (!title.trim() || !description.trim() || !body.trim()) {
      setErr(t('skills.validationRequired'))
      return
    }
    setErr('')
    setBusy(true)
    try {
      const payload = {
        scope,
        name: name.trim() || title.trim(),
        title: title.trim(),
        description: description.trim(),
        body: body.trim(),
        triggers: triggers.split(',').map((t) => t.trim()).filter(Boolean),
        enabled: skill?.enabled !== false,
      }
      if (editing) await putJSON(`/api/skills/${skill.id}`, payload)
      else await postJSON('/api/skills', payload)
      onSaved()
    } catch (e) {
      setErr(e.message)
      onError?.(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-modal-nested grid place-items-center p-4">
      <div aria-hidden className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-modal animate-fade-in p-5 space-y-4 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id={titleId} className="font-bold text-heading">{editing ? t('skills.editTitle') : t('skills.writeTitle')}</h3>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="grid place-items-center w-9 h-9 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
            <Icon.Close size={18} />
          </button>
        </div>

        <Field label={t('skills.fieldName')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('skills.fieldNamePlaceholder')}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
          />
        </Field>
        <Field label={t('skills.fieldTitle')} error={required(title)}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('skills.fieldTitlePlaceholder')}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
          />
        </Field>
        <Field label={t('skills.fieldDescription')} hint={t('skills.fieldDescriptionHint')} error={required(description)}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder={t('skills.fieldDescriptionPlaceholder')}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
          />
        </Field>
        <Field label={t('skills.fieldInstructions')} hint={t('skills.fieldInstructionsHint')} error={required(body)}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            placeholder={t('skills.fieldInstructionsPlaceholder')}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
          />
        </Field>
        <Field label={t('skills.fieldTriggers')} hint={t('skills.fieldTriggersHint')}>
          <input
            value={triggers}
            onChange={(e) => setTriggers(e.target.value)}
            placeholder={t('skills.fieldTriggersPlaceholder')}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
          />
        </Field>
        {isAdmin && (
          <Field label={t('skills.fieldScope')} hint={t('skills.fieldScopeHint')}>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)]"
            >
              <option value="user">{t('skills.scopeUser')}</option>
              <option value="global">{t('skills.scopeGlobal')}</option>
            </select>
          </Field>
        )}

        {err && (
          <p role="alert" className="text-label text-[var(--danger)]">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-[var(--border)] hover:bg-[var(--surface-3)] text-body px-4 py-2 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-xl bg-[var(--accent-strong)] hover:brightness-110 text-[var(--on-accent)] font-semibold text-body px-4 py-2 disabled:opacity-50"
          >
            {busy ? t('common.saving') : editing ? t('common.save') : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}

// Upload modal — drag/drop or click to pick a .md (YAML frontmatter) or a
// .zip/.skill containing SKILL.md.
function SkillUploadModal({ isAdmin, onClose, onSaved, returnFocus }) {
  const t = useT()
  const [scope, setScope] = useState('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const dialogRef = useRef(null)
  const titleId = useId()
  useModalDialog(dialogRef, { onClose, returnFocus })

  const upload = async (file) => {
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('scope', scope)
      await postForm('/api/skills/upload', fd)
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-modal-nested grid place-items-center p-4">
      <div aria-hidden className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-modal animate-fade-in p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 id={titleId} className="font-bold text-heading">{t('skills.uploadTitle')}</h3>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="grid place-items-center w-9 h-9 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
            <Icon.Close size={18} />
          </button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            upload(e.dataTransfer.files?.[0])
          }}
          role="button"
          tabIndex={0}
          aria-label={t('skills.dropzone')}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          className={`rounded-xl border-2 border-dashed cursor-pointer grid place-items-center py-12 transition ${
            dragging ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.txt,.zip,.skill"
            className="hidden"
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <Icon.Upload size={26} className="text-[var(--muted)]" />
          <div className="text-body text-[var(--muted)] mt-2">
            {busy ? t('skills.uploading') : t('skills.dropzone')}
          </div>
        </div>

        <div className="text-label text-[var(--faint)] space-y-1">
          <div className="font-medium text-[var(--muted)]">{t('skills.fileRequirements')}</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>{t('skills.fileReqMd')}</li>
            <li>{t('skills.fileReqZip')}</li>
          </ul>
        </div>

        {isAdmin && (
          <select
            value={scope}
            aria-label={t('skills.fieldScope')}
            onChange={(e) => setScope(e.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-body focus:border-[var(--accent)]"
          >
            <option value="user">{t('skills.scopeUser')}</option>
            <option value="global">{t('skills.scopeGlobal')}</option>
          </select>
        )}

        {error && (
          <p role="alert" className="text-label text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

// label above the control; wrapping makes the association implicit
function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="block text-body font-medium">{label}</span>
      {hint && <span className="block text-caption text-[var(--muted)] mb-1 mt-0.5">{hint}</span>}
      {!hint && <span className="block mb-1" />}
      {children}
      {error && <span className="block mt-1 text-caption text-[var(--danger)]">{error}</span>}
    </label>
  )
}
