import { useState } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import type { TFn } from '../../lib/tFn.ts'
import ArtifactCard from './ArtifactCard.tsx'

// A compact card for a generated `spreadsheet` block — NOT a full preview.
// It announces the workbook (title + "Spreadsheet · XLSX · N tabs") and offers
// two actions: open the Studio (full preview + AI editing) or download the
// .xlsx. The rich grid/charts live in the Studio. Same anatomy as the deck and
// document cards (ArtifactCard).
interface SpreadsheetBlockProps {
  block: { title?: string | null; sheets?: unknown[]; spreadsheetId?: string | number | null }
  onOpenSpreadsheet?: (id: string | number | null | undefined) => void
}

export default function SpreadsheetBlock({ block, onOpenSpreadsheet }: SpreadsheetBlockProps) {
  const t: TFn = useT()
  const [exporting, setExporting] = useState(false)
  const [err, setErr] = useState('')

  const sheetCount = (block.sheets || []).length
  const canOpen = !!block.spreadsheetId

  const exportXlsx = async () => {
    if (!block.spreadsheetId) return
    setExporting(true)
    setErr('')
    try {
      const res = await fetch(`/api/spreadsheets/${block.spreadsheetId}/export`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(block.title || 'planilha').replace(/[^\w-]+/g, '_').slice(0, 60)}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(t('spreadsheetBlock.exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  const meta =
    t('spreadsheetBlock.meta') +
    (sheetCount
      ? t('spreadsheetBlock.tabsSuffix', {
          count: sheetCount,
          tab: sheetCount !== 1 ? t('spreadsheetBlock.tabPlural') : t('spreadsheetBlock.tabSingular'),
        })
      : '')

  return (
    <ArtifactCard
      kind="spreadsheet"
      icon={<Icon.SpreadsheetFile size={22} />}
      title={block.title || t('spreadsheetBlock.defaultTitle')}
      meta={meta}
      primary={{
        icon: <Icon.Expand size={15} />,
        label: t('spreadsheetBlock.openStudio'),
        title: t('spreadsheetBlock.openStudioTitle'),
        onClick: () => canOpen && onOpenSpreadsheet?.(block.spreadsheetId),
        disabled: !canOpen,
      }}
      secondary={{
        icon: <Icon.Download size={15} />,
        label: exporting ? t('spreadsheetBlock.downloading') : t('spreadsheetBlock.download'),
        title: t('spreadsheetBlock.downloadTitle'),
        onClick: exportXlsx,
        disabled: !canOpen || exporting,
        'aria-busy': exporting || undefined,
      }}
      error={err}
    />
  )
}
