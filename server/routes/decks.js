import { getSelectedDeckTemplate, getDeck, updateDeckSlides } from '../db.js'
import { completeWithUsage } from '../llm.js'
import { setUsageSession, setUsageKind } from '../usage.js'
import { sanitizeHtmlDeck, clientWorkingSlides, parseInlineImages, spliceAttachedImages } from '../blocks.js'
import { buildDsStyleContract } from '../deckHtmlPolicy.js'
import { renderPptxFromOps } from '../decks.js'
import { resolveModelId } from '../models.js'
import { auth } from '../middleware/auth.js'
import { ensureReady } from '../middleware/ensureReady.js'
import { attachImagesToLastUserTurn } from '../turn.js'
import { TWEAK_MAX_TOKENS, imageAttachInstruction, buildTweakChatContext } from '../lib/tweak.js'

export default function registerDeckRoutes(app) {
  // decks the model designs as a `deck` prism-block (server/blocks.js) — edited
  // and exported from the Deck Studio independent of the chat message itself
  app.get('/api/decks/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const deck = await getDeck(req.email, req.token, req.params.id)
      if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
      res.json({ deck })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.patch('/api/decks/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const body = req.body || {}
      // Pure-HTML deck (manual editing path): its slides are <section> HTML
      // strings. sanitizeHtmlDeck preserves inline styles — the whole point of DOM
      // editing — and only strips <script>, so a manual style/text edit round-trips
      // intact. Detected structurally: every slide is a string or a {html} object.
      // meta.format='html' is preserved so reloads keep the format.
      const slides = Array.isArray(body.slides) ? body.slides : []
      const isHtmlDeck =
        slides.length > 0 && slides.every((s) => typeof s === 'string' || (s && typeof s === 'object' && typeof s.html === 'string'))
      if (isHtmlDeck) {
        const sanitized = sanitizeHtmlDeck(body)
        if (!sanitized) return res.status(400).json({ error: 'deck inválido' })
        // carry any per-slide notes the client sent alongside the HTML strings
        // (the client sends bare strings for HTML slides, but keeps notes in
        // parallel {html,notes} objects when present).
        const notesBySlide = slides.map((s) => (s && typeof s === 'object' && typeof s.notes === 'string' ? s.notes : undefined))
        const finalSlides = sanitized.slides.map((html, i) =>
          notesBySlide[i] ? { html, notes: notesBySlide[i] } : html
        )
        const meta = { format: 'html', audience: sanitized.audience, author: sanitized.author }
        await updateDeckSlides(req.email, req.token, req.params.id, sanitized.title, finalSlides, meta)
        // echo the deck exactly as stored (sanitized), the same shape GET returns,
        // so the Studio can fingerprint the server's copy (delete-slide undo)
        return res.json({ ok: true, deck: { id: String(req.params.id), title: sanitized.title, slides: finalSlides, ...meta } })
      }
      // Every deck is pure-HTML now; a payload that isn't is a legacy semantic-tree
      // deck whose editor has been removed.
      return res.status(410).json({ error: 'este deck está num formato antigo que não é mais editável — gere um novo deck' })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/api/decks/:id/tweak', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const deck = await getDeck(req.email, req.token, req.params.id)
      if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
      setUsageKind('tweak') // cost ledger: an AI edit, charged to the deck's chat
      setUsageSession(deck.sessionId)
      const instruction = String(req.body?.instruction || '').trim().slice(0, 2000)
      if (!instruction) return res.status(400).json({ error: 'instrução vazia' })
      const slideIndex = Number.isInteger(req.body?.slideIndex) ? req.body.slideIndex : null
      // Edit from the client's working copy (unsaved manual edits) when provided,
      // else the persisted slides. Ownership/title/meta still come from `deck`.
      const workSlides = clientWorkingSlides(req.body?.slides) || deck.slides
      const scoped = slideIndex != null && workSlides[slideIndex] ? workSlides[slideIndex] : null
      // preview mode: compute the edit but DON'T persist — the Studio shows the
      // result with Accept/Discard, so an AI tweak is reversible before it lands
      const preview = req.body?.preview === true
      const sel = req.body?.selection
      const selection =
        sel && typeof sel.path === 'string'
          ? { path: sel.path.slice(0, 80), label: String(sel.label || '').slice(0, 120), text: String(sel.text || '').slice(0, 400) }
          : null

      const template = await getSelectedDeckTemplate(req.email, req.token)

      // ---- pure-HTML deck tweak (deck-html engine) ----------------------------
      // Slides are <section> HTML strings. The model rewrites HTML → HTML. Scope:
      // the whole deck (slideIndex null), one slide, or a single selected element
      // (sel.htmlOuter carries that node's outerHTML; we splice the reply back into
      // the slide at sel.path). Result is sanitized by sanitizeHtmlDeck and shown
      // as a preview (Accept/Discard) before persisting — same reversible flow.
      const deckIsHtml =
        deck.meta?.format === 'html' || (workSlides.length && workSlides.every((s) => typeof s === 'string' || (s && typeof s === 'object' && typeof s.html === 'string')))
      if (deckIsHtml) {
        const model = resolveModelId(req.body?.model)
        const readHtml = (s) => (typeof s === 'string' ? s : s?.html || '')
        const htmlOuter = typeof sel?.htmlOuter === 'string' ? sel.htmlOuter : null
        // attached images (item 9): each has a vision channel (raster, what the
        // model SEES) and the original bytes (what we splice in if the model
        // inserts it). `visionInput` is only the ones the model can look at.
        const tweakImages = parseInlineImages(req.body?.images)
        const visionInput = tweakImages.filter((im) => im.vision).map((im) => ({ dataUrl: im.vision }))
        const contract =
          'Você é um editor de slides que trabalha em HTML/CSS. Devolva SOMENTE o HTML resultante, ' +
          'sem markdown, sem cercas de código, sem comentários e sem explicação. Preserve a marca e o ' +
          'design system (as variáveis var(--…) e a estrutura existente); nunca use position:absolute para ' +
          'reflowar conteúdo que já flui; nunca invente dados numéricos novos. Mantenha o mesmo idioma.'

        // Grounding for the edit (task #45): (1) the active design system's STYLE
        // CONTRACT — the same token vocabulary + worked examples the generator
        // uses — so an edit stays in the brand's visual language by default; and
        // (2) a digest of the originating chat, so the model knows what the deck
        // is about (the numbers, the audience, the intent). The user can override
        // the DS grounding explicitly in the instruction ("ignore o design system").
        const dsContract = buildDsStyleContract(template)
        const chatDigest = await buildTweakChatContext(req, deck.sessionId).catch(() => '')
        const groundSystem =
          (dsContract ? dsContract + '\n\n' : '') +
          (chatDigest ? 'CONTEXTO DA CONVERSA que originou este deck (use como fonte da verdade p/ tema, dados e intenção; NÃO invente números fora dela):\n---\n' + chatDigest + '\n---\n\n' : '') +
          contract +
          ' APOIE-SE no design system acima (tokens var(--…), classes e composições dos exemplos) para qualquer ajuste visual, A MENOS QUE a instrução peça explicitamente o contrário; e mantenha coerência com o contexto da conversa.' +
          (tweakImages.length ? imageAttachInstruction(tweakImages) : '')
        let messages
        if (htmlOuter && scoped) {
          // element-scoped: give the model the whole <section> AND point at the
          // element to change; ask for the full new <section> back (no server-side
          // DOM splicing — robust, and the model keeps the rest byte-close).
          messages = [
            { role: 'system', content: groundSystem + ' Você recebe o HTML de UM slide (<section>) e o HTML de UM elemento dentro dele que o usuário selecionou. Aplique a instrução SOMENTE a esse elemento e devolva o <section> NOVO completo, mantendo todo o resto inalterado.' },
            { role: 'user', content: `Slide (HTML):\n${readHtml(scoped)}\n\nElemento selecionado (outerHTML):\n${htmlOuter}\n\nInstrução (só p/ o elemento): ${instruction}\n\n<section> novo:` },
          ]
        } else if (scoped) {
          messages = [
            { role: 'system', content: groundSystem + ' Você recebe o HTML de UM slide (<section>…</section>); devolva o <section> NOVO completo.' },
            { role: 'user', content: `Slide (HTML):\n${readHtml(scoped)}\n\nInstrução: ${instruction}\n\n<section> novo:` },
          ]
        } else {
          // whole-deck scope: edit every slide in sequence, one call each, so each
          // <section> stays bounded and coherent (mirrors the streaming generator).
          const outSlides = []
          let totalUsage = null
          for (const s of workSlides) {
            const slideMsgs = [
              { role: 'system', content: groundSystem + ' Você recebe o HTML de UM slide (<section>…</section>) de um deck; devolva o <section> NOVO completo, aplicando a instrução de forma consistente com um deck inteiro.' },
              { role: 'user', content: `Slide (HTML):\n${readHtml(s)}\n\nInstrução (vale p/ o deck todo): ${instruction}\n\n<section> novo:` },
            ]
            attachImagesToLastUserTurn(slideMsgs, visionInput)
            const { text: raw, usage } = await completeWithUsage(req.token, model, slideMsgs, { maxTokens: TWEAK_MAX_TOKENS, temperature: 0.3 })
            const cleaned = spliceAttachedImages(String(raw || '').replace(/```[a-z]*\n?/gi, '').trim(), tweakImages)
            outSlides.push(cleaned && /<section/i.test(cleaned) ? cleaned : readHtml(s))
            // sum token usage across the per-slide calls, tolerating either the
            // OpenAI-style keys (prompt/completion/total) or the anthropic-style
            // ones (input/output) — whichever the gateway returned.
            if (usage) {
              totalUsage = totalUsage || {}
              for (const k of Object.keys(usage)) {
                if (typeof usage[k] === 'number') totalUsage[k] = (totalUsage[k] || 0) + usage[k]
              }
            }
          }
          const san = sanitizeHtmlDeck({ title: deck.title, slides: outSlides })
          if (!san?.slides?.length) return res.status(422).json({ error: 'a edição resultou em um deck inválido' })
          // preserve per-slide notes (from the working copy being edited)
          const merged = san.slides.map((h, i) => {
            const prev = workSlides[i]
            return prev && typeof prev === 'object' && prev.notes ? { html: h, notes: prev.notes } : h
          })
          const updated = { ...deck, slides: merged }
          if (!preview) await updateDeckSlides(req.email, req.token, req.params.id, deck.title, merged, { format: 'html', audience: deck.audience, author: deck.author })
          return res.json({ deck: updated, preview, usage: totalUsage, model })
        }
        attachImagesToLastUserTurn(messages, visionInput)
        const { text: raw, usage } = await completeWithUsage(req.token, model, messages, { maxTokens: TWEAK_MAX_TOKENS, temperature: 0.3 })
        const cleaned = spliceAttachedImages(String(raw || '').replace(/```[a-z]*\n?/gi, '').trim(), tweakImages)
        if (!/<section/i.test(cleaned)) return res.status(422).json({ error: 'a edição não retornou um slide válido' })
        const san = sanitizeHtmlDeck({ title: deck.title, slides: [cleaned] })
        if (!san?.slides?.length) return res.status(422).json({ error: 'a edição resultou em um slide inválido' })
        const slides = [...workSlides]
        const prev = slides[slideIndex]
        slides[slideIndex] = prev && typeof prev === 'object' && prev.notes ? { html: san.slides[0], notes: prev.notes } : san.slides[0]
        const updated = { ...deck, slides }
        if (!preview) await updateDeckSlides(req.email, req.token, req.params.id, deck.title, slides, { format: 'html', audience: deck.audience, author: deck.author })
        return res.json({ deck: updated, preview, usage, model })
      }

      // Every deck is pure-HTML now (handled above); a non-HTML deck is a legacy
      // semantic-tree deck whose editor has been removed.
      return res.status(410).json({ error: 'este deck está num formato antigo que não é mais editável — gere um novo deck' })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Pure-HTML deck export: the client extracts native paint-ops off the rendered
  // DOM (client/lib/domToSlideOps.js) and POSTs them here; we assemble a .pptx of
  // editable shapes (renderPptxFromOps) — mirroring Claude Design's export, never
  // rasterized. Scoped to the deck's owner (getDeck enforces user_email).
  app.post('/api/decks/:id/export-html', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const deck = await getDeck(req.email, req.token, req.params.id)
      if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
      const slides = Array.isArray(req.body?.slides) ? req.body.slides : []
      if (!slides.length) return res.status(400).json({ error: 'sem slides para exportar' })
      // high-fidelity option: embed the design system's font files so the deck
      // renders in the brand face even where the font isn't installed
      const embedFonts = req.body?.embedFonts === true
      const template = embedFonts ? await getSelectedDeckTemplate(req.email, req.token) : null
      const buf = await renderPptxFromOps(deck, slides, { embedFonts, fontAssets: template?.fontAssets || [] })
      const safeName = (deck.title || 'apresentacao').replace(/[^\w-]+/g, '_').slice(0, 60) || 'apresentacao'
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pptx"`)
      res.send(buf)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
