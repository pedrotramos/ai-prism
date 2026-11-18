// Embeddings written on the turn tail and by search: the session-level search
// vector, per-message vectors (history retrieval + pgvector search) and the
// one-time backfill of messages that predate them. All best-effort.
import {
  setSessionEmbedding,
  setMessageEmbedding,
  listMessagesMissingEmbedding,
  listUserMessagesMissingEmbedding,
} from '../db.js'
import { embed } from '../llm.js'
import { logger } from '../log.js'

export function stripAttach(content) {
  const i = content.indexOf('\n\n--- ANEXOS ---')
  return i >= 0 ? content.slice(0, i) : content
}

// Recomputes the session's semantic-search embedding from the user messages
// (topic/intent) — a focused passage beats embedding the verbose full
// transcript, which dilutes the topic. Shared by the send path (and callable
// elsewhere). Throws on failure so the caller decides whether to swallow it.
// `signal` (the turn's): aborts the embed call, and no vector is written after it.
export async function updateSessionEmbedding(req, sessionId, history, { signal } = {}) {
  const doc = history
    .filter((m) => m.role === 'user')
    .map((m) => stripAttach(m.content))
    .join('\n')
    .slice(0, 1500)
  const [vec] = await embed(req.token, [doc], { signal })
  signal?.throwIfAborted()
  if (vec) await setSessionEmbedding(req.email, req.token, sessionId, vec)
}

// Per-message embeddings for semantic history retrieval (HISTORY_RETRIEVAL) and
// for the pgvector-backed session search. Embeds every message in the session
// that doesn't yet have a vector — so it covers this turn's new user+assistant
// rows AND lazily backfills older messages the first time a session is touched
// after this feature ships (no migration job). Attachment bodies are stripped
// so a vector reflects the message's intent, not a pasted document. Best-effort:
// called on the turn tail, never blocks the answer. One batched embed call.
// `signal` as in updateSessionEmbedding.
export async function indexSessionMessages(req, sessionId, { signal } = {}) {
  const missing = await listMessagesMissingEmbedding(req.email, req.token, sessionId)
  if (!missing.length) return
  signal?.throwIfAborted()
  const texts = missing.map((m) => stripAttach(m.content).slice(0, 4000))
  const vecs = await embed(req.token, texts, { signal })
  signal?.throwIfAborted()
  await Promise.all(
    missing.map((m, i) => (vecs[i] ? setMessageEmbedding(req.email, req.token, sessionId, m.id, vecs[i]) : null))
  )
}

// One-time-per-process migration backfill: index the user's un-embedded history
// (capped, newest-first) so pgvector search/retrieval work on conversations that
// predate this feature. Fire-and-forget from /api/search; the latch keeps a
// second search from re-scanning while the first is still running. Batches to
// keep any single embed call bounded.
const historyBackfillDone = new Set()
export async function backfillUserMessageEmbeddings(req) {
  if (historyBackfillDone.has(req.email)) return
  historyBackfillDone.add(req.email)
  try {
    const missing = await listUserMessagesMissingEmbedding(req.email, req.token, 200)
    for (let i = 0; i < missing.length; i += 40) {
      const batch = missing.slice(i, i + 40)
      const vecs = await embed(req.token, batch.map((m) => stripAttach(m.content).slice(0, 4000)))
      await Promise.all(
        batch.map((m, j) => (vecs[j] ? setMessageEmbedding(req.email, req.token, m.sessionId, m.id, vecs[j]) : null))
      )
    }
    if (missing.length) logger.info(`history backfill: indexed ${missing.length} messages`, { email: req.email })
  } catch (e) {
    // let a later search retry by clearing the latch
    historyBackfillDone.delete(req.email)
    logger.warn('history backfill failed', { err: e })
  }
}
