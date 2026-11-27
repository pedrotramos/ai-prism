import { useEffect, useId, useState } from 'react'
import { useI18n } from '../../lib/i18n.tsx'
import { agentsApi, AgentsApiError } from './agentsApi.ts'
import type { SchedulePreview } from './agentsApi.ts'
import { cronDayRuleIsOr, formatInstant } from './agentsLogic.ts'
import type { AgentLang, AgentSchedule } from './agentsLogic.ts'

// What a schedule means and when it runs next, both computed by the server (POST /api/agents/schedule-preview, read-only):
// shown to the owner while editing and to the admin on the review card, so the person who approves a cron sees the same
// thing the person who typed it saw (what it says, the next three instants, and that two day fields mean "either").

export type PreviewState = { state: 'idle' | 'loading' | 'ok' | 'error'; data?: SchedulePreview; code?: string }

/** The server's reading of `schedule` (debounced; a stale answer is dropped). Idle with no schedule. */
export function useSchedulePreview(schedule: AgentSchedule | null | undefined, lang: AgentLang, debounceMs = 350): PreviewState {
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' })
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
    }, debounceMs)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sched, lang, debounceMs])
  return preview
}

interface Props {
  schedule: AgentSchedule
  preview: PreviewState
  /** the cron's own error is shown at its field: this card then stays quiet about it */
  hideError?: boolean
}

export default function SchedulePreviewCard({ schedule, preview, hideError = false }: Props) {
  const { t, locale } = useI18n()
  const nextId = useId()
  return (
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
      {cronDayRuleIsOr(schedule) && <p className="text-label text-[var(--text)]">{t('agents.schedule.dayEither')}</p>}
      {preview.state === 'loading' && !preview.data && <p className="text-label text-[var(--muted)]">{t('agents.schedule.nextLoading')}</p>}
      {preview.state === 'error' && !hideError && <p className="text-label text-[var(--danger)]">{t('agents.schedule.nextUnavailable')}</p>}
    </section>
  )
}
