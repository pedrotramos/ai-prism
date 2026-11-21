import { useEffect, useId, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'
import { projectsApi } from './projectsApi.js'
import { can, charCounter } from './projectsLogic.js'
import { FailureNotice, Section, inputCls, primaryBtn } from './ui.jsx'

export default function InstructionsSection({ projectId, project, role, limits, onRefused, onChanged, onSaved }) {
  const t = useT()
  const id = useId()
  const counterId = useId()
  const [draft, setDraft] = useState(project.instructions || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const editable = can(role, 'edit')
  const max = limits?.instructionsMaxChars ?? null
  const counter = charCounter(draft, max)
  const dirty = draft !== (project.instructions || '')

  // someone else saved (or the role changed): the stored text wins when this one is untouched
  useEffect(() => {
    if (!dirty) setDraft(project.instructions || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.instructions])

  const save = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const r = await projectsApi.update(projectId, { instructions: draft })
      onSaved(r.project || { instructions: draft })
      setSaved(true)
      onChanged?.()
    } catch (e) {
      setError(e)
      onRefused(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title={t('projects.instructions.title')} hint={editable ? t('projects.instructions.hint') : t('projects.instructions.hintReadOnly')}>
      <label htmlFor={id} className="sr-only">
        {t('projects.instructions.label')}
      </label>
      <textarea
        id={id}
        value={draft}
        onChange={(e) => (setDraft(e.target.value), setSaved(false))}
        readOnly={!editable}
        rows={6}
        aria-describedby={editable ? counterId : undefined}
        aria-invalid={counter.state === 'over' || undefined}
        placeholder={editable ? t('projects.instructions.placeholder') : t('projects.instructions.none')}
        className={`${inputCls} py-2 leading-relaxed resize-y ${editable ? '' : 'bg-[var(--surface-2)]'}`}
      />
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <p id={counterId} className={`text-label ${counter.state === 'over' ? 'text-[var(--danger)] font-semibold' : 'text-[var(--muted)]'}`}>
            {max == null ? t('projects.instructions.count', { n: counter.count.toLocaleString() }) : t('projects.instructions.counter', { n: counter.count.toLocaleString(), max: max.toLocaleString() })}
            {counter.state === 'over' && ` ${t('projects.instructions.over', { n: (counter.count - max).toLocaleString() })}`}
          </p>
          <button type="button" onClick={save} disabled={saving || !dirty || counter.state === 'over'} className={`${primaryBtn} ml-auto`}>
            {saving ? t('projects.saving') : t('common.save')}
          </button>
        </div>
      )}
      <p role="status" className="text-label text-[var(--muted)] empty:hidden">
        {saved ? t('projects.instructions.saved') : ''}
      </p>
      <FailureNotice error={error} ctx="edit" onDismiss={() => setError(null)} />
    </Section>
  )
}
