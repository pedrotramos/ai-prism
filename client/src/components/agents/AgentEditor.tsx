import { useEffect, useId, useMemo, useState } from 'react'
import * as Icon from '../Icons.tsx'
import { useI18n } from '../../lib/i18n.tsx'
import { effortLevelsOf } from '../../lib/reasoningEffort.ts'
import { Disclosure, Field } from '../SettingsControls.tsx'
import { inputCls, primaryBtn, ghostBtn } from '../projects/ui.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import type { SchedulePreview } from './agentsApi.ts'
import { browserTimeZone, CRON_EXAMPLES, emptyForm, errorKey, formatInstant, formFromRow, formToBody, needsVoidWarning, scheduleFields, scheduleForFreq, selectableTools } from './agentsLogic.ts'
import type { AgentForm, AgentLang, AgentLimits, AgentRow, AgentSchedule, CustomSchedule, PresetSchedule, ScheduleFreq, ToolOptions } from './agentsLogic.ts'

// Create / edit one agent. Progressive disclosure: name, prompt, tools and the schedule up front; instructions,
// reasoning effort and the result language behind "Advanced". The schedule's meaning and its next three occurrences
// come from the server (POST /api/agents/schedule-preview): this file only formats them in the chosen time zone.

interface ModelOption {
  id: string
  label: string
  reasoning?: { levels?: string[]; [k: string]: unknown } | boolean | null
}
interface Props {
  agent: AgentRow | null
  models: ModelOption[]
  defaultModel: string
  uiLang: string
  toolOptions: ToolOptions | null
  toolsFailed: boolean
  limits: AgentLimits | null
  onSaved: (row: AgentRow) => void
  onCancel: () => void
  onTryInChat: (draft: { instructions: string; prompt: string }) => void
}

const FREQS: ScheduleFreq[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom']
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const pad = (n: number) => String(n).padStart(2, '0')

function timeZones(current: string): string[] {
  const i = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  let all: string[] = []
  try {
    all = i.supportedValuesOf?.('timeZone') ?? []
  } catch {
    all = []
  }
  return [...new Set(['UTC', current, ...all])].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)))
}

const toLang = (ui: string): AgentLang => (ui.startsWith('pt') ? 'pt' : ui.startsWith('es') ? 'es' : 'en')

export default function AgentEditor({ agent, models, defaultModel, uiLang, toolOptions, toolsFailed, limits, onSaved, onCancel, onTryInChat }: Props) {
  const { t, locale } = useI18n()
  const titleId = useId()
  const nextId = useId()
  const lang = toLang(locale)
  const [form, setForm] = useState<AgentForm>(() => {
    if (agent) return formFromRow(agent)
    const model = models.some((m) => m.id === defaultModel) ? defaultModel : (models[0]?.id ?? defaultModel)
    return emptyForm({ model, lang: toLang(uiLang === 'auto' ? locale : uiLang), tz: browserTimeZone() })
  })
  const [errors, setErrors] = useState<{ name?: string; prompt?: string }>({})
  const [saving, setSaving] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [confirmVoid, setConfirmVoid] = useState(false)
  const [preview, setPreview] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; data?: SchedulePreview; code?: string }>({ state: 'idle' })
  const cronId = useId()
  const cronHintId = useId()

  const patch = (p: Partial<AgentForm>) => setForm((f) => ({ ...f, ...p }))
  const patchSchedule = (p: Partial<PresetSchedule> | Partial<CustomSchedule>) => setForm((f) => (f.schedule ? { ...f, schedule: { ...f.schedule, ...p } as AgentSchedule } : f))
  // what the server offers; a saved tool it no longer offers is NOT selectable: it is listed as unavailable, Remove only
  const tools = useMemo(() => selectableTools(toolOptions), [toolOptions])
  const unavailable = useMemo(() => form.tools.filter((r) => !tools.some((o) => o.ref === r)), [tools, form.tools])
  const model = models.find((m) => m.id === form.model) ?? null
  const efforts = effortLevelsOf(model)
  const schedule = form.schedule
  const zones = useMemo(() => timeZones(schedule?.tz ?? 'UTC'), [schedule?.tz])

  // the server describes the schedule and lists its next three occurrences (debounced; a stale answer is dropped)
  const sched = schedule ? JSON.stringify(schedule) : ''
  useEffect(() => {
    if (!sched) {
      setPreview({ state: 'idle' })
      return undefined
    }
    let alive = true
    setPreview((p) => ({ state: 'loading', ...(p.data ? { data: p.data } : {}) }))
    const timer = setTimeout(() => {
      agentsApi
        .previewSchedule(JSON.parse(sched) as AgentSchedule, lang)
        .then((data) => alive && setPreview({ state: 'ok', data }))
        // a refusal of the cron itself (bad field, more often than hourly, ...) says why; anything else is "could not be checked"
        .catch((err) => alive && setPreview({ state: 'error', ...(err instanceof AgentsApiError ? { code: err.code } : {}) }))
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sched, lang])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const next: typeof errors = {}
    if (!form.name.trim()) next.name = t('agents.editor.nameRequired')
    if (!form.prompt.trim()) next.prompt = t('agents.editor.promptRequired')
    setErrors(next)
    if (next.name || next.prompt) return
    if (needsVoidWarning(agent, form) && !confirmVoid) {
      setApiError(null)
      setConfirmVoid(true)
      return
    }
    setSaving(true)
    setApiError(null)
    try {
      const body = formToBody(form)
      const row = agent ? await agentsApi.update(agent.id, body, agent.revision) : await agentsApi.create(body)
      onSaved(row)
    } catch (err) {
      setConfirmVoid(false)
      setApiError(err instanceof AgentsApiError ? err.code : 'internal_error')
    } finally {
      setSaving(false)
    }
  }

  const max = limits
  const counter = (n: number, cap?: number) => (cap ? t('agents.field.counter', { n, max: cap }) : undefined)

  return (
    <form onSubmit={submit} noValidate aria-labelledby={titleId} className="space-y-4">
      <div>
        <h2 id={titleId} className="text-title font-semibold text-[var(--text)]">
          {agent ? t('agents.editor.titleEdit') : t('agents.editor.titleNew')}
        </h2>
        <p className="text-label text-[var(--muted)]">{t('agents.editor.intro')}</p>
      </div>

      <Field label={t('agents.field.name')} error={errors.name}>
        {(p) => <input {...p} className={inputCls} value={form.name} maxLength={max?.nameMax} autoComplete="off" onChange={(e) => patch({ name: e.target.value })} />}
      </Field>
      <Field label={t('agents.field.description')} hint={t('agents.field.descriptionHint')}>
        {(p) => <input {...p} className={inputCls} value={form.description} maxLength={max?.descriptionMax} autoComplete="off" onChange={(e) => patch({ description: e.target.value })} />}
      </Field>
      <Field label={t('agents.field.prompt')} hint={[t('agents.field.promptHint'), counter(form.prompt.length, max?.promptMax)].filter(Boolean).join(' ')} error={errors.prompt}>
        {(p) => <textarea {...p} className={`${inputCls} min-h-28`} rows={5} value={form.prompt} maxLength={max?.promptMax} onChange={(e) => patch({ prompt: e.target.value })} />}
      </Field>
      <Field label={t('agents.field.model')}>
        {(p) => (
          <select
            {...p}
            className={inputCls}
            value={form.model}
            onChange={(e) => {
              const m = models.find((x) => x.id === e.target.value)
              patch({ model: e.target.value, reasoningEffort: effortLevelsOf(m ?? null).includes(form.reasoningEffort ?? '') ? form.reasoningEffort : null })
            }}
          >
            {!models.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <fieldset className="rounded-card border border-[var(--border)] p-3 space-y-1">
        <legend className="px-1 text-label font-semibold text-[var(--text)]">{t('agents.field.tools')}</legend>
        <p className="text-caption text-[var(--muted)]">{t('agents.tools.hint')}</p>
        {toolsFailed && <p className="text-label text-[var(--danger)]">{t('agents.tools.loadFailed')}</p>}
        <ul className="space-y-0.5">
          {tools.map((tool) => {
            const checked = form.tools.includes(tool.ref)
            const note = `${nextId}-n-${tool.ref}`
            return (
              <li key={tool.ref}>
                <label className="flex items-start gap-2.5 min-h-11 md:min-h-9 py-1.5 text-body text-[var(--text)] cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-strong)]"
                    checked={checked}
                    aria-describedby={tool.readsWorkspaceData ? note : undefined}
                    onChange={() => patch({ tools: checked ? form.tools.filter((x) => x !== tool.ref) : [...form.tools, tool.ref] })}
                  />
                  <span className="min-w-0">
                    {tool.labelIsKey ? t(tool.label) : tool.label}
                    {tool.readsWorkspaceData && (
                      <span id={note} className="block text-caption text-[var(--muted)]">
                        {t('agents.tools.dataNote')}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            )
          })}
          {unavailable.map((ref) => (
            <li key={ref} className="flex flex-wrap items-center gap-2 min-h-11 md:min-h-9 py-1.5 text-body text-[var(--muted)]">
              <Icon.AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" aria-hidden />
              <span className="min-w-0 flex-1 break-all">
                {ref} <span className="text-caption">({t('agents.tools.unavailable')})</span>
              </span>
              <button type="button" className={ghostBtn} onClick={() => patch({ tools: form.tools.filter((x) => x !== ref) })}>
                {t('agents.tools.remove', { name: ref })}
              </button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="rounded-card border border-[var(--border)] p-3 space-y-3">
        <legend className="px-1 text-label font-semibold text-[var(--text)]">{t('agents.field.schedule')}</legend>
        <Field label={t('agents.schedule.freq')}>
          {(p) => (
            <select
              {...p}
              className={inputCls}
              value={schedule?.freq ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (!v) return patch({ schedule: null })
                patch({ schedule: scheduleForFreq(schedule, v as ScheduleFreq, browserTimeZone()) })
              }}
            >
              <option value="">{t('agents.schedule.none')}</option>
              {FREQS.map((f) => (
                <option key={f} value={f}>
                  {t(`agents.schedule.${f}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {schedule && (
          <>
            {schedule.freq === 'custom' ? (
              <div className="space-y-2">
                <Field label={t('agents.schedule.cron')} hint={t('agents.schedule.cronHint')}>
                  {(p) => (
                    <input
                      {...p}
                      id={cronId}
                      type="text"
                      className={`${inputCls} font-mono`}
                      value={schedule.cron}
                      maxLength={120}
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="off"
                      aria-invalid={preview.state === 'error' && !!preview.code?.startsWith('cron_') ? true : undefined}
                      aria-describedby={cronHintId}
                      placeholder="0 9,17 * * 1-5"
                      onChange={(e) => patchSchedule({ cron: e.target.value })}
                    />
                  )}
                </Field>
                <div id={cronHintId} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-caption text-[var(--muted)]">{t('agents.schedule.cronExamples')}</span>
                  {CRON_EXAMPLES.map((ex) => (
                    <button key={ex.cron} type="button" className={`${ghostBtn} !min-h-0 py-1 px-2 text-caption`} onClick={() => patchSchedule({ cron: ex.cron })}>
                      {t(ex.labelKey)} <code className="font-mono text-[var(--muted)]">{ex.cron}</code>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {scheduleFields(schedule.freq).map((f) => (
                <Field key={f} label={t(`agents.schedule.${f}`)}>
                  {(p) =>
                    f === 'weekday' ? (
                      <select {...p} className={inputCls} value={schedule.weekday ?? 1} onChange={(e) => patchSchedule({ weekday: Number(e.target.value) })}>
                        {range(0, 6).map((d) => (
                          <option key={d} value={d}>
                            {t(`agents.weekday.${d}`)}
                          </option>
                        ))}
                      </select>
                    ) : f === 'monthday' ? (
                      <select {...p} className={inputCls} value={schedule.monthday ?? 1} onChange={(e) => patchSchedule({ monthday: Number(e.target.value) })}>
                        {range(1, 28).map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    ) : f === 'hour' ? (
                      <select {...p} className={inputCls} value={schedule.hour ?? 0} onChange={(e) => patchSchedule({ hour: Number(e.target.value) })}>
                        {range(0, 23).map((h) => (
                          <option key={h} value={h}>
                            {pad(h)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select {...p} className={inputCls} value={schedule.minute} onChange={(e) => patchSchedule({ minute: Number(e.target.value) })}>
                        {range(0, 59).map((m) => (
                          <option key={m} value={m}>
                            {pad(m)}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
              ))}
            </div>
            )}
            <Field label={t('agents.schedule.tz')}>
              {(p) => (
                <select {...p} className={inputCls} value={schedule.tz} onChange={(e) => patchSchedule({ tz: e.target.value })}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <section aria-labelledby={nextId} className="rounded-control bg-[var(--surface-2)] px-3 py-2 space-y-1">
              <h3 id={nextId} className="text-label font-semibold text-[var(--text)]">
                {t('agents.schedule.next')}
              </h3>
              {preview.data && (
                <>
                  <p className="text-label text-[var(--muted)]">{preview.data.description}</p>
                  <ul className="space-y-0.5">
                    {preview.data.next.map((iso) => (
                      <li key={iso} className="text-body text-[var(--text)]">
                        {formatInstant(iso, schedule.tz, locale)}
                      </li>
                    ))}
                  </ul>
                  <p className="text-caption text-[var(--muted)]">{t('agents.schedule.nextTz', { tz: schedule.tz })}</p>
                </>
              )}
              {preview.state === 'loading' && !preview.data && <p className="text-label text-[var(--muted)]">{t('agents.schedule.nextLoading')}</p>}
              {preview.state === 'error' && (
                <p role="alert" className="text-label text-[var(--danger)]">
                  {preview.code && (preview.code.startsWith('cron_') || preview.code === 'schedule_too_frequent') ? t(errorKey(preview.code)) : t('agents.schedule.nextUnavailable')}
                </p>
              )}
            </section>
          </>
        )}
      </fieldset>

      <Disclosure title={t('agents.editor.advanced')}>
        <div className="space-y-3">
          <Field label={t('agents.field.instructions')} hint={[t('agents.field.instructionsHint'), counter(form.instructions.length, max?.instructionsMax)].filter(Boolean).join(' ')}>
            {(p) => <textarea {...p} className={`${inputCls} min-h-24`} rows={4} value={form.instructions} maxLength={max?.instructionsMax} onChange={(e) => patch({ instructions: e.target.value })} />}
          </Field>
          {efforts.length > 0 && (
            <Field label={t('agents.field.reasoningEffort')}>
              {(p) => (
                <select {...p} className={inputCls} value={form.reasoningEffort ?? ''} onChange={(e) => patch({ reasoningEffort: (e.target.value || null) as AgentForm['reasoningEffort'] })}>
                  <option value="">{t('agents.effort.default')}</option>
                  {efforts.map((l) => (
                    <option key={l} value={l}>
                      {t(`agents.effort.${l}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label={t('agents.field.lang')}>
            {(p) => (
              <select {...p} className={inputCls} value={form.lang} onChange={(e) => patch({ lang: e.target.value as AgentLang })}>
                {(['en', 'pt', 'es'] as const).map((l) => (
                  <option key={l} value={l}>
                    {t(`agents.lang.${l}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Disclosure>

      {apiError && (
        <p role="alert" className="flex items-start gap-2 rounded-control border border-[var(--border)] bg-[var(--danger-soft)] px-3 py-2.5 text-body text-[var(--text)]">
          <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" aria-hidden /> {t(errorKey(apiError))}
        </p>
      )}

      {confirmVoid ? (
        <div role="alert" className="rounded-card border border-[var(--warning,var(--border))] bg-[var(--surface-2)] p-3 space-y-2">
          <p className="text-body font-semibold text-[var(--text)]">{t('agents.void.title')}</p>
          <p className="text-label text-[var(--muted)]">{t('agents.void.body')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryBtn} disabled={saving} onClick={() => void submit()}>
              {saving ? t('agents.editor.saving') : t('agents.void.confirm')}
            </button>
            <button type="button" className={ghostBtn} disabled={saving} onClick={() => setConfirmVoid(false)}>
              {t('agents.void.keep')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={primaryBtn} disabled={saving}>
            {saving ? t('agents.editor.saving') : t('agents.editor.save')}
          </button>
          <button type="button" className={ghostBtn} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${ghostBtn} sm:ml-auto`}
            title={t('agents.editor.tryInChatHint')}
            disabled={!form.prompt.trim()}
            onClick={() => onTryInChat({ instructions: form.instructions.trim(), prompt: form.prompt.trim() })}
          >
            <Icon.Send size={14} aria-hidden /> {t('agents.editor.tryInChat')}
          </button>
        </div>
      )}
    </form>
  )
}
