import { useI18n } from '../../lib/i18n.tsx'
import { payloadSummary } from './agentsLogic.ts'

// The content of a version as a read-only list, without assuming the payload is today's recipe: a field that is missing is
// left out, a payload with nothing this screen knows how to show says so, and the keys it does not render are named. The flow
// graph of a later branch plugs its own view in here (agentsLogic.payloadSummary is the one place that knows the shape).
export default function PayloadPreview({ definition, showModel = true, showTools = true }: { definition: unknown; showModel?: boolean; showTools?: boolean }) {
  const { t } = useI18n()
  const s = payloadSummary(definition)
  return (
    <div className="space-y-1.5">
      {!s.hasRecipe && s.extraKeys.length > 0 && <p className="text-label text-[var(--muted)]">{t('agents.shared.noContent')}</p>}
      <dl className="space-y-1.5">
        {s.prompt && (
          <div>
            <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.prompt')}</dt>
            <dd className="whitespace-pre-wrap text-[var(--text)]">{s.prompt}</dd>
          </div>
        )}
        {s.instructions && (
          <div>
            <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.instructions')}</dt>
            <dd className="whitespace-pre-wrap text-[var(--text)]">{s.instructions}</dd>
          </div>
        )}
        {showModel && s.model && (
          <div>
            <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.model')}</dt>
            <dd className="text-[var(--text)]">{s.model}</dd>
          </div>
        )}
        {showTools && (
          <div>
            <dt className="text-caption font-semibold uppercase tracking-wide text-[var(--muted)]">{t('agents.field.tools')}</dt>
            <dd className="text-[var(--text)]">{s.tools.length ? s.tools.join(', ') : t('agents.versions.diff.empty')}</dd>
          </div>
        )}
      </dl>
      {s.extraKeys.length > 0 && <p className="text-caption text-[var(--muted)]">{t('agents.versions.extraKeys', { keys: s.extraKeys.join(', ') })}</p>}
    </div>
  )
}
