import { useI18n } from '../../lib/i18n.tsx'
import type { FieldChange, VersionDiff } from '../../../../shared/agentVersionDiff.ts'
import { definitionLabel } from './agentsLogic.ts'

// "What changed" between two versions of an agent, as the history panel and the admin review card show it. The diff itself
// (shared/agentVersionDiff.ts) decides what changed; this only words it. Every line carries its meaning as text: an added or a
// removed line starts with a + or a − sign and a screen-reader label, never color alone.

const valueText = (v: unknown, none: string): string => {
  if (v === null || v === undefined || v === '') return none
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function fieldLabel(t: (key: string, vars?: Record<string, string | number>) => string, field: string): string {
  const key = definitionLabel(field)
  return key ? t(key) : t('agents.versions.diff.other', { name: field })
}

function ChangeBody({ c }: { c: FieldChange }) {
  const { t } = useI18n()
  const none = t('agents.versions.diff.empty')
  if (c.kind === 'text' && c.lines) {
    return (
      <ul className="mt-1 rounded-control bg-[var(--surface-2)] font-mono text-caption leading-snug overflow-x-auto">
        {c.lines.map((l, i) => (
          <li key={i} className={`flex gap-2 px-2 py-0.5 whitespace-pre-wrap break-words ${l.op === 'same' ? 'text-[var(--muted)]' : l.op === 'add' ? 'bg-[var(--success-soft)] text-[var(--text)]' : 'bg-[var(--danger-soft)] text-[var(--text)]'}`}>
            <span aria-hidden className="shrink-0 select-none w-3 text-center">
              {l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}
            </span>
            {l.op !== 'same' && <span className="sr-only">{t(l.op === 'add' ? 'agents.versions.diff.lineAdded' : 'agents.versions.diff.lineRemoved')}: </span>}
            <span className="min-w-0">{l.text || ' '}</span>
          </li>
        ))}
      </ul>
    )
  }
  if (c.kind === 'set') {
    return (
      <>
        {c.added && c.added.length > 0 && <span className="block">{t('agents.admin.diff.added', { items: c.added.join(', ') })}</span>}
        {c.removed && c.removed.length > 0 && <span className="block">{t('agents.admin.diff.removed', { items: c.removed.join(', ') })}</span>}
        {c.reordered && <span className="block text-[var(--muted)]">{t('agents.versions.diff.reordered')}</span>}
      </>
    )
  }
  return (
    <>
      <span className="block text-[var(--muted)] break-words">
        {t('agents.admin.diff.before')}: {valueText(c.before, none)}
      </span>
      <span className="block break-words">
        {t('agents.admin.diff.after')}: {valueText(c.after, none)}
      </span>
    </>
  )
}

export default function VersionDiffView({ diff }: { diff: VersionDiff }) {
  const { t } = useI18n()
  return (
    <ul className="space-y-1.5">
      {diff.changes.map((c) => (
        <li key={c.field} className="text-label text-[var(--text)]">
          <span className="font-semibold">{fieldLabel(t, c.field)}</span>
          <ChangeBody c={c} />
        </li>
      ))}
    </ul>
  )
}
