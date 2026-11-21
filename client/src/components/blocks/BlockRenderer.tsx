import type { ComponentType } from 'react'
import ChartBlock from './ChartBlock.tsx'
import TableBlock from './TableBlock.tsx'
import InsightCard from './InsightCard.tsx'
import DeckBlock from './DeckBlock.tsx'
import DeckQuestionsBlock from './DeckQuestionsBlock.tsx'
import SpreadsheetBlock from './SpreadsheetBlock.tsx'
import ImageBlock from './ImageBlock.tsx'
import DocumentBlock from './DocumentBlock.tsx'

// `any`: each renderer declares only the props it reads; the block shape itself is
// validated server-side, so the table cannot be typed by one props interface.
const RENDERERS: Record<string, ComponentType<any>> = {
  chart: ChartBlock,
  table: TableBlock,
  insight: InsightCard,
  deck: DeckBlock,
  'deck-html': DeckBlock,
  'deck-questions': DeckQuestionsBlock,
  spreadsheet: SpreadsheetBlock,
  image: ImageBlock,
  document: DocumentBlock,
}

interface BlockRendererProps {
  blocks?: { type?: string }[] | null
  msgId?: string | number
  models?: unknown
  onOpenDeck?: (id: unknown) => void
  onOpenSpreadsheet?: (id: unknown) => void
  onOpenDocument?: (id: unknown) => void
  isLatest?: boolean
  onSubmitAnswers?: (text: string, meta: { msgId?: string | number; answers: Record<string, string | string[]>; isEdit: boolean }) => Promise<unknown> | unknown
}

export default function BlockRenderer({ blocks, msgId, models, onOpenDeck, onOpenSpreadsheet, onOpenDocument, isLatest, onSubmitAnswers }: BlockRendererProps) {
  if (!blocks?.length) return null
  return (
    <div>
      {blocks.map((b, i) => {
        const Cmp = b.type ? RENDERERS[b.type] : undefined
        return Cmp ? (
          <Cmp
            key={i}
            block={b}
            msgId={msgId}
            models={models}
            onOpenDeck={onOpenDeck}
            onOpenSpreadsheet={onOpenSpreadsheet}
            onOpenDocument={onOpenDocument}
            isLatest={isLatest}
            onSubmitAnswers={onSubmitAnswers}
          />
        ) : null
      })}
    </div>
  )
}
