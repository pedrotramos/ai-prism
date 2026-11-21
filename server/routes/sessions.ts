// Chat sessions: list, semantic search, keep-alive, one session (with its busy
// state), messages, compaction, update and delete.
import { authed } from './authed.ts'
import type { Express } from 'express'
import {
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  listMessages,
  touchDatabase,
  listCompactions,
  searchSessionsByVector,
  listSessionImagePaths,
} from '../db.ts'
import { embed } from '../llm.ts'
import { setUsageSession } from '../usage.ts'
import { deleteImageFile } from '../imageStore.ts'
import { manualCompaction, withCompactionMarkers, CompactionError } from '../compaction.ts'
import { getUserModels, resolveModelId } from '../models.ts'
import { auth } from '../middleware/auth.ts'
import { requireAdmin } from '../middleware/requireAdmin.ts'
import { countEphemeralChats } from '../db/ephemeral.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { backfillUserMessageEmbeddings } from '../lib/embeddings.ts'
import { turnLock } from '../turnLock.ts'
import { historyRewriteAccess } from '../db/projects.ts'
import { logger } from '../log.ts'

export default function registerSessionRoutes(app: Express) {
  app.get('/api/sessions', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      res.json({ sessions: await listSessions(authed(req).email, authed(req).token) })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Temporary chats (W3-6), audit by COUNT only: how many were started. No ids,
  // titles, users or content exist in this path (server/db/ephemeral.js).
  app.get('/api/admin/ephemeral-chats', auth, requireAdmin, async (req, res) => {
    try {
      res.json(await countEphemeralChats(authed(req).email, authed(req).token, { admin: authed(req).isAdmin === true }))
    } catch (e) {
      logger.warn('ephemeral chat count failed', { err: e })
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // semantic search over the user's chat history — pgvector-backed: the ranking
  // runs IN the database over per-message embeddings (indexed HNSW), instead of
  // pulling every session vector into Node for a JS cosine loop. Each session
  // scores by its best-matching message, so a hit on any turn surfaces it.
  app.get('/api/search', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const q = (req.query.q || '').toString().trim()
      if (!q) return res.json({ results: [] })

      // qwen3-embedding is instruction-tuned: queries use an Instruct/Query
      // prefix for asymmetric retrieval; passages (messages) stay plain.
      const qtext = `Instruct: Dada uma busca do usuário, recupere conversas de chat relevantes.\nQuery: ${q}`
      const [qvec] = await embed(authed(req).token, [qtext])
      if (!qvec) return res.json({ results: [] })

      const results = await searchSessionsByVector(authed(req).email, authed(req).token, qvec, { limit: 20, minSimilarity: 0.3 })
      res.json({ results })

      // fire-and-forget: index any history that predates per-message embeddings so
      // subsequent searches cover the full backlog (runs once per user/process)
      backfillUserMessageEmbeddings(authed(req)).catch(() => {})
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Keep-alive for scale to zero: the client pings this while a tab is visible so
  // the Lakebase endpoint stays awake under an active user. Cheap by design: no
  // ensureReady (no DDL), and touchDatabase throttles to one query per few minutes.
  app.get('/api/keepalive', auth, async (req, res) => {
    try {
      const touched = await touchDatabase(authed(req).email, authed(req).token)
      res.json({ ok: true, touched })
    } catch (e) {
      res.status(503).json({ ok: false, error: (e as Error).message })
    }
  })

  // One session the caller can use (her own, or a chat of a project she is a
  // member of: W2-3) plus `busy: { since, by }` while a turn runs on it
  // (server/turnLock.js; `by` = who sent it; a second turn meanwhile gets 409
  // turn_in_flight), else `busy: null`; `role` = the caller's project role (null
  // for a personal chat). 404 for anything else, app admins included.
  app.get('/api/sessions/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const session = await getSession(authed(req).email, authed(req).token, (req.params.id as string))
      if (!session) return res.status(404).json({ error: 'sessão não encontrada' })
      res.json({ session, role: session.role, busy: turnLock.busy(session.id) })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.get('/api/sessions/:id/messages', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const [msgs, compactions] = await Promise.all([
        listMessages(authed(req).email, authed(req).token, (req.params.id as string)),
        listCompactions(authed(req).email, authed(req).token, (req.params.id as string)),
      ])
      // compaction dividers are merged in for display only; the turn routes replay
      // from the compaction anchor (server/compaction.js)
      res.json({ messages: withCompactionMarkers(msgs, compactions) })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Manual conversation compaction: the /compactar command. Folds the thread so far
  // into a summary that stands in for it on later turns (the thread stays visible).
  // 409 `nothing_to_compact` when there is nothing new to fold.
  app.post('/api/sessions/:id/compact', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const sessionId = (req.params.id as string)
      await getUserModels(authed(req))
      const model = resolveModelId(req.body?.model)
      const instructions = String(req.body?.instructions || '').trim().slice(0, 1000)
      // in a project chat a manual compaction changes what every member's next
      // turn replays: manage or owner (W2-3, D4). A chat the caller cannot see
      // keeps the old answer (nothing to compact, below).
      const access = await historyRewriteAccess(authed(req).email, authed(req).token, sessionId)
      if (access && !access.allowed) return res.status(403).json({ error: 'forbidden' })
      const history = await listMessages(authed(req).email, authed(req).token, sessionId)
      // cost ledger (the summary call is attributed to the chat), only once the
      // owner-scoped load proved the session is the caller's (empty = not theirs)
      if (history.length) setUsageSession(sessionId)
      const compaction = await manualCompaction(authed(req), { sessionId, model, history, instructions })
      res.json({ compaction })
    } catch (e) {
      if (e instanceof CompactionError) return res.status(409).json({ error: e.code })
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.patch('/api/sessions/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const fields: Record<string, unknown> = {}
      if (typeof req.body.title === 'string') fields.title = req.body.title
      if (typeof req.body.model === 'string') fields.model = req.body.model
      if (typeof req.body.system_prompt === 'string') fields.system_prompt = req.body.system_prompt
      if (Array.isArray(req.body.enabled_tools)) fields.enabled_tools = req.body.enabled_tools
      await updateSession(authed(req).email, authed(req).token, (req.params.id as string), fields)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.delete('/api/sessions/:id', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      // purge generated-image Volume files before the DB rows cascade away — the
      // chat_images rows go with the session, but the Volume bytes would orphan.
      // Best-effort: a failed file delete never blocks the session delete.
      try {
        const paths = await listSessionImagePaths(authed(req).email, authed(req).token, (req.params.id as string))
        await Promise.all(paths.map((p: string) => deleteImageFile(authed(req).token, p)))
      } catch (e) {
        logger.warn('limpeza de imagens da sessão falhou', { err: e })
      }
      await deleteSession(authed(req).email, authed(req).token, (req.params.id as string))
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
