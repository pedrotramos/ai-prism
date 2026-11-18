// The answer of a chat turn, written in ONE transaction (W2-14).
//
// Order inside the transaction: the session's chart candidates, the artifact
// rows (deck / spreadsheet / document) in block order, the assistant message,
// its tool trace, then the cancel check. withTx commits when the callback
// returns, so a cancel observed before COMMIT rolls back everything the turn
// produced, and a database error on any statement leaves no orphan artifact row.
// The prompt is not written here: it is the turn's input, committed by the route
// before the model runs (a cancelled turn keeps it; /continue answers it).
//
// Invariants (withTx may run the callback TWICE, see server/db/pool.js):
//   - pure on its inputs: the artifact ids are stamped onto a copy of `blocks`,
//     which is what the message stores and what is returned; the caller's
//     `blocks` is never mutated;
//   - database statements only: no gateway call, no SSE send, no usage flush;
//   - the cancel error is the signal's own reason (an AbortError), never
//     wrapped: spErrorAction matches on message text, and a wrapped message
//     carrying e.g. ETIMEDOUT would demote the service principal;
//   - the message is the assistant's.
import { withTx } from './pool.js'
import {
  insertOwnedDeck,
  insertOwnedDocument,
  insertOwnedMessage,
  insertOwnedSpreadsheet,
  insertOwnedToolCalls,
  updateOwnedChartCandidates,
} from '../ownerScopedWrites.js'

// The blocks that need a row of their own (so their Studio can reload, edit and
// export them independent of the message), and the id each gets stamped with.
async function insertArtifact(c, userEmail, sessionId, b) {
  if (b.type === 'deck-html') {
    // pure-HTML deck: slides is an array of self-contained <section> strings;
    // meta.format='html' marks the format on reload (the Studio render path)
    const meta = { audience: b.audience, author: b.author, format: 'html' }
    return { deckId: await insertOwnedDeck(c, userEmail, sessionId, b.title, b.slides, meta) }
  }
  if (b.type === 'spreadsheet') {
    // the whole spec (title + sheets), so the export route can render the .xlsx
    const spec = { title: b.title, sheets: b.sheets }
    return { spreadsheetId: await insertOwnedSpreadsheet(c, userEmail, sessionId, b.title, spec) }
  }
  if (b.type === 'document') {
    return { documentId: await insertOwnedDocument(c, userEmail, sessionId, b.title, b.markdown) }
  }
  return null
}

/**
 * Writes the answer of a turn as one unit of work.
 *
 * @param {string} userEmail
 * @param {string} userToken
 * @param {{ sessionId: string|number, chartState?: { nextId: number, items: unknown[] } | null,
 *           blocks?: Array<Record<string, any>>, message: Record<string, any>,
 *           toolTrace?: unknown[] }} answer
 *   `message` is insertOwnedMessage's input without sessionId and blocks (content,
 *   reasoning, model, token counts, variantGroup, mediaProcessing, intentClassify).
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ id: string, created_at: Date, blocks: Array<Record<string, any>> }>}
 *   the message row and the blocks as stored (with their artifact ids). Rejects
 *   with the signal's own reason when it aborts before COMMIT (nothing is written).
 */
export async function commitTurnAnswer(userEmail, userToken, answer, { signal } = {}) {
  const { sessionId, chartState, blocks = [], message, toolTrace = [] } = answer
  if (message?.role != null && message.role !== 'assistant') {
    throw new TypeError(`commitTurnAnswer writes the assistant's answer, not a ${message.role} message`)
  }
  // already cancelled: do not even take a connection
  signal?.throwIfAborted()
  return withTx(userEmail, userToken, async (c) => {
    // a fresh copy on every run of the callback (withTx may rerun it)
    const stored = blocks.map((b) => ({ ...b }))
    if (chartState) await updateOwnedChartCandidates(c, userEmail, sessionId, chartState)
    for (const b of stored) {
      const ids = await insertArtifact(c, userEmail, sessionId, b)
      if (ids) Object.assign(b, ids)
    }
    const row = await insertOwnedMessage(c, userEmail, {
      ...message,
      sessionId,
      role: 'assistant',
      blocks: stored.length ? stored : null,
    })
    if (toolTrace.length) await insertOwnedToolCalls(c, userEmail, row.id, toolTrace)
    // the last check before COMMIT: a cancel observed up to here rolls it all back
    signal?.throwIfAborted()
    return { id: row.id, created_at: row.created_at, blocks: stored }
  })
}
