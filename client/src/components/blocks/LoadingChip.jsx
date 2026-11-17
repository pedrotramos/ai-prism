import { useT } from '../../lib/i18n.jsx'

// Shown inline, right where the model is currently emitting a ```prism-block
// fence, so the user sees *where* a chart/insight is coming together instead
// of the reply appearing to stall once visible text stops growing. The label
// is precise per artifact kind (sniffed from the fence's "type" field by
// Message.jsx) — "Preparando gráfico/apresentação/planilha" reads as honest
// progress; the generic "visualização" is only the fallback before the type
// has streamed in.
const LABEL_KEYS = {
  chart: 'loading.chart',
  insight: 'loading.insight',
  table: 'loading.table',
  deck: 'loading.deck',
  'deck-html': 'loading.deck',
  'deck-questions': 'loading.deckQuestions',
  spreadsheet: 'loading.spreadsheet',
  document: 'loading.document',
}

export default function LoadingChip({ blockType }) {
  const t = useT()
  const label = t(LABEL_KEYS[blockType] || 'loading.fallback')
  return (
    <div className="inline-flex items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 my-2 text-label text-muted">
      <span aria-hidden className="w-3 h-3 rounded-pill border-2 border-accent border-t-transparent animate-spin" />
      {label}
    </div>
  )
}
