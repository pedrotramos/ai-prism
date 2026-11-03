import { createContext, useContext } from 'react'

// What the admin lets users see of the taxímetro (server/budgets.js meterView),
// as last reported by /api/usage/summary:
//   { session: boolean, month: 'usd' | 'pct' | 'hidden' } — or null while the
//   first summary hasn't arrived (costs stay hidden so a disallowed figure
//   never flashes), or 'unknown' when it failed (fall back to showing, as
//   before the setting existed).
export const CostDisplayContext = createContext(null)

// Whether per-call costs (message footer, CostBadge chips in chat and studios)
// may be shown — they follow the "session cost" switch: with it off, the
// conversation's cost could otherwise be summed up by hand.
export function useShowCallCosts() {
  const d = useContext(CostDisplayContext)
  if (d === 'unknown') return true
  return !!d && d.session !== false
}
