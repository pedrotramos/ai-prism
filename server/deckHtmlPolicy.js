// PURE-HTML DECK ENGINE (feat/deck-html-engine) — the model writes flowing
// HTML/CSS per slide against the design system, instead of us laying out a tree
// of absolutely-positioned boxes. This kills the "one word per line" defect at
// its root: real HTML flow (flexbox/grid, natural wrapping) never produces it.
// See project_pure_html_deck_engine.
//
// Contract shape a deck-html block:
//   ```prism-block
//   {"type":"deck-html","title":"...","audience":"...","author":"...",
//    "slides":["<section class=\"slide\">…</section>", "<section …>…</section>"]}
//   ```
// Each slide is ONE self-contained <section> that flows. The renderer injects
// the design system's tokens (colors/fonts) so the same @token vocabulary the
// example slides use resolves at paint time — nothing brand-specific is baked.

// Build the design-system STYLE CONTRACT fed to the model: the brand tokens it
// must compose against, plus a couple of the DS's own slides as worked examples
// of the house style. Everything derives from the uploaded DS — zero hardcoded
// brand values, so any company's DS drives the look (feedback_no_ds_overfitting).
export function buildDsStyleContract(template) {
  if (!template) return ''
  const t = template
  const lines = []

  // 1) raw brand tokens (colors + fonts). These are the ONLY concrete values
  // the model may reference; everything else it composes with flowing CSS.
  const tokenLines = []
  if (t.primaryColor) tokenLines.push(`  --primary: ${t.primaryColor};   /* cor primária / texto escuro */`)
  if (t.secondaryColor) tokenLines.push(`  --secondary: ${t.secondaryColor};`)
  if (t.accentColor) tokenLines.push(`  --accent: ${t.accentColor};   /* acento da marca (destaques, ênfase) */`)
  if (t.backgroundColor) tokenLines.push(`  --background: ${t.backgroundColor};   /* fundo padrão do slide */`)
  // named palette tokens carry the FULL brand vocabulary (tints, semantic
  // colors) that the DS's own charts/components use — pass them through so the
  // model can reach for e.g. a success green or a chart tint the DS defines.
  for (const p of (t.palette || []).slice(0, 40)) {
    if (p?.varName && p?.value) tokenLines.push(`  ${p.varName.startsWith('--') ? p.varName : '--' + p.varName}: ${p.value};`)
  }
  const heading = t.headingFont || ''
  const body = t.bodyFont || ''
  if (heading) tokenLines.push(`  --font-heading: ${JSON.stringify(heading)};`)
  if (body) tokenLines.push(`  --font-body: ${JSON.stringify(body)};`)

  lines.push(
    'DESIGN SYSTEM ATIVO — você vai compor os slides na LINGUAGEM VISUAL desta marca. ' +
      'Os tokens abaixo são injetados como CSS custom properties na raiz do documento; ' +
      'use-os via var(--nome). NUNCA escreva hex de cor à mão — sempre var(--accent), ' +
      'var(--primary), etc. Fontes idem: font-family: var(--font-heading)/var(--font-body).'
  )
  if (tokenLines.length) lines.push(':root {\n' + tokenLines.join('\n') + '\n}')

  // 2) brand voice/copy rules (the DS README, condensed at import).
  if (t.brandRules) {
    lines.push(
      'REGRAS DE MARCA (voz, casing, tom — siga na redação):\n---\n' + t.brandRules.slice(0, 4000) + '\n---'
    )
  }

  // 3) worked examples: a few of the DS's OWN slides, verbatim, so the model
  // learns the house component vocabulary (.card/.dv-table/.kpi/…) and the
  // flowing-layout conventions from real specimens rather than from us naming
  // classes it can't see. Pick chart/table/content specimens when present.
  const cards = (t.dsCards || []).filter((c) => c?.html)
  const picked = pickExampleCards(cards)
  if (picked.length) {
    lines.push(
      'SLIDES DE EXEMPLO deste design system (HTML real da marca) — ESTUDE a estrutura, as ' +
        'classes de componente (ex.: .slide/.eyebrow/.title/.card/.dv-table/.kpi/.bullets/.stat), ' +
        'o uso dos tokens e o layout que FLUI. Reproduza este vocabulário; não invente um layout ' +
        'genérico:\n\n' +
        picked.map((c, i) => `--- EXEMPLO ${i + 1}${c.title ? ` (${c.title})` : ''} ---\n${trimExample(c.html)}`).join('\n\n')
    )
  }
  return lines.join('\n\n')
}

// Prefer specimens that teach the most transferable vocabulary: a content
// slide, a chart slide, a table slide. Fall back to the first few cards.
function pickExampleCards(cards) {
  if (!cards.length) return []
  const want = [/content|bullet|text/i, /chart|data.?viz|graph/i, /table/i, /card|kpi|stat/i]
  const chosen = []
  const used = new Set()
  for (const re of want) {
    const hit = cards.find((c, idx) => !used.has(idx) && re.test(`${c.title || ''} ${c.group || ''}`))
    if (hit) {
      chosen.push(hit)
      used.add(cards.indexOf(hit))
    }
    if (chosen.length >= 3) break
  }
  if (!chosen.length) return cards.slice(0, 2)
  return chosen.slice(0, 3)
}

// Example cards can be large (inlined data-URI art). Strip heavy data URIs and
// cap length so the contract stays token-affordable — the model needs the
// STRUCTURE/classes, not embedded rasters.
function trimExample(html, cap = 6000) {
  let out = html
    // drop inlined raster/font data URIs — keep the tag but blank the payload
    .replace(/data:image\/[^)"']{200,}/gi, 'data:image/svg+xml,<removed>')
    .replace(/data:font\/[^)"']+/gi, '')
    // drop <script> (the ds-base runtime) — irrelevant to composition
    .replace(/<script[\s\S]*?<\/script>/gi, '')
  if (out.length > cap) out = out.slice(0, cap) + '\n<!-- …exemplo truncado… -->'
  return out
}

// GERAÇÃO EM DUAS FASES (opção 1 — por slide). Um deck grande não cabe no teto de
// max_tokens de um único turno: gerar o deck inteiro de uma vez trunca no meio, a
// fence fica aberta e o bloco é descartado (mensagem vazia). Para permitir decks
// tão longos quanto o conteúdo pedir, separamos:
//   FASE 1 (este turno de chat): o modelo emite um bloco "deck-outline" COMPACTO —
//           só o conteúdo editorial de cada slide (headline-conclusão, kicker,
//           bullets/dados já escritos, so-what), SEM markup. É pequeno, nunca trunca.
//   FASE 2 (servidor, deckHtmlGenerate.js): cada brief do outline vira UM <section>
//           num call próprio, com folga sob o teto do modelo — e cada slide faz
//           streaming (deck_slide) à medida que fica pronto.
// O DECK_OUTLINE_POLICY descreve a FASE 1 (vai no prompt do turno); o
// SLIDE_MATERIALIZE_POLICY descreve a FASE 2 (usado no prompt de cada slide,
// no servidor — nunca vai para o turno de chat).

// FASE 1 — formato do bloco de PLANEJAMENTO do deck. Injetado no turno de chat
// (buildBlocksInstruction) junto do DECK_POLICY (que traz a qualidade editorial).
export const DECK_OUTLINE_POLICY =
  '\n\n=== GERAÇÃO DE DECK (motor HTML) — O FORMATO DA ETAPA 2 ===\n' +
  'A Etapa 2 acima descreveu o CONTEÚDO e a qualidade editorial do deck; esta seção descreve o ' +
  'FORMATO técnico. O fluxo de perguntas (bloco "deck-questions") continua valendo; ao gerar o ' +
  'deck em si, você emite UM bloco "deck-outline" — um PLANO do deck, um item por slide. Você NÃO ' +
  'escreve HTML aqui: cada slide é depois materializado em HTML/CSS pelo sistema, slide a slide, a ' +
  'partir do seu plano. Escreva TODO o conteúdo de cada slide já pronto e definitivo — quem ' +
  'materializa não terá outro contexto além do que você colocar no brief.\n' +
  'Formato:\n' +
  '```prism-block\n' +
  '{"type":"deck-outline","title":"...","audience":"...(opcional, rodapé)","author":"...(opcional, capa)",' +
  '"slides":[{"kind":"cover|divider|content|cards|kpi|comparison|timeline|chart|architecture|closing",' +
  '"kicker":"...(rótulo curto de categoria, ex.: Business case)","headline":"A CONCLUSÃO do slide em ' +
  'uma frase completa","support":"...(opcional, frase de apoio neutra)","content":"TODO o conteúdo do ' +
  'slide já redigido: os bullets (verbo+consequência, ≤12 palavras), os itens dos cards, os números ' +
  'e rótulos dos KPIs, as linhas da matriz de comparação, as fases da timeline, os pares rótulo→valor ' +
  'do gráfico, o so-what. Detalhado o suficiente para desenhar o slide sem mais contexto.","footnote":' +
  '"...(opcional, nota de honestidade de dados)","notes":"...(opcional, notas do apresentador)"}]}\n' +
  '```\n' +
  'REGRAS DO OUTLINE:\n' +
  '- Um item por slide, na ORDEM do deck, seguindo o arco narrativo e o dimensionamento da Etapa 2 ' +
  '(não comprima um pedido denso em poucos slides).\n' +
  '- "kind" escolhe a FORMA de cada slide pela mensagem dele — VARIE (dois slides de bullets ' +
  'seguidos é composição preguiçosa): capa, divisores entre seções, cards p/ ideias paralelas, ' +
  'faixa de KPIs, matriz de comparação p/ trade-offs, timeline p/ roadmap, diagrama de ' +
  'arquitetura/fluxo p/ "como as peças se conectam", gráfico p/ dados reais, encerramento com ' +
  'call-to-action.\n' +
  '- "headline" é a CONCLUSÃO/tese do slide, nunca um rótulo de assunto ("Vantagens", "Cronograma" ' +
  'são proibidos). "content" carrega o texto final em sentence case.\n' +
  '- Gráficos ("kind":"chart"): inclua em "content" os pares rótulo→valor explícitos. Só use números ' +
  'presentes nesta conversa (pedido, respostas, anexos, resultados de tools); qualquer estimativa ' +
  'ilustrativa vai marcada em "footnote". Nunca invente uma série apresentada como dado real.\n' +
  '- Não escreva HTML, CSS, SVG nem classes de componente no outline — isso é a Fase 2.\n'

// FASE 2 — contrato de materialização de UM slide. Vira o system prompt de cada
// call por slide (deckHtmlGenerate.js), somado ao DS style contract
// (buildDsStyleContract). NÃO é injetado no turno de chat.
export const SLIDE_MATERIALIZE_POLICY =
  'Você é um designer de slides que materializa UM slide de um deck em HTML/CSS que FLUI, ' +
  'seguindo a linguagem visual do design system. Você recebe o PLANO do deck e o brief de UM ' +
  'slide; devolva SOMENTE esse slide como UMA tag <section class="slide">…</section> ' +
  'auto-contida e válida — sem markdown, sem cercas de código, sem comentários, sem outro texto.\n' +
  'REGRAS:\n' +
  '- O <section> FLUI (flexbox/grid, quebra natural de texto). NUNCA use position:absolute nem ' +
  'coordenadas fixas para dispor conteúdo, e NUNCA force largura/altura que corte texto. O slide ' +
  'tem 1280×720 (16:9); componha para caber com folga, deixando o conteúdo respirar. Estilos inline ' +
  'ou uma tag <style> DENTRO do <section> são permitidos; use os tokens var(--…) do design system ' +
  '(cores/fontes), nunca hex de cor cru.\n' +
  '- PRINCÍPIO GERAL DE FIDELIDADE: para QUALQUER ativo do design system (tabela, gráfico, card, ' +
  'kpi, lista, cabeçalho, etc.), use o ativo EXATAMENTE como o design system o define nos SLIDES ' +
  'DE EXEMPLO — reproduza a estrutura, as classes e as propriedades daquele ativo. NÃO invente um ' +
  'estilo próprio, NÃO prescreva você mesmo valores de acabamento (cantos, faixas, grade, eixos, ' +
  'alinhamento, cores) e NÃO sobrescreva as propriedades do ativo: o acabamento é sempre o que o ' +
  'design system determinar. Quando não houver um exemplo daquele ativo no DS, aí sim componha com ' +
  'flexbox/grid respeitando os tokens (var(--…)).\n' +
  '- Gráficos: desenhe SVG inline (barras, linhas, área, pizza) reproduzindo a MESMA linguagem ' +
  'visual dos gráficos dos SLIDES DE EXEMPLO do design system — o acabamento (grade, eixos, ' +
  'rótulos, marcadores, cantos, preenchimentos) é o que o DS mostra nesses exemplos, não algo que ' +
  'você define. Nunca entregue um gráfico mais "cru" do que os exemplos do DS.\n' +
  '- Ativos da marca (logo, ilustrações/motivos): use SEMPRE os assets REAIS do design system via ' +
  '`<img data-ds-logo>` / `<img data-ds-asset-id="ID">`, com os ids listados na seção de ativos — ' +
  'o renderizador injeta a arte real; NUNCA desenhe um logo/motivo próprio em SVG/CSS nem escreva ' +
  '`src="..."` à mão. Motivos decorativos, só com parcimônia (capa/divisor/encerramento), nunca ' +
  'em slides de conteúdo. ÍCONES de item de conteúdo: prefira um ícone do DS cujo rótulo combine ' +
  'DE VERDADE; se nenhum combinar, ou não use ícone, ou desenhe um SVG simples de traço que ' +
  'represente o conceito — mas NUNCA force um ícone de PRODUTO do DS num item sem relação com ' +
  'aquele produto. (SVG inline também é sempre correto para GRÁFICOS de dados.)\n' +
  '- Materialize EXATAMENTE o conteúdo do brief (headline, kicker, bullets, dados, footnote): não ' +
  'invente dados novos nem números fora do brief; mantenha o mesmo idioma do plano. Texto SEMPRE ' +
  'flui e quebra naturalmente; se o conteúdo for muito, distribua no slide, jamais espremer numa ' +
  'caixa estreita.\n'
