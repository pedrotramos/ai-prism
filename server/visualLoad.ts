// The chart inventory of one chat, read for the caller (server/visualInventory.ts builds it).
// Access is the database's: another user's chat reads as "not found".
import { getSession, listMessages, getSessionChartCandidates } from './db.ts'
import { buildVisualInventory } from './visualInventory.ts'
import type { VisualItem } from './visualInventory.ts'

const defaultDeps = { getSession, listMessages, getSessionChartCandidates }
export type VisualLoadDeps = typeof defaultDeps

export async function loadVisualInventory(email: string, token: string | null | undefined, sessionId: string, deps: VisualLoadDeps = defaultDeps): Promise<VisualItem[] | null> {
  const session = await deps.getSession(email, token, sessionId)
  if (!session) return null
  const [history, chartState] = await Promise.all([deps.listMessages(email, token, sessionId), deps.getSessionChartCandidates(email, token, sessionId)])
  return buildVisualInventory({ history, candidates: chartState.items })
}
