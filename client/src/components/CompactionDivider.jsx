import { useT } from '../lib/i18n.jsx'

// Divider in the thread where the conversation was compacted (server/compaction.js).
// The messages above it stay visible; the model replays them only as the summary
// that this marker stands for.
export default function CompactionDivider({ compaction }) {
  const t = useT()
  const label = compaction?.auto ? t('compaction.dividerAuto') : t('compaction.divider')
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 py-2 text-xs text-[var(--muted)]">
      <span className="h-px flex-1 bg-[var(--border)]" aria-hidden="true" />
      <span className="shrink-0">{label}</span>
      <span className="h-px flex-1 bg-[var(--border)]" aria-hidden="true" />
    </div>
  )
}
