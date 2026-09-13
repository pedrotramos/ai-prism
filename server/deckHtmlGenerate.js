// FASE 2 da geração de deck (opção 1 — por slide). Recebe o "deck-outline" que o
// modelo planejou no turno de chat e materializa CADA slide num call próprio, cada
// um com folga sob o teto de max_tokens do modelo. É isto que permite decks tão
// longos quanto o conteúdo pedir: o turno inteiro nunca precisa caber num único
// orçamento de saída (o antigo modo, que truncava e descartava a fence do deck).
//
// Consistência entre slides sem um único call gigante: (1) o DS style contract vai
// em TODO slide (mesma linguagem visual), (2) o slide 0 é gerado primeiro e serve
// de ÂNCORA de estilo para os demais, e (3) cada call recebe o plano completo do
// deck (só as headlines) para saber seu lugar no arco. Os slides 1..N são gerados
// com concorrência limitada e cada um faz streaming (onSlide) assim que fica pronto
// — o cliente posiciona por índice, então a ordem de chegada não importa.
import { completeWithUsage, modelById } from './llm.js'
import { SLIDE_MATERIALIZE_POLICY, buildDsStyleContract } from './deckHtmlPolicy.js'

// Um slide isolado cabe MUITO abaixo disto (o cap de caracteres por slide é 60k ≈
// ~18k tokens); clampado ao teto do modelo p/ nunca 400ar num endpoint menor.
const SLIDE_GEN_MAX_TOKENS = 16384
// Quantos slides materializar em paralelo. Alto o bastante p/ um deck de 20 slides
// não virar 20 esperas em série; baixo o bastante p/ não estourar rate limit do
// endpoint nem inverter demais a ordem de streaming.
const SLIDE_CONCURRENCY = 4

function slideBudget(model) {
  const ceiling = modelById(model)?.maxOut || 8192
  return Math.min(SLIDE_GEN_MAX_TOKENS, ceiling)
}

// Strip any stray code fence and keep only from the first <section>. Returns '' if
// there's no <section> at all (caller falls back to a minimal slide).
function cleanSlideHtml(raw) {
  let s = String(raw || '').replace(/```[a-z]*\n?/gi, '').trim()
  const open = s.search(/<section\b/i)
  if (open < 0) return ''
  s = s.slice(open)
  const close = s.toLowerCase().lastIndexOf('</section>')
  if (close >= 0) s = s.slice(0, close + '</section>'.length)
  return s.trim()
}

// A last-resort slide built directly from the brief, used only when a slide's own
// generation fails or returns no <section> — so a single bad call leaves a plain
// but on-message slide instead of a hole in the deck. Escapes text (no markup
// injected) and leans on the DS tokens the renderer injects at paint time.
function fallbackSlide(brief) {
  const esc = (t) =>
    String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const kicker = brief.kicker ? `<div class="eyebrow" style="text-transform:uppercase;letter-spacing:.08em;color:var(--accent)">${esc(brief.kicker)}</div>` : ''
  const headline = brief.headline ? `<h2 class="title" style="font-family:var(--font-heading);color:var(--primary)">${esc(brief.headline)}</h2>` : ''
  const support = brief.support ? `<p class="support" style="opacity:.8">${esc(brief.support)}</p>` : ''
  const body = brief.content ? `<p style="white-space:pre-wrap">${esc(brief.content)}</p>` : ''
  const footnote = brief.footnote ? `<p class="footnote" style="font-size:.72em;opacity:.6;margin-top:auto">${esc(brief.footnote)}</p>` : ''
  return (
    '<section class="slide" style="display:flex;flex-direction:column;gap:.6em;padding:56px 72px;' +
    'font-family:var(--font-body);color:var(--primary);background:var(--background)">' +
    kicker + headline + support + body + footnote + '</section>'
  )
}

// Compact plan the per-slide calls see for continuity: title + a numbered list of
// every slide's kind + headline. Small (headlines only), so it stays affordable
// even for a long deck.
function planSummary(outline) {
  const lines = outline.slides.map((s, i) => {
    const kind = s.kind ? `[${s.kind}] ` : ''
    return `${i + 1}. ${kind}${(s.headline || s.content || '').slice(0, 160)}`
  })
  const head = [outline.title && `Título do deck: ${outline.title}`, outline.audience && `Público/rodapé: ${outline.audience}`, outline.author && `Autor/capa: ${outline.author}`]
    .filter(Boolean)
    .join('\n')
  return `${head ? head + '\n\n' : ''}Plano do deck (${outline.slides.length} slides):\n${lines.join('\n')}`
}

// The brief for one slide, rendered for the user turn of its generation call.
function briefText(brief, index) {
  const field = (label, v) => (v ? `${label}: ${v}\n` : '')
  return (
    `Materialize o slide ${index + 1} (kind: ${brief.kind || 'content'}).\n` +
    field('Kicker', brief.kicker) +
    field('Headline (título = conclusão do slide)', brief.headline) +
    field('Apoio', brief.support) +
    field('Conteúdo', brief.content) +
    field('Nota de rodapé', brief.footnote)
  ).trim()
}

function buildSlideMessages(outline, brief, index, { dsContract, plan, anchorHtml }) {
  const system =
    (dsContract ? dsContract + '\n\n' : '') +
    SLIDE_MATERIALIZE_POLICY +
    (anchorHtml
      ? '\n\nSLIDE JÁ MATERIALIZADO deste MESMO deck (use como âncora de consistência — mesmas classes, ' +
        'mesma escala tipográfica, mesmo tratamento de cabeçalho/rodapé; NÃO o copie, é outro slide):\n' +
        anchorHtml
      : '')
  const user = `${plan}\n\n---\n${briefText(brief, index)}\n\n<section> do slide ${index + 1}:`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function addUsage(acc, usage) {
  if (!usage) return acc
  acc = acc || {}
  for (const k of Object.keys(usage)) {
    if (typeof usage[k] === 'number') acc[k] = (acc[k] || 0) + usage[k]
  }
  return acc
}

// Generate one slide's HTML. Never throws — on any failure returns a fallback
// slide so the deck keeps its shape.
async function genOneSlide(token, model, outline, index, ctx, maxTokens) {
  const brief = outline.slides[index]
  try {
    const messages = buildSlideMessages(outline, brief, index, ctx)
    const { text, usage } = await completeWithUsage(token, model, messages, { maxTokens, temperature: 0.4 })
    const html = cleanSlideHtml(text)
    return { html: html || fallbackSlide(brief), usage, ok: !!html }
  } catch {
    return { html: fallbackSlide(brief), usage: null, ok: false }
  }
}

/**
 * Materialize a deck-outline into HTML slides, one model call per slide.
 * Streams each finished slide via onSlide(html, index) and the title via
 * onTitle(title). Returns { slides: string[], usage, ok } where `ok` counts how
 * many slides materialized cleanly (vs. fell back). Never throws.
 */
export async function generateDeckFromOutline(token, model, outline, { template, onTitle, onSlide } = {}) {
  const n = outline.slides.length
  const maxTokens = slideBudget(model)
  const dsContract = buildDsStyleContract(template)
  const plan = planSummary(outline)
  const ctxBase = { dsContract, plan }
  onTitle?.(outline.title)

  const slides = new Array(n)
  let usage = null
  let cleanCount = 0
  const record = (i, r) => {
    slides[i] = r.html
    usage = addUsage(usage, r.usage)
    if (r.ok) cleanCount++
    onSlide?.(r.html, i)
  }

  if (!n) return { slides: [], usage: null, ok: 0 }

  // Slide 0 first (sequential): it anchors the visual style for the rest.
  const first = await genOneSlide(token, model, outline, 0, ctxBase, maxTokens)
  record(0, first)
  const anchorHtml = first.ok ? first.html : undefined
  const ctx = { ...ctxBase, anchorHtml }

  // Slides 1..N with bounded concurrency, each anchored to slide 0.
  let next = 1
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= n) return
      record(i, await genOneSlide(token, model, outline, i, ctx, maxTokens))
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(SLIDE_CONCURRENCY, n - 1); w++) workers.push(worker())
  await Promise.all(workers)

  return { slides, usage, ok: cleanCount }
}
