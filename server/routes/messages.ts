// Per-message actions outside a turn: switch the active variant, edit a sent
// prompt, persist deck-questions answers.
import { authed } from './authed.ts'
import type { Express, Request, Response } from 'express'
import { addMessage, getMessageRaw, activateVariant, getMessageBlocks, setDeckQuestionsAnswers } from '../db.ts'
import { historyRewriteAccess } from '../db/projects.ts'
import { sanitizeQuestionAnswers } from '../blocks.ts'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'

// In a project chat these rewrite what members already see, so they need manage
// or owner (D4: view reads and posts new turns only); 404 when the chat is not
// visible at all. Personal chats: their creator, as before.
async function refuseHistoryRewrite(req: Request, res: Response, sessionId: string) {
  const access = await historyRewriteAccess(authed(req).email, authed(req).token, sessionId)
  if (!access) {
    res.status(404).json({ error: 'mensagem não encontrada' })
    return true
  }
  if (!access.allowed) {
    res.status(403).json({ error: 'forbidden' })
    return true
  }
  return false
}

export default function registerMessageRoutes(app: Express) {
  // switches which stored variant is "active" for its slot — used when the
  // user browses the version carousel to something other than the latest
  app.patch('/api/messages/:id/activate', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const orig = await getMessageRaw(authed(req).email, authed(req).token, (req.params.id as string))
      if (!orig) return res.status(404).json({ error: 'mensagem não encontrada' })
      if (await refuseHistoryRewrite(req, res, orig.sessionId)) return
      await activateVariant(authed(req).email, authed(req).token, (req.params.id as string))
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // edits a previously-sent user prompt: files a new active variant into the
  // same slot (the original wording stays in the table, just deactivated) —
  // the frontend follows this up with a regenerate of the assistant reply that
  // came after it, so the conversation continues from the corrected wording
  app.post('/api/sessions/:id/messages/:messageId/edit', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const newText = (req.body.content || '').trim()
      if (!newText) return res.status(400).json({ error: 'conteúdo vazio' })

      const orig = await getMessageRaw(authed(req).email, authed(req).token, (req.params.messageId as string))
      if (!orig || orig.sessionId !== (req.params.id as string) || orig.role !== 'user') {
        return res.status(404).json({ error: 'mensagem não encontrada' })
      }
      if (await refuseHistoryRewrite(req, res, orig.sessionId)) return

      // preserve the extracted-attachment tail (if any) — only the visible
      // prompt text is editable, not the files that were attached to it
      const markerIdx = orig.content.indexOf('\n\n--- ANEXOS ---')
      const tail = markerIdx >= 0 ? orig.content.slice(markerIdx) : ''

      const newMsg = await addMessage(authed(req).email, authed(req).token, {
        sessionId: (req.params.id as string),
        role: 'user',
        content: newText + tail,
        attachments: orig.attachments,
        variantGroup: orig.variantGroup,
      })
      res.json({ id: newMsg.id, variantGroup: orig.variantGroup })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Persist the user's answers into a deck-questions block (so the box shows the
  // history on reload and stays editable). The client sends the raw answers map;
  // it's sanitized against the block's own questions server-side. Returns the
  // updated blocks so the client can re-render the filled state.
  app.post('/api/sessions/:id/messages/:messageId/question-answers', auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const messageId = (req.params.messageId as string)
      const orig = await getMessageRaw(authed(req).email, authed(req).token, messageId)
      if (!orig || orig.sessionId !== (req.params.id as string)) {
        return res.status(404).json({ error: 'mensagem não encontrada' })
      }
      if (await refuseHistoryRewrite(req, res, orig.sessionId)) return
      // sanitize the incoming answers against the block's own questions
      const blocksNow = await getMessageBlocks(authed(req).email, authed(req).token, messageId)
      const dq = (blocksNow || []).find((b: { type?: string; questions?: unknown[] } | null) => b && b.type === 'deck-questions')
      if (!dq) return res.status(400).json({ error: 'mensagem não tem bloco de perguntas' })
      const clean = sanitizeQuestionAnswers(req.body?.answers, dq.questions || [])
      const answeredAt = new Date().toISOString()
      const updated = await setDeckQuestionsAnswers(authed(req).email, authed(req).token, messageId, clean || {}, answeredAt)
      res.json({ ok: true, blocks: updated })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
