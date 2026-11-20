import { getSelectedDeckTemplate, artifactSessionId, getSpreadsheet, updateSpreadsheet } from '../db.js'
import { completeWithUsage } from '../llm.js'
import { setUsageSession, setUsageKind } from '../usage.ts'
import { sanitizeSpreadsheet, parseInlineImages } from '../blocks.js'
import { renderXlsx } from '../xlsx-export.js'
import { getUserModels, resolveModelId } from '../models.js'
import { auth } from '../middleware/auth.js'
import { ensureReady } from '../middleware/ensureReady.js'
import { attachImagesToLastUserTurn } from '../turn.js'
import { extractJson } from '../lib/tweak.js'

export default function registerSpreadsheetRoutes(app) {
  // ---- spreadsheets (tabular sibling of decks) ----
  app.get('/api/spreadsheets/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const spreadsheet = await getSpreadsheet(req.email, req.token, req.params.id)
      if (!spreadsheet) return res.status(404).json({ error: 'planilha não encontrada' })
      res.json({ spreadsheet })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/spreadsheets/:id/export', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const spreadsheet = await getSpreadsheet(req.email, req.token, req.params.id)
      if (!spreadsheet) return res.status(404).json({ error: 'planilha não encontrada' })
      // the workbook wears the user's selected design system (same as decks)
      const template = await getSelectedDeckTemplate(req.email, req.token)
      const buf = await renderXlsx(spreadsheet, template)
      const safeName = (spreadsheet.title || 'planilha').replace(/[^\w-]+/g, '_').slice(0, 60) || 'planilha'
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`)
      res.send(buf)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Studio: persist a full edited spec (revalidated by the same sanitizer as
  // generation, so a hand-edit can never write a shape the renderer can't lay out).
  app.patch('/api/spreadsheets/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const existing = await getSpreadsheet(req.email, req.token, req.params.id)
      if (!existing) return res.status(404).json({ error: 'planilha não encontrada' })
      const sanitized = sanitizeSpreadsheet({ type: 'spreadsheet', ...(req.body || {}) })
      if (!sanitized) return res.status(400).json({ error: 'planilha inválida' })
      const spec = { title: sanitized.title, sheets: sanitized.sheets }
      if (sanitized.instructions) spec.instructions = sanitized.instructions
      await updateSpreadsheet(req.email, req.token, req.params.id, sanitized.title, spec)
      res.json({ spreadsheet: { id: String(req.params.id), ...spec } })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Natural-language "tweak" (mirrors /api/decks/:id/tweak): the Studio sends an
  // instruction, optionally scoped to one sheet; the model returns the revised
  // spec JSON, revalidated by sanitizeSpreadsheet and persisted. One focused edit,
  // synchronous and non-streaming. Formulas stay position-free (token) refs — the
  // same contract SPREADSHEET_POLICY teaches — so the renderer resolves them.
  const SS_TWEAK_MAX_TOKENS = 16384
  app.post('/api/spreadsheets/:id/tweak', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const ss = await getSpreadsheet(req.email, req.token, req.params.id)
      if (!ss) return res.status(404).json({ error: 'planilha não encontrada' })
      setUsageKind('tweak') // cost ledger: an AI edit, charged to the sheet's chat
      setUsageSession(await artifactSessionId(req.email, req.token, 'spreadsheet', req.params.id))
      const instruction = String(req.body?.instruction || '').trim().slice(0, 2000)
      if (!instruction) return res.status(400).json({ error: 'instrução vazia' })
      const sheetIndex = Number.isInteger(req.body?.sheetIndex) ? req.body.sheetIndex : null
      const scoped = sheetIndex != null && ss.sheets?.[sheetIndex] ? ss.sheets[sheetIndex] : null

      const system =
        (scoped
          ? 'Você edita UMA ABA de uma planilha (workbook) do AI Prism, representada em JSON. O schema é o dos blocos `spreadsheet`: a aba tem "name", "purpose"?, "freeze"?, "blocks" (lista ordenada de title/note/section/spacer/table) e "charts"?.'
          : 'Você edita uma PLANILHA (workbook) inteira do AI Prism, representada em JSON ({"title","instructions"?,"sheets":[...]}, schema dos blocos `spreadsheet`).') +
        ' Aplique SOMENTE a alteração pedida, preservando todo o resto intacto (colunas, roles, formatos, dropdowns, nomes de abas que não precisar mudar). ' +
        'REGRA CRÍTICA DE FÓRMULAS: nunca use referências A1 absolutas (ex.: "=B14-C14"). Use tokens que o app resolve: [@Coluna] (mesma linha), [Aba!Coluna] (coluna inteira de outra aba), [#nome] (célula nomeada). ' +
        'Nunca invente dados numéricos novos — para um template, deixe entradas vazias e fórmulas prontas. ' +
        'Responda APENAS com o JSON atualizado' + (scoped ? ' DESSA aba' : ' do workbook') + ', sem cercas de markdown e sem comentários.'

      const target = scoped || { title: ss.title, instructions: ss.instructions, sheets: ss.sheets }
      const strippedJson = JSON.stringify(target)
      if (strippedJson.length > 60_000) {
        return res.status(422).json({ error: 'a planilha é grande demais para editar de uma vez — edite uma aba por vez' })
      }
      const user = `JSON atual:\n${strippedJson}\n\nInstrução: ${instruction}`

      // reference images (item 9) — spreadsheets use them ONLY as visual reference
      // (no insertion into cells), so the raster vision channel is all we need.
      const visionInput = parseInlineImages(req.body?.images).filter((im) => im.vision).map((im) => ({ dataUrl: im.vision }))
      const systemWithImages = system + (visionInput.length ? ' O usuário anexou imagem(ns) de referência — use-as como guia ao aplicar a instrução.' : '')

      await getUserModels(req)
      const model = resolveModelId(req.body?.model)
      const ssMessages = [
        { role: 'system', content: systemWithImages },
        { role: 'user', content: user },
      ]
      attachImagesToLastUserTurn(ssMessages, visionInput)
      const { text: out, usage: ssUsage } = await completeWithUsage(req.token, model, ssMessages, { maxTokens: SS_TWEAK_MAX_TOKENS, temperature: 0.2 })

      const parsed = extractJson(out)
      if (parsed == null) return res.status(422).json({ error: 'o modelo não devolveu um JSON válido — tente reformular a instrução' })

      let nextSpec
      if (scoped) {
        const sheets = [...ss.sheets]
        sheets[sheetIndex] = parsed
        nextSpec = { type: 'spreadsheet', title: ss.title, instructions: ss.instructions, sheets }
      } else {
        nextSpec = { type: 'spreadsheet', ...parsed }
      }
      const revalidated = sanitizeSpreadsheet(nextSpec)
      if (!revalidated) return res.status(422).json({ error: 'a edição resultou em uma planilha inválida' })
      const spec = { title: revalidated.title, sheets: revalidated.sheets }
      if (revalidated.instructions) spec.instructions = revalidated.instructions
      // Preview mode (mirrors decks): return the edited spec WITHOUT persisting so
      // the Studio can show it with Accept/Discard; the client persists on accept
      // via PATCH /api/spreadsheets/:id. Only a plain (non-preview) tweak saves here.
      const preview = req.body?.preview === true
      if (!preview) await updateSpreadsheet(req.email, req.token, req.params.id, revalidated.title, spec)
      res.json({ spreadsheet: { id: String(req.params.id), ...spec }, usage: ssUsage, model, preview })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
