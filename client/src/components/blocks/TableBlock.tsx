import { useState } from 'react'
import type { TableBlockData } from './blockData.ts'
import { useT } from '../../lib/i18n.jsx'
import type { TFn } from '../../lib/tFn.ts'

const CAP = 12

// A `table` block: its own scroll container with a sticky header (message.css
// `.table-scroll`), focusable and named so it scrolls from the keyboard too.
// `embedded` drops the card chrome when another block (the chart's "View
// data") hosts it.
export default function TableBlock({ block, embedded = false }: { block: TableBlockData; embedded?: boolean }) {
  const t: TFn = useT()
  const { title, columns = [], rows = [] } = block
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? rows : rows.slice(0, CAP)
  const hidden = rows.length - visible.length

  const table = (
    <>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={title || t('message.tableRegion')}>
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="tap-target text-label text-accent-text hover:underline rounded-control px-1"
        >
          {t('table.moreRows', { count: hidden })}
        </button>
      )}
    </>
  )
  if (embedded) return table
  return (
    <div data-block="table" className="rounded-card border border-border bg-surface-2 p-4 my-3">
      {title && <div className="text-body font-semibold mb-2">{title}</div>}
      {table}
    </div>
  )
}
