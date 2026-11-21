import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.tsx'
import ArtifactCard from './ArtifactCard.tsx'
import { documentTeaser } from './blockData.ts'

// Compact card for a generated `document` block, same anatomy as the deck and
// spreadsheet cards: title, meta, a teaser from the first paragraph (never raw
// table or heading syntax) and Open, which shows the Document Studio (rich
// preview + AI editing + DOCX/MD/PDF export).
interface DocumentBlockProps {
  block: { title?: string | null; markdown?: string; documentId?: string | number | null }
  onOpenDocument?: (id: string | number | null | undefined) => void
}

export default function DocumentBlock({ block, onOpenDocument }: DocumentBlockProps) {
  const t = useT()
  const canOpen = !!block.documentId
  const teaser = documentTeaser(block.markdown)

  return (
    <ArtifactCard
      kind="document"
      icon={<Icon.FileText size={18} />}
      title={block.title || t('docBlock.defaultTitle')}
      meta={t('docBlock.meta')}
      primary={{
        icon: <Icon.FileText size={15} />,
        label: t('docBlock.open'),
        onClick: () => onOpenDocument?.(block.documentId),
        disabled: !canOpen,
      }}
    >
      {teaser ? <p className="text-label text-muted line-clamp-2">{teaser}</p> : null}
    </ArtifactCard>
  )
}
