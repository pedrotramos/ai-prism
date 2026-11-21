import { getSelectedDeckTemplate, getDeck, updateDeckSlides, claimDeckTweak, releaseDeckTweak } from '../db.js'
import { completeWithUsage } from '../llm.ts'
import { setUsageSession, setUsageKind } from '../usage.ts'
import { sanitizeHtmlDeck, clientWorkingSlides, parseInlineImages, spliceAttachedImages } from '../blocks.ts'
import { buildDsStyleContract } from '../deckHtmlPolicy.ts'
import { renderPptxFromOps } from '../decks.ts'
import { resolveModelId } from '../models.ts'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { attachImagesToLastUserTurn } from '../turn.ts'
import { logger } from '../log.ts'
import { refuseReadOnly } from '../lib/artifactReadOnly.ts'
import { readBaseRevision, refuseBadRevision, sendDeckBusy, sendDeckConflict, warnMissingBase } from '../lib/deckRevision.ts'
import { TWEAK_MAX_TOKENS, imageAttachInstruction, buildTweakChatContext } from '../lib/tweak.ts'

// ---- input budgets (W2-16) ---------------------------------------------------
// What the deck studio may send, checked on every write path that carries it
// (save and AI edit) BEFORE the deck is read, written or sent to a model:
//   - a speaker note: at most 9 MiB, counted in UTF-8 bytes (what it weighs in
//     the JSON body and in Postgres), per slide;
//   - attachments of an AI edit: at most 4, each at most 6 MiB DECODED (the
//     file the user picked, not its base64 data: URL, which is 4/3 bigger). An
//     SVG also sends a raster copy for the model to see; both count.
// Above a budget the answer is 413 with `code` and `limit` (plus the 1-based
// `slide` or `image`), so the client shows its own localized copy; `error` is
// the pt-BR fallback. Nothing is dropped silently. The client mirrors these
// numbers (client/src/components/deck/deckInputBudgets.js) to refuse early.
// The studioMedia body class (middleware/security.ts) is derived from them.
export const DECK_NOTE_MAX_BYTES = 9 * 1024 * 1024 // 9437184
export const DECK_IMAGE_MAX_BYTES = 6 * 1024 * 1024 // 6291456
export const DECK_MAX_IMAGES = 4

/** Decoded size of a data: URL (base64 → bytes; any other payload → its UTF-8 length). */
function dataUrlBytes(url) {
  if (typeof url !== 'string') return 0
  const comma = url.indexOf(',')
  if (comma < 0) return Buffer.byteLength(url)
  const payload = url.slice(comma + 1)
  if (!/;base64$/i.test(url.slice(0, comma))) return Buffer.byteLength(payload)
  const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - pad
}

const attachmentBytes = (im) => {
  const original = typeof im === 'string' ? im : im?.dataUrl
  const vision = typeof im === 'object' && im?.visionUrl !== original ? im?.visionUrl : null
  return dataUrlBytes(original) + dataUrlBytes(vision)
}

/**
 * The first budget a deck write breaks, or null. `slides` as the client sends
 * them (string | {html, notes}), `images` the AI edit's attachments.
 */
export function deckInputBudgetViolation({ slides, images } = {}) {
  if (Array.isArray(slides)) {
    for (let i = 0; i < slides.length; i++) {
      const notes = slides[i]?.notes
      // a UTF-16 unit is at most 3 UTF-8 bytes: only a long note needs counting
      if (typeof notes === 'string' && notes.length * 3 > DECK_NOTE_MAX_BYTES && Buffer.byteLength(notes) > DECK_NOTE_MAX_BYTES) {
        return { code: 'deck_note_too_large', limit: DECK_NOTE_MAX_BYTES, slide: i + 1, error: `a nota do apresentador do slide ${i + 1} passa do limite de 9 MiB` }
      }
    }
  }
  if (Array.isArray(images)) {
    if (images.length > DECK_MAX_IMAGES) {
      // `image` is the first attachment past the limit (1-based), like `slide`
      return { code: 'deck_too_many_images', limit: DECK_MAX_IMAGES, image: DECK_MAX_IMAGES + 1, error: `no máximo ${DECK_MAX_IMAGES} imagens por edição com IA` }
    }
    for (let i = 0; i < images.length; i++) {
      if (attachmentBytes(images[i]) > DECK_IMAGE_MAX_BYTES) {
        return { code: 'deck_image_too_large', limit: DECK_IMAGE_MAX_BYTES, image: i + 1, error: `a imagem ${i + 1} passa do limite de 6 MiB` }
      }
    }
  }
  return null
}

const rejectOverBudget = (res, body) => {
  const v = deckInputBudgetViolation(body)
  if (!v) return false
  res.status(413).json(v)
  return true
}

// The write matched no row: someone saved while the model was working (the only way past the
// check at the top of the route), or the deck vanished. Same 409 as a stale save.
async function conflictAfterTweak(res, req, base, fenced = false) {
  const now = await getDeck(req.email, req.token, req.params.id)
  if (!now) return res.status(404).json({ error: 'deck não encontrado' })
  if (base != null && now.revision !== base) return sendDeckConflict(res, now)
  // same revision, yet the write matched nothing: the lease was no longer ours (it lapsed during a
  // slow model call and a successor holds the deck). Nothing of the deck is sent.
  if (fenced) return sendDeckBusy(res)
  return res.status(404).json({ error: 'deck não encontrado' })
}

// The caller lost access to the deck while a write of theirs was in flight (a project member removed
// or leaving mid-model): the database refuses the write under RLS (42501). That is an access loss like
// any other, so it answers 404 with no deck and no database detail, never a 500. It is logged once,
// without identity; a lease the caller still holds cannot be released by someone who can no longer
// see the row, so it is left to expire on its own (120 s).
const isAccessLost = (e) => e?.code === '42501' || /row-level security/i.test(String(e?.message || ''))
function sendAccessLost(res, route) {
  logger.warn(`deck_access_lost: ${route}: the caller lost access to the deck while an edit was in flight; any held lease is left to expire`)
  return res.status(404).json({ error: 'not_found', code: 'not_found' })
}
// Gives a lease back; a caller who lost access simply cannot (nothing to report, the lease expires).
async function releaseLease(req, claim) {
  try {
    await releaseDeckTweak(req.email, req.token, req.params.id, claim)
  } catch (e) {
    if (!isAccessLost(e)) logger.warn('deck tweak lease release failed', { err: e })
  }
}

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
      const body = req.body || {}
      if (rejectOverBudget(res, { slides: body.slides })) return
      await ensureReady(req)
      // a member of the shared chat reads and exports, never saves (N1b)
      const current = await getDeck(req.email, req.token, req.params.id)
      if (refuseReadOnly(res, current)) return
      // optimistic concurrency (N6): the save names the revision it was based on
      const rev = readBaseRevision(req)
      if (refuseBadRevision(res, rev)) return
      if (rev.base == null) warnMissingBase('PATCH /api/decks/:id')
      // a stranger's (or unknown) deck is a plain 404: a conflict never describes a deck the caller cannot read
      if (rev.base != null && !current) return res.status(404).json({ error: 'deck não encontrado' })
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
        const saved = await updateDeckSlides(req.email, req.token, req.params.id, sanitized.title, finalSlides, meta, rev.base)
        if (!saved) {
          // no row matched: the deck moved on since the client read it (or vanished)
          const now = await getDeck(req.email, req.token, req.params.id)
          if (now && rev.base != null) return sendDeckConflict(res, now)
          // the deck is gone (retention sweep, deleted chat) or never was the caller's: a save
          // that matched no row is a 404 with or without a base revision (N7-15)
          if (!now) return res.status(404).json({ error: 'deck não encontrado' })
          if (rev.base != null) return res.status(404).json({ error: 'deck não encontrado' })
          return res.json({ ok: true, deck: { id: String(req.params.id), title: sanitized.title, slides: finalSlides, ...meta } })
        }
        // echo the deck exactly as stored (sanitized), the same shape GET returns,
        // so the Studio can fingerprint the server's copy (delete-slide undo)
        return res.json({ ok: true, deck: { id: String(req.params.id), title: sanitized.title, slides: finalSlides, ...meta, revision: saved.revision } })
      }
      // Every deck is pure-HTML now; a payload that isn't is a legacy semantic-tree
      // deck whose editor has been removed.
      return res.status(410).json({ error: 'este deck está num formato antigo que não é mais editável — gere um novo deck' })
    } catch (e) {
      if (isAccessLost(e)) return sendAccessLost(res, 'PATCH /api/decks/:id')
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/api/decks/:id/tweak', auth, async (req, res) => {
    // the AI-edit lease this request holds (N6), until its write clears it or the finally gives it back
    let held = null
    // ...and it is given back BEFORE any answer that did not write goes out, so a client that retries
    // the moment it sees an error never meets its own stale lease
    const sendJson = res.json.bind(res)
    res.json = (body) => {
      if (!held) return sendJson(body)
      const lease = held
      held = null
      releaseLease(req, lease.claim).finally(() => sendJson(body))
      return res
    }
    try {
      if (rejectOverBudget(res, { slides: req.body?.slides, images: req.body?.images })) return
      await ensureReady(req)
      const deck = await getDeck(req.email, req.token, req.params.id)
      if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
      if (refuseReadOnly(res, deck)) return // before any model call: a reader never spends the chat's budget
      // a tweak based on a deck that has moved on conflicts before the model is called (N6)
      const rev = readBaseRevision(req)
      if (refuseBadRevision(res, rev)) return
      if (rev.base == null) warnMissingBase('POST /api/decks/:id/tweak')
      else if (rev.base !== deck.revision) return sendDeckConflict(res, deck)
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

      // A write that will happen takes the deck's lease BEFORE the model is called, so a second
      // simultaneous edit from the same base is refused here, spending nothing. (A preview writes
      // nothing and needs no lease; it only had to agree with the base above.)
      if (!preview) {
        const got = await claimDeckTweak(req.email, req.token, req.params.id, rev.base)
        if (!got) {
          const now = await getDeck(req.email, req.token, req.params.id)
          if (!now) return res.status(404).json({ error: 'deck não encontrado' })
          if (rev.base != null && now.revision !== rev.base) return sendDeckConflict(res, now)
          return sendDeckBusy(res)
        }
        held = got
      }
      // the final write must still find the revision the lease was taken at (a save in between wins)
      const writeBase = held ? held.revision : rev.base

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
          if (!preview) {
            const saved = await updateDeckSlides(req.email, req.token, req.params.id, deck.title, merged, { format: 'html', audience: deck.audience, author: deck.author }, writeBase, held?.claim ?? null)
            if (!saved) return conflictAfterTweak(res, req, writeBase, held != null)
            held = null // the write cleared the lease
            updated.revision = saved.revision
          }
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
        if (!preview) {
          const saved = await updateDeckSlides(req.email, req.token, req.params.id, deck.title, slides, { format: 'html', audience: deck.audience, author: deck.author }, writeBase, held?.claim ?? null)
          if (!saved) return conflictAfterTweak(res, req, writeBase, held != null)
          held = null // the write cleared the lease
          updated.revision = saved.revision
        }
        return res.json({ deck: updated, preview, usage, model })
      }

      // Every deck is pure-HTML now (handled above); a non-HTML deck is a legacy
      // semantic-tree deck whose editor has been removed.
      return res.status(410).json({ error: 'este deck está num formato antigo que não é mais editável — gere um novo deck' })
    } catch (e) {
      if (isAccessLost(e)) return sendAccessLost(res, 'POST /api/decks/:id/tweak')
      res.status(500).json({ error: e.message })
    } finally {
      // a way out that sent no answer through res.json (the response already ended): still give the lease back
      if (held) await releaseLease(req, held.claim)
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
