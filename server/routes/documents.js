import { artifactSessionId, getDocument, updateDocument } from '../db.js'
import { completeWithUsage } from '../llm.js'
import { setUsageSession, setUsageKind } from '../usage.ts'
import { sanitizeDocument } from '../blocks.js'
import { renderDocx } from '../docx-export.js'
import { getUserModels, resolveModelId } from '../models.js'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { extractJson } from '../lib/tweak.js'

export default function registerDocumentRoutes(app) {
  // ---- documents (prose sibling of decks/spreadsheets) ----
  app.get('/api/documents/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const document = await getDocument(req.email, req.token, req.params.id)
      if (!document) return res.status(404).json({ error: 'documento não encontrado' })
      res.json({ document })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Studio: persist an edited document (title + markdown), revalidated by the same
  // sanitizer as generation so a hand-edit can't write an empty/oversized doc.
  app.patch('/api/documents/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const existing = await getDocument(req.email, req.token, req.params.id)
      if (!existing) return res.status(404).json({ error: 'documento não encontrado' })
      const sanitized = sanitizeDocument({ type: 'document', title: req.body?.title, markdown: req.body?.markdown })
      if (!sanitized) return res.status(400).json({ error: 'documento inválido' })
      await updateDocument(req.email, req.token, req.params.id, sanitized.title, sanitized.markdown)
      res.json({ document: { id: String(req.params.id), title: sanitized.title, markdown: sanitized.markdown } })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Natural-language "tweak" (mirrors decks/spreadsheets): the Studio sends an
  // instruction (content OR style); the model returns the full revised markdown,
  // revalidated and persisted. Synchronous, non-streaming.
  const DOC_TWEAK_MAX_TOKENS = 32768
  app.post('/api/documents/:id/tweak', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const doc = await getDocument(req.email, req.token, req.params.id)
      if (!doc) return res.status(404).json({ error: 'documento não encontrado' })
      setUsageKind('tweak') // cost ledger: an AI edit, charged to the document's chat
      setUsageSession(await artifactSessionId(req.email, req.token, 'document', req.params.id))
      const instruction = String(req.body?.instruction || '').trim().slice(0, 2000)
      if (!instruction) return res.status(400).json({ error: 'instrução vazia' })
      if ((doc.markdown || '').length > 120_000) {
        return res.status(422).json({ error: 'o documento é grande demais para editar de uma vez' })
      }
      const system =
        'Você edita um DOCUMENTO de texto do AI Prism, escrito em Markdown. Aplique a alteração pedida ' +
        '(de CONTEÚDO e/ou de ESTILO/tom/formatação), preservando o resto do documento e a estrutura ' +
        'markdown (títulos #, listas, tabelas, negrito/itálico, citações). Mantenha (ou melhore) a ' +
        'qualidade e o idioma do texto. Responda APENAS com um objeto JSON ' +
        '{"title":"...","markdown":"..."} — sem cercas de markdown ao redor do JSON e sem comentários.'
      const user = `Documento atual (JSON):\n${JSON.stringify({ title: doc.title, markdown: doc.markdown })}\n\nInstrução: ${instruction}`

      await getUserModels(req)
      const model = resolveModelId(req.body?.model)
      const { text: out, usage: docUsage } = await completeWithUsage(req.token, model, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { maxTokens: DOC_TWEAK_MAX_TOKENS, temperature: 0.3 })

      const parsed = extractJson(out)
      if (parsed == null) return res.status(422).json({ error: 'o modelo não devolveu um JSON válido — tente reformular a instrução' })
      const sanitized = sanitizeDocument({ type: 'document', title: parsed.title || doc.title, markdown: parsed.markdown })
      if (!sanitized) return res.status(422).json({ error: 'a edição resultou em um documento inválido' })
      // Preview mode (mirrors decks/spreadsheets): return the edited document
      // WITHOUT persisting so the Studio can show it with Accept/Discard; the
      // client persists on accept via PATCH /api/documents/:id. Only a plain
      // (non-preview) tweak saves here.
      const preview = req.body?.preview === true
      if (!preview) await updateDocument(req.email, req.token, req.params.id, sanitized.title, sanitized.markdown)
      res.json({ document: { id: String(req.params.id), title: sanitized.title, markdown: sanitized.markdown }, usage: docUsage, model, preview })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Export: DOCX (rendered OOXML) or Markdown (raw). PDF is done client-side
  // (print), so no server route is needed for it.
  app.get('/api/documents/:id/export', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const document = await getDocument(req.email, req.token, req.params.id)
      if (!document) return res.status(404).json({ error: 'documento não encontrado' })
      const fmt = String(req.query.format || 'docx').toLowerCase()
      const safeName = (document.title || 'documento').replace(/[^\w-]+/g, '_').slice(0, 60) || 'documento'
      if (fmt === 'md' || fmt === 'markdown') {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`)
        return res.send(document.markdown || '')
      }
      const buf = await renderDocx(document)
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`)
      res.send(buf)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
