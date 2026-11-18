import { useT, useI18n } from '../../lib/i18n.jsx'
import { pivotMatrix, formatChartValue } from '../../../../shared/chartValue.js'

// The body of a `pivot` chart block: a real table (row and column headers,
// row/column/grand totals, an em dash for an empty combination), so screen
// readers navigate it as a table and nothing depends on colour. Uses the same
// scroll container as TableBlock (message.css `.table-scroll`). Hosted by
// ChartBlock, which supplies the card chrome and the title.
export default function PivotBlock({ block }) {
  const t = useT()
  const { locale } = useI18n()
  const m = pivotMatrix(block.series || [])
  const fmt = (v) => formatChartValue(v, locale)
  const corner = [block.rowLabel, block.colLabel].filter(Boolean).join(' / ')

  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={block.title || t('chart.type.pivot')}>
      <table>
        {block.valueLabel && <caption className="sr-only">{block.valueLabel}</caption>}
        <thead>
          <tr>
            <th scope="col">{corner}</th>
            {m.colLabels.map((c, i) => (
              <th key={i} scope="col" className="!text-right">
                {c}
              </th>
            ))}
            <th scope="col" className="!text-right">
              {t('chart.total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {m.rowLabels.map((label, r) => (
            <tr key={r}>
              <th scope="row" className="text-left font-normal">
                {label}
              </th>
              {m.cells[r].map((v, c) => (
                <td key={c} className="!text-right tabular-nums">
                  {fmt(v)}
                </td>
              ))}
              <td className="!text-right tabular-nums font-semibold">{fmt(m.rowTotals[r])}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="text-left">
              {t('chart.total')}
            </th>
            {m.colTotals.map((v, c) => (
              <td key={c} className="!text-right tabular-nums font-semibold">
                {fmt(v)}
              </td>
            ))}
            <td className="!text-right tabular-nums font-semibold">{fmt(m.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
