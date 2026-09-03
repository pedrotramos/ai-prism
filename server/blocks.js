import { buildDsStyleContract, DECK_HTML_POLICY } from './deckHtmlPolicy.js'
// Tool nativa de busca desativada nesse primeiro momento (busca via MCP externo).
// Import mantido comentado para reativação junto com o ramo nativo em groundingDirective:
// import { webSearchConfigured } from './web.js'

// Structured message blocks: charts/tables/insights woven directly into the
// model's markdown answer. The model marks *where* a block belongs with an
// inline ```prism-block fence (one per block, right after the paragraph it
// illustrates); the backend resolves it, replaces the fence with a
// `{{block:N}}` placeholder the frontend renders in place, and stores the
// resolved block in a parallel `blocks` array. Chart/table data always comes
// from deterministic candidates (see analysis.js), never invented by the model.
// Opener of a prism-block fence. We deliberately DON'T match the closing ``` in
// this regex: a block's JSON body can itself contain ``` (a `document`'s markdown
// may embed fenced code, an insight may quote code), and a lazy `...```/ closes
// on that inner fence, truncating the JSON so it fails to parse and the raw
// escaped JSON leaks into the chat. Instead we locate the opener, then scan the
// JSON object by brace balance (see scanJsonObject), which is ``` -agnostic.
const FENCE_OPEN_RE = /```prism-block[ \t]*\r?\n?/g
const MAX_BLOCKS = 12

// From `text` starting at `start` (which must be at/near the JSON), find the
// first `{` and return { json, end } where `json` is the balanced object string
// and `end` is the index just past its closing `}`. Brace counting respects
// string literals and escapes so braces inside strings don't miscount. Returns
// null if no balanced object is found (truncated / malformed).
function scanJsonObject(text, start) {
  let i = start
  while (i < text.length && text[i] !== '{') {
    // only whitespace may precede the object; anything else means no block here
    if (!/\s/.test(text[i])) return null
    i++
  }
  if (i >= text.length) return null
  const objStart = i
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { json: text.slice(objStart, i + 1), end: i + 1 }
    }
  }
  return null // never balanced — truncated mid-generation
}

const ALLOWED_TYPES = new Set(['chart', 'table', 'insight', 'deck-html', 'deck-questions', 'spreadsheet', 'image', 'document'])

// Pure-HTML deck engine (feat/deck-html-engine): a deck whose slides are
// self-contained flowing <section> HTML strings, not a semantic tree. Caps keep
// one block bounded; the light sanitizer only enforces shape + strips scripts
// (the iframe renders sandboxed, but defense-in-depth: no <script> persists).
const MAX_HTML_DECK_SLIDES = 40
const MAX_HTML_SLIDE_CHARS = 60_000
export function sanitizeHtmlDeck(raw) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim() || !Array.isArray(raw.slides)) return null
  const slides = raw.slides
    .slice(0, MAX_HTML_DECK_SLIDES)
    .map((s) => {
      let html = typeof s === 'string' ? s : typeof s?.html === 'string' ? s.html : ''
      if (!html.trim()) return null
      // strip <script> — sandboxed iframe already blocks execution, but we
      // never persist executable markup regardless.
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      if (html.length > MAX_HTML_SLIDE_CHARS) html = html.slice(0, MAX_HTML_SLIDE_CHARS)
      return html
    })
    .filter(Boolean)
  if (!slides.length) return null
  return {
    title: raw.title.trim().slice(0, 200),
    audience: typeof raw.audience === 'string' ? raw.audience.slice(0, 200) : undefined,
    author: typeof raw.author === 'string' ? raw.author.slice(0, 200) : undefined,
    slides,
  }
}


// AI edits must run against what the user is LOOKING AT, not the last-saved
// copy: the Studio does commit-based editing, so a deck can carry manual edits
// (moved elements, replaced images, undo/redo) that haven't been PATCHed yet.
// The client sends its in-memory `slides`; we validate them into the same shape
// getDeck returns (string | {html, notes}) and edit from those. Ownership,
// title and meta still come from the DB deck — the body only supplies content.
// Returns null (→ caller falls back to the persisted slides) when the payload
// is absent or unusable, so a malformed body can never wipe the deck.
export function clientWorkingSlides(rawSlides) {
  if (!Array.isArray(rawSlides) || !rawSlides.length) return null
  const out = []
  for (const s of rawSlides.slice(0, MAX_HTML_DECK_SLIDES)) {
    const html = typeof s === 'string' ? s : typeof s?.html === 'string' ? s.html : null
    if (typeof html !== 'string' || !html.trim() || !/<section/i.test(html)) return null
    const capped = html.length > MAX_HTML_SLIDE_CHARS ? html.slice(0, MAX_HTML_SLIDE_CHARS) : html
    const notes = s && typeof s === 'object' && typeof s.notes === 'string' ? s.notes : undefined
    out.push(notes ? { html: capped, notes } : capped)
  }
  return out.length ? out : null
}

// Validate image attachments sent inline in a JSON body (the deck/spreadsheet
// tweak endpoints are plain JSON, not multipart). Each attachment carries two
// channels (see usePromptImages):
//   • dataUrl   — the ORIGINAL bytes (may be SVG). Used to INSERT the image as
//                 a real <img> asset into the slide (kept vector for SVG).
//   • visionUrl — a RASTER data URL the MODEL can see. The gateway vision API
//                 rejects SVG, so `vision` is always raster; if a caller sends
//                 only `dataUrl` and it's raster, that doubles as the vision URL.
// Returns [{ index, dataUrl, vision, isSvg }] (1-based index for `data-attach`).
// Caps count and per-image size so a body can't blow up the model request.
// Never throws. An attachment whose vision channel is SVG/absent is dropped from
// the vision list (a bad URL would 400 the whole model request), but its
// original may still be inserted.
const MAX_TWEAK_IMAGES = 4
const MAX_TWEAK_IMAGE_CHARS = 9_000_000 // ~6.7MB decoded — matches the client cap
const IMG_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i
const SVG_DATA_URL_RE = /^data:image\/svg\+xml/i
export function parseInlineImages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const im of raw.slice(0, MAX_TWEAK_IMAGES)) {
    const original = typeof im === 'string' ? im : typeof im?.dataUrl === 'string' ? im.dataUrl : null
    if (!original || !IMG_DATA_URL_RE.test(original) || original.length > MAX_TWEAK_IMAGE_CHARS) continue
    // vision channel: explicit visionUrl, else the original when it's raster
    let vision = typeof im?.visionUrl === 'string' && IMG_DATA_URL_RE.test(im.visionUrl) ? im.visionUrl : original
    if (SVG_DATA_URL_RE.test(vision) || vision.length > MAX_TWEAK_IMAGE_CHARS) vision = null // vision API is raster-only
    out.push({ index: out.length + 1, dataUrl: original, vision, isSvg: SVG_DATA_URL_RE.test(original) })
  }
  return out
}

// Given the model's returned slide HTML and the attachments, splice each real
// attachment in wherever the model placed a `<img data-attach="N" ...>` marker
// (N is 1-based, matching parseInlineImages' `index`). The model decides IF and
// WHERE to insert and picks the styling; we only swap the marker's `src` for the
// real (possibly SVG, kept vector) data URL. Markers with no matching attachment
// are dropped so a stray one never renders a broken image. Returns the HTML with
// markers resolved. Pure string op — safe on any HTML.
export function spliceAttachedImages(html, attachments) {
  if (typeof html !== 'string' || !html || !attachments?.length) return html || ''
  const byIndex = new Map(attachments.map((a) => [String(a.index), a.dataUrl]))
  return html.replace(/<img\b([^>]*?)\bdata-attach="(\d+)"([^>]*?)>/gi, (m, pre, n, post) => {
    const url = byIndex.get(String(n))
    if (!url) return '' // no such attachment — drop the marker
    const attrs = (pre + post).replace(/\bsrc="[^"]*"/i, '').replace(/\s+/g, ' ').trim()
    return `<img ${attrs} src="${url}">`
  })
}

const DECK_QUESTION_TYPES = new Set(['single', 'multi', 'text'])
const MAX_DECK_QUESTIONS = 8
const MAX_QUESTION_OPTIONS = 8

// Presentations the model designs directly (no external data source involved,
// unlike chart/table blocks, except the optional `chart` layout below which
// deliberately reuses the same trusted candidate pipeline as the chat's own
// `chart` block) — a structured slide spec the Deck Studio renders and lets
// the user edit before exporting to .pptx (see server/decks.js).
//
// Two-step flow (mirrors Claude's own "artifact" UX, which is the explicit
// product reference for this feature): a new deck request first gets a
// `deck-questions` block, never the `deck` block directly — the questions
// must be authored fresh for that specific request/conversation, never a
// reused fixed questionnaire (see the "ETAPA 1" section below).
const DECK_POLICY =
  '\n\nCriação de apresentações (decks): esta interface NÃO executa código — nunca gere ' +
  'python-pptx, HTML, Markdown de slides ou qualquer outro código como forma de "criar" um ' +
  'deck; o usuário não veria nada executável. Um deck é sempre um bloco ```prism-block```.\n\n' +

  '=== QUANDO ENTRAR NESSE FLUXO ===\n' +
  'Só entre em modo deck (perguntas OU geração) quando o usuário pedir EXPLICITAMENTE uma ' +
  'apresentação, slides ou um deck. Nunca sugira ou gere um deck por iniciativa própria — um ' +
  'resumo, relatório, lista ou explicação comum NUNCA vira um deck, mesmo que o conteúdo ' +
  '"renderizasse bem" como slides. Se já existe um deck criado nesta conversa e o usuário pede ' +
  'um ajuste nele (mudar um slide, trocar o tom, adicionar/remover uma seção), gere direto um ' +
  'novo bloco `deck` atualizado — não repita o fluxo de perguntas, que é só para o pedido ' +
  'inicial de um deck novo.\n\n' +

  '=== ETAPA 1: PERGUNTAS DE CONTEXTO (bloco `deck-questions`) ===\n' +
  'Ao receber um pedido NOVO de deck sem contexto suficiente (a maioria dos casos), responda ' +
  'SOMENTE com um bloco `deck-questions` — nunca texto solto, nunca o bloco `deck` ainda:\n' +
  '```prism-block\n{"type":"deck-questions","intro":"...","questions":[' +
  '{"id":"...","label":"...","type":"single|multi|text","description":"...(opcional)",' +
  '"options":["...","...","Decida por mim"]}]}\n```\n' +
  '("options" só é usado/obrigatório para "single"/"multi"; "text" é resposta livre.)\n' +
  'Formule de 4 a 8 perguntas ESPECÍFICAS para este pedido e para o histórico desta conversa — ' +
  'você já enxerga tudo que foi dito, anexado ou calculado até aqui, use isso para perguntar só ' +
  'o que falta. NUNCA reutilize literalmente o mesmo conjunto de perguntas, rótulos ou opções ' +
  'de um pedido para outro: um pitch comercial, uma aula técnica e um relatório de status pedem ' +
  'perguntas completamente diferentes. As categorias a seguir são inspiração de cobertura, não ' +
  'um checklist fixo — use só as que fizerem sentido, com sua própria formulação e opções: ' +
  'público-alvo, duração/nº de slides, contexto do tema/empresa/projeto (SEMPRE tente capturar ' +
  'o nome do cliente/empresa-alvo — ele personaliza a capa e o rodapé de todos os slides), ' +
  'objetivos a destacar, seções a incluir, dados de negócio já disponíveis (custos, prazos, ' +
  'métricas), nível de detalhe técnico, idioma, tom, quem apresenta e para quem. Toda pergunta ' +
  '"single"/"multi" ' +
  'deve sempre incluir "Decida por mim" como última opção. A interface SEMPRE exibe, sob cada ' +
  'pergunta "single"/"multi", um campo livre "Outros" onde o usuário digita uma opção própria — ' +
  'nunca inclua uma opção literal "Outro"/"Outros" na lista, e trate qualquer resposta fora das ' +
  'opções oferecidas como escolha válida do usuário. Se o próprio pedido inicial já vier ' +
  'com contexto suficiente (ex.: um briefing completo colado), pule direto para a Etapa 2.\n\n' +

  '=== ETAPA 2: GERAÇÃO DO DECK ===\n' +
  'Depois que o usuário responder (a mensagem seguinte trará as respostas, tipicamente como ' +
  '"Perguntas respondidas: ..."), gere o deck completo usando essas respostas para moldar ' +
  'seções, tom, idioma e número de slides. O FORMATO técnico do deck (o bloco a emitir e as ' +
  'regras de composição) está descrito na seção "GERAÇÃO DE DECK (motor HTML)" mais abaixo — ' +
  'esta seção cobre o CONTEÚDO e a qualidade editorial, que valem para qualquer slide.\n' +
  '- Público/rodapé: capture o cliente/empresa-alvo das respostas e use-o no rodapé de todo ' +
  'slide e na capa (ex.: "Preparado para o C-Level · Grupo Capitale", "Prepared for Murphy USA"), ' +
  'já escrito no idioma do deck. Se o usuário indicou quem apresenta/assina, cite na capa e no ' +
  'encerramento.\n' +
  '- ARCO NARRATIVO (obrigatório): antes de escrever qualquer slide, decida o arco em uma linha ' +
  '(ex.: "contexto → problema → visão da solução → prova/comparação → business case → plano → ' +
  'decisão") e siga-o: começo (por que estamos aqui), meio (argumento com evidência), fim ' +
  '(resumo executivo + próximo passo concreto).\n\n' +

  'DIMENSIONAMENTO: o número de slides segue o conteúdo e a duração pedida — nunca comprima ' +
  'um pedido denso em meia dúzia de slides. Referências: ~30 min executivos ≈ 18–24 slides; ' +
  'cada seção temática pedida ≈ 1 slide divisor + 2–4 slides de conteúdo; decks com 10+ slides ' +
  'devem usar divisores entre blocos e fechar com um resumo executivo (3–5 conclusões ' +
  'ranqueadas) antes do slide de encerramento.\n\n' +

  'COPYWRITING (o que separa um deck profissional de uma lista de tópicos):\n' +
  '- O TÍTULO de um slide de conteúdo é a CONCLUSÃO do slide, não o assunto. Rótulos como ' +
  '"Principais vantagens" ou "Resultados" são proibidos; escreva a tese completa: ' +
  'RUIM: "Vantagens do Unity Catalog" → BOM: "Uma camada de governança substitui quatro ' +
  'ferramentas separadas". RUIM: "Cronograma" → BOM: "Go-live antes do fim do ano, com valor ' +
  'entregue em cada fase".\n' +
  '- Um "kicker" curto (rótulo de categoria em caixa alta, ex.: "Business case", "Contexto") ' +
  'orienta acima do título; o título afirma. Uma frase de apoio neutra pode vir sob o título.\n' +
  '- Bullets com no máx. ~12 palavras, sempre afirmações (verbo + consequência), nunca ' +
  'fragmentos vagos. Use sentence case (nunca Title Case) em tudo.\n' +
  '- Um "so what" ancorado no pé (a implicação em uma frase forte) fecha os slides cuja ' +
  'conclusão não pode passar despercebida — use em 1 a cada 2–3 slides de conteúdo, não em todos.\n' +
  '- Sempre que um número/meta for estimativa ilustrativa (não dado real desta conversa), ' +
  'marque com uma nota de rodapé explícita no slide (ex.: "Illustrative target; firm business ' +
  'case produced during discovery."). Honestidade explícita é parte do estilo.\n\n' +

  'VARIEDADE DE COMPOSIÇÃO: escolha a forma de cada slide pela MENSAGEM dele, e varie — dois ' +
  'slides de bullets seguidos é sinal de composição preguiçosa. Repertório do que compõe um deck ' +
  'forte (materialize cada um em HTML, seguindo o motor descrito abaixo):\n' +
  '- capa com kicker + título de valor citando o cliente; divisores entre seções; encerramento ' +
  'com um call-to-action concreto (nunca "Obrigado");\n' +
  '- grade de 2–4 cards para ideias paralelas (pilares, capacidades, dores); faixa de 2–4 ' +
  'métricas grandes para KPIs (o número em destaque, o contexto em legenda curta);\n' +
  '- matriz de comparação para "antes/depois", "nós vs. eles" ou trade-offs de 4+ critérios ' +
  '(muito mais forte que duas listas lado a lado); linha do tempo para roadmap/fases;\n' +
  '- diagrama de arquitetura/fluxo (colunas de nós ligadas por setas, com a plataforma central ' +
  'em destaque) SEMPRE que a mensagem for "como as peças se conectam" — é o slide que mais ' +
  'transmite competência técnica em propostas de dados/plataforma;\n' +
  '- gráfico APENAS de dados REAIS desta conversa (pedido, respostas, anexos, resultados de ' +
  'tools, candidatos candidate_N). Números ilustrativos só com nota de estimativa no slide; ' +
  'nunca invente uma série apresentada como dado real. Sem dados completos, prefira uma ' +
  'afirmação clara em texto a um gráfico vazio.\n\n' +

  'Nunca envie outro texto além do bloco correspondente (`deck-questions` na Etapa 1, ou o bloco ' +
  'de deck da Etapa 2) quando o pedido for especificamente por uma apresentação — o Estúdio de ' +
  'Slides cuida da renderização e o usuário poderá editar tudo antes de exportar para PPTX.'

// Spreadsheet generation: the tabular sibling of a deck. Emitted as a
// `spreadsheet` prism-block, rendered as a live-preview grid in the chat and
// exported as a REAL .xlsx (formulas that recalc, formatting, dropdowns,
// native charts). The workbook wears the user's design system automatically —
// the model never picks band/header colors, only the semantic ROLE of a cell.
const SPREADSHEET_POLICY =
  '\n\nCriação de PLANILHAS (workbooks .xlsx): esta interface NÃO executa código — nunca gere ' +
  'python/openpyxl, código de macro, CSV solto ou "cole numa planilha" como forma de criar uma ' +
  'planilha. Uma planilha é sempre um único bloco ```prism-block``` do tipo `spreadsheet`.\n\n' +

  '=== QUANDO ENTRAR NESSE FLUXO ===\n' +
  'Use `spreadsheet` quando o usuário pedir explicitamente uma PLANILHA, template de Excel, ' +
  'modelo de cálculo, controle/orçamento, modelo de valuation/DCF, projeção financeira ou algo ' +
  'que ele vá abrir e EDITAR no Excel/Sheets. NÃO confunda:\n' +
  '- 1 gráfico sobre dados de um anexo → use o bloco `chart` (candidate_N), não uma planilha.\n' +
  '- uma matriz de dados só para LEITURA dentro do chat → use o bloco `table`.\n' +
  '- uma apresentação → use `deck`.\n' +
  'A planilha é para quando o VALOR está em o usuário ter um arquivo Excel funcional em mãos.\n\n' +

  '=== ESTRUTURA DO BLOCO ===\n' +
  '```prism-block\n{"type":"spreadsheet","title":"...","sheets":[{"name":"Resumo",' +
  '"freeze":{"row":1,"col":0},"blocks":[ ...blocos ordenados... ],"charts":[ ...opcional... ]}]}\n```\n' +
  'Cada ABA (sheet) tem um "name" curto (≤31 chars) e uma LISTA ORDENADA de "blocks", pintados de ' +
  'cima para baixo — isso permite empilhar VÁRIAS tabelas sob faixas de título numa mesma aba ' +
  '(ex.: uma aba "Resumo" com um painel geral + "DESPESAS POR CATEGORIA" + "RECEITAS POR ' +
  'CATEGORIA"). Tipos de bloco:\n' +
  '- {"kind":"title","text":"..."} — faixa de título principal da aba (uma no topo).\n' +
  '- {"kind":"note","text":"..."} — linha de instrução em itálico (ex.: "Preencha as células ' +
  'de entrada destacadas; os totais recalculam sozinhos"). NUNCA cite uma COR concreta ("células ' +
  'amarelas/verdes/azuis") — a cor das células vem do design system e você não sabe qual será; ' +
  'refira-se sempre pela FUNÇÃO ("células de entrada destacadas", "campos a preencher").\n' +
  '- {"kind":"section","text":"..."} — faixa de subtítulo que rotula a tabela seguinte.\n' +
  '- {"kind":"spacer"} — uma linha em branco de respiro.\n' +
  '- {"kind":"table","columns":[...],"rows":[[...]]} — a tabela em si (ver abaixo). Use ' +
  '"headerless":true para um painel rótulo→valor sem cabeçalho (ex.: "Total de Receitas | =...").\n\n' +

  '=== TABELAS, COLUNAS E CÉLULAS ===\n' +
  'Cada coluna: {"header":"...","key":"...","format":"...","role":"...","dropdown":["...",...]?,"width":N?}.\n' +
  '- "header" é o rótulo exibido; para tabelas "headerless" (painel rótulo→valor) dê um "key" curto ' +
  'a cada coluna (ex.: "key":"valor") para poder referenciá-la em fórmulas por nome.\n' +
  '- "format" (aplica número/data): text | number | integer | currency | usd | eur | percent | ' +
  'percent0 | date | datetime. currency/number/percent já mostram negativos em vermelho.\n' +
  '- "role" (COR SEMÂNTICA da célula, escolhida pela FUNÇÃO, nunca a cor concreta — o app pinta ' +
  'segundo o design system): "input" = célula que o usuário digita; "key" = campo-chave/premissa ' +
  'a preencher; "formula" = célula calculada; "link" = referência a outra aba; "normal" = neutra. ' +
  'Uma linha da tabela é um array alinhado às colunas; um valor pode ser escalar, uma STRING de ' +
  'fórmula começando com "=" (o Excel calcula), ou {"v":valor,"role":"...","format":"...","name":"..."} ' +
  'para sobrescrever uma célula específica. Dê "name" a uma célula avulsa (ex.: uma premissa numa ' +
  'tabela headerless) para poder referenciá-la por nome em outras fórmulas.\n' +
  '- "dropdown": lista de opções vira uma validação de dados (menu suspenso) em toda a coluna.\n\n' +

  '=== FÓRMULAS — REFERENCIE POR NOME, NUNCA POR POSIÇÃO (crítico p/ correção) ===\n' +
  'Sempre que um valor DERIVA de outros, escreva a FÓRMULA (não o número congelado) — assim o ' +
  'usuário muda uma premissa e o modelo recalcula. MAS você NÃO SABE em que linha/coluna cada ' +
  'célula vai cair na grade (títulos, notas, faixas e spacers deslocam tudo), então é PROIBIDO ' +
  'escrever referências A1 absolutas como "=B14-C14" ou "=SUM(C2:C13)" — elas ficam deslocadas e ' +
  'produzem resultados errados. Em vez disso, use TOKENS entre colchetes que o app resolve para o ' +
  'A1 exato:\n' +
  '- [@NomeDaColuna] → a célula da MESMA LINHA na coluna indicada, na própria tabela. ' +
  'Ex.: numa linha de categoria, "Diferença" = "=[@Orçado]-[@Realizado]".\n' +
  '- [Aba!NomeDaColuna] → a coluna de dados INTEIRA daquela aba (vira algo como \'Aba\'!$E:$E). ' +
  'Ex.: "=SUMIFS([Transacoes!Valor],[Transacoes!Tipo],\\"Despesa\\")". Sem "Aba!" a coluna é a da ' +
  'aba atual.\n' +
  '- [#nomeDaCelula] → a célula única que você marcou com "name":"nomeDaCelula" (em qualquer aba). ' +
  'Ex.: "=[#totalReceitas]-[#totalDespesas]".\n' +
  'O nome no token deve bater com o "header"/"key" da coluna ou o "name" da célula (sem diferenciar ' +
  'maiúsculas). Funções e operadores normais do Excel valem (SUM, SUMIFS, IF, ROUND, etc.); só as ' +
  'REFERÊNCIAS a células é que vão por token. Um token que não casar com nada vira #REF! (erro ' +
  'visível) — então confira que todo token existe.\n' +
  'NÃO MISTURE estilos: se uma coluna calculada usa [@…] em uma linha, use [@…] em TODAS as linhas ' +
  'dela — nunca escreva "=[@Orçado]-[@Real]" numa linha e "=B11-C11" na outra. Para somar uma faixa ' +
  'de linhas da própria tabela (ex.: uma linha "Total"), prefira SUM sobre uma coluna inteira via ' +
  'token OU garanta que só há UMA tabela e conte as linhas com cuidado; na dúvida, use tokens. Cada ' +
  'linha de dados de uma tabela é contígua (sem linhas em branco automáticas entre elas).\n' +
  'PREFIRA FUNÇÕES CLÁSSICAS E ROBUSTAS (SUM, SUMIF, SUMIFS, IF, ROUND, COUNTIF, COUNTIFS, AVERAGE, ' +
  'MIN, MAX, INDEX/MATCH, VLOOKUP, HLOOKUP). EVITE funções de matriz dinâmica (XLOOKUP, FILTER, SORT, ' +
  'UNIQUE, SEQUENCE) e funções muito recentes — resolva o mesmo com INDEX/MATCH ou já deixe os dados ' +
  'prontos. Isso garante compatibilidade ampla (Excel, Google Sheets, LibreOffice) e que o preview do ' +
  'app mostre o valor calculado. Para buscar um valor em OUTRA aba (ex.: a % de sazonalidade do mês), ' +
  'prefira INDEX([Aba!ColunaValor], MATCH([@Chave], [Aba!ColunaChave], 0)) — é o padrão que o preview ' +
  'resolve com mais confiabilidade.\n\n' +

  '=== GRÁFICOS NATIVOS (opcional, por aba) ===\n' +
  '"charts":[{"kind":"bar|line|area|pie","title":"...","tableBlock":IDX,"categoryColumn":C,' +
  '"valueColumns":[V,...]}]. "tableBlock" é o ÍNDICE (base 0) do bloco table dentro de "blocks"; ' +
  '"categoryColumn"/"valueColumns" são índices de coluna (base 0) DENTRO dessa tabela. O app ' +
  'posiciona os gráficos sozinho (à direita da tabela, empilhados sem sobrepor) — NÃO informe ' +
  'âncora/posição. O gráfico é ligado às células — nunca forneça dados de gráfico soltos.\n\n' +

  '=== ABA DE INSTRUÇÕES (automática) ===\n' +
  'NÃO crie uma aba de instruções/legenda manualmente — o app SEMPRE adiciona uma aba "Instruções ' +
  'de Uso" ao final, com a legenda de cores (segundo o design system) e como preencher. Se quiser ' +
  'acrescentar orientações específicas do modelo, inclua um campo no topo: "instructions":["linha ' +
  '1","linha 2",...] — cada string vira uma linha nessa aba. Dê também um "purpose" curto a cada ' +
  'aba (ex.: "purpose":"Registre aqui cada lançamento") para descrevê-la no mapa de abas.\n\n' +

  '=== HONESTIDADE DE DADOS ===\n' +
  'Números só podem vir desta conversa (pedido, respostas, anexos, resultados de tools). Para um ' +
  'TEMPLATE em branco (o usuário pediu "um modelo para preencher"), deixe as células de input ' +
  'vazias ou com exemplos claramente marcados, e ponha as fórmulas prontas — não invente dados ' +
  'reais. Valores ilustrativos são permitidos apenas se rotulados como exemplo (ex.: numa "note").\n\n' +

  'Envie SOMENTE o bloco `spreadsheet` quando o pedido for por uma planilha — o app mostra o ' +
  'preview e o usuário exporta o .xlsx.'

// Always sent, even with no chart candidates yet — without it, a model asked
// for an "interactive chart" defaults to emitting HTML/React/Plotly code
// blocks (which this chat UI cannot execute), instead of the prism-block
// mechanism that's the only thing that actually renders here. The carve-out
// for explicit code requests matters: PDF/DOCX/PPTX attachments and plain
// questions ("monte um gráfico sobre X") never carry chart candidates either,
// but that's not a signal the user wants source code — only an explicit ask
// for code/script/implementation is.
const CHART_POLICY =
  '\n\nPolítica de gráficos e visualizações: esta interface de chat NÃO executa código. Quando ' +
  'o usuário pedir uma análise, um gráfico ou uma visualização de dados — venha o pedido de um ' +
  'anexo (planilha, PDF, DOCX, PPTX) ou de uma pergunta genérica sem anexo — NUNCA responda com ' +
  'blocos de código HTML, JavaScript, React, Plotly, matplotlib, Chart.js ou similares como forma ' +
  'de "gerar" o gráfico; eles não são renderizados, aparecem como texto bruto e confundem o ' +
  'usuário. A única forma de exibir um gráfico interativo de verdade nesta interface é o bloco ' +
  '```prism-block descrito abaixo.\n' +
  'Exceção: se o usuário pedir explicitamente ajuda com código/programação (ex: "me dá o código ' +
  'Python/React para isso", "como eu implemento esse gráfico", "quero o script") aí sim responda ' +
  'normalmente com o bloco de código — essa política só se aplica quando o pedido é a análise/o ' +
  'gráfico em si, não uma ajuda de programação.\n\n' +
  'Há DOIS modos de preencher um bloco de gráfico (sempre dentro de ```prism-block```):\n' +
  'MODO 1 — REFERÊNCIA a um candidato pré-calculado (PREFERIDO sempre que existir um candidate_N ' +
  'nesta conversa): {"type":"chart","ref":"candidate_1","caption":"legenda curta"}. Os números já ' +
  'vêm validados; use este modo quando houver candidato disponível.\n' +
  'MODO 2 — DADOS EM LINHA: quando você JÁ TEM os números nesta conversa (resultado de uma tool ' +
  'como Genie/Genie One/Python, um anexo, ou valores já citados) mas NÃO existe um candidate_N ' +
  'para eles, forneça a série você mesmo, NESTE formato EXATO:\n' +
  '```prism-block\n{"type":"chart","chartType":"line","title":"Receita mensal","series":[{"name":' +
  '"Receita (R$)","data":[{"label":"2016-09","value":252.24},{"label":"2016-10","value":59090.48}]}],' +
  '"caption":"legenda opcional"}\n```\n' +
  'chartType é um de "bar" | "line" | "area" | "pie". A série é SEMPRE series→data→{label,value}. ' +
  'NUNCA invente um formato próprio: nada de "chartRef", "data":{"labels":[...]}, "values":[...], ' +
  'nem apontar "ref" para um candidato que não existe — qualquer um desses faz o bloco ser ' +
  'descartado e o JSON vaza como texto cru para o usuário (exatamente o que NÃO pode acontecer).\n' +
  'HONESTIDADE (modo 2): os pontos do gráfico só podem ser dados REAIS já presentes nesta conversa ' +
  '(resultado de tool, anexo, números citados). NUNCA fabrique uma série. Se você não tem os ' +
  'números de verdade, não desenhe o gráfico — explique em uma frase e peça a fonte (planilha/CSV) ' +
  'ou rode a tool que traz os dados.\n'

const NO_CANDIDATES_INSTRUCTION =
  '\nNo momento não há dados tabulares pré-calculados disponíveis nesta mensagem (nenhuma ' +
  'planilha/CSV foi anexada nesta conversa — um PDF, DOCX ou PPTX anexado não conta como fonte ' +
  'de dados tabulares —, ou os números citados não vêm de um arquivo). Se o usuário pedir um ' +
  'gráfico e nenhuma tool disponível puder trazer dados tabulares, explique isso em uma frase e ' +
  'peça para anexar uma planilha ou CSV — nunca invente números nem produza código para simular ' +
  'um gráfico.\nExceção: se você chamar uma tool (ex: Genie) e o resultado da tool vier acompanhado ' +
  'de uma lista de "novos candidatos de gráfico disponíveis", isso significa que dados reais e ' +
  'seguros para visualizar já existem — use o bloco prism-block normalmente com o ID indicado.'

// Injected only when caps.image is on (an explicit image request, or a
// follow-up in a thread that already has an image). Teaches the model to (1)
// call the generate_image tool with a rich ENGLISH prompt, and (2) place the
// returned image as an `image` prism-block right where it belongs — never to
// invent an imageRef or emit a raw image/URL/markdown-image itself.
const IMAGE_POLICY =
  '\n\nGeração de imagens: quando o usuário pedir EXPLICITAMENTE para criar/gerar/desenhar uma ' +
  'imagem, ilustração, foto, logo, ícone, banner ou arte, use a tool `generate_image`. Regras:\n' +
  '- Escreva o "prompt" da tool em INGLÊS e bem descritivo (assunto, estilo, composição, ' +
  'iluminação, cores, enquadramento, humor) — mesmo que o usuário tenha escrito em português. ' +
  'Modelos de imagem respondem muito melhor a prompts ricos em inglês. Traduza a INTENÇÃO do ' +
  'usuário num prompt visual completo; não copie o pedido literal se ele for curto/vago.\n' +
  '- NÃO use a tool para "buscar" imagens existentes na internet (você não faz isso). Se o usuário ' +
  'só quer que você DESCREVA/analise uma imagem que ele anexou, responda direto (você a enxerga) — ' +
  'sem chamar a tool. Use a tool para CRIAR uma imagem nova OU para EDITAR/transformar uma imagem ' +
  'anexada.\n' +
  '- EDIÇÃO (img2img): quando o usuário anexa/cola uma imagem e pede para modificá-la ("deixe em ' +
  'preto e branco", "adicione um chapéu", "outra versão disso"), chame `generate_image` com um ' +
  'prompt que descreva a TRANSFORMAÇÃO desejada — o servidor já entrega a imagem anexada ao modelo ' +
  'de imagem automaticamente, você não precisa reanexá-la.\n' +
  '- Depois que a tool retornar um ref (ex.: "img_42"), insira a imagem na sua resposta com um ' +
  'bloco ```prism-block``` do tipo "image", logo após o parágrafo que a apresenta:\n' +
  '```prism-block\n{"type":"image","imageRef":"img_42","caption":"legenda curta opcional"}\n```\n' +
  '- NUNCA invente um "imageRef" que a tool não devolveu, NUNCA escreva a imagem como markdown ' +
  '![](...) nem cole um data:URL ou link — a ÚNICA forma de exibir a imagem é o bloco acima com o ' +
  'ref real. Se o usuário pedir uma variação/ajuste de uma imagem já criada, chame a tool de novo ' +
  'com um novo prompt refletindo o ajuste e insira o novo bloco.\n'

// Injected only when caps.document is on. Teaches the model to author a proper
// text DOCUMENT (report/article/letter/…) as a `document` prism-block whose
// body is MARKDOWN — the Document Studio renders it as rich text and exports to
// DOCX/Markdown/PDF. This is for real deliverable documents, NOT ordinary chat
// answers (a short explanation stays plain prose in the reply).
const DOCUMENT_POLICY =
  '\n\nCriação de documentos de texto: quando o usuário pedir EXPLICITAMENTE um documento, ' +
  'relatório, artigo, carta, proposta, memorando, política, manual ou similar como ENTREGÁVEL, ' +
  'escreva-o como um bloco ```prism-block``` do tipo "document", cujo corpo é MARKDOWN:\n' +
  '```prism-block\n{"type":"document","title":"Título do documento","markdown":"# Título\\n\\n' +
  'Parágrafo de abertura...\\n\\n## Seção\\n\\n- item\\n- item\\n\\nTexto **em negrito** e _itálico_, ' +
  'tabelas, listas, citações (>) e código são suportados."}\n```\n' +
  'Regras:\n' +
  '- Use markdown rico e bem estruturado: títulos (#, ##, ###), listas, tabelas, negrito/itálico, ' +
  'citações, blocos de código quando fizer sentido. A UI renderiza como rich text.\n' +
  '- O "markdown" deve ser um documento COMPLETO e autossuficiente, não um esqueleto — escreva o ' +
  'conteúdo de verdade, no idioma e tom pedidos.\n' +
  '- NÃO use um documento para uma resposta curta de chat, um resumo trivial, um deck ou uma ' +
  'planilha — só para um texto que o usuário claramente quer como um documento editável/exportável.\n' +
  '- Se já existe um documento nesta conversa e o usuário pede um ajuste (mais formal, adicionar uma ' +
  'seção, encurtar), gere um novo bloco `document` completo e atualizado.\n' +
  '- Escreva uma frase curta antes do bloco apresentando o documento; o bloco em si carrega o texto.\n'

// Asset-kind gates shared by the model-facing hint (below) — the single place
// that decides what the model may reference. `watermark` assets (recurring page
// logos/brand marks mined from the template, see classifyMedia in
// DeckTemplatesSettings.jsx) are NEVER usable: a generated deck must never
// carry a watermark, neither as an icon nor as a slide image.
// Legacy assets saved before `kind` existed count as icons.
export function usableIconAssets(template) {
  return (template?.iconAssets || []).filter((a) => !a.kind || a.kind === 'icon')
}
export function usableImageAssets(template) {
  return (template?.iconAssets || []).filter((a) => a.kind === 'image')
}

// True when the active design system carries enough mined/imported material to
// have a real visual LANGUAGE of its own (its own slide compositions, a
// declared type scale, a decorative motif, component specimens) — not just 4
// colors + a logo. For these, the generator should COMPOSE to match the DS
// (freeform-first) instead of pouring content into fixed semantic skeletons
// that make every DS look the same. See templateComposition below.
export function hasRichDesignSystem(template) {
  if (!template) return false
  return !!(
    template.previewSlides?.length ||
    template.dsCards?.length ||
    template.dsCardsMeta?.length ||
    template.minedStyle?.titlePt ||
    template.minedStyle?.motif ||
    (template.palette?.length || 0) >= 6
  )
}

// The DS's COMPOSITION brief: distills the mined/imported material into a
// description of the design system's own visual language, so the model can
// compose freeform slides that embody THIS brand — not a generic skeleton
// merely repainted. This is the core of "decks adapt to any design system":
// the renderer already applies colors/fonts/plates, but only the model can
// decide COMPOSITION (density, hierarchy, where whitespace goes), and it can
// only do that if it's told what this DS looks like. Everything here is
// derived from real mined data — never invented.
function templateComposition(template) {
  if (!hasRichDesignSystem(template)) return ''
  const mined = template.minedStyle || {}
  const lines = []

  // typographic personality: the title/body point-size contrast mined from the
  // master. A high ratio → dramatic, editorial type (big headlines, sparse
  // slides); a low ratio → dense, uniform, corporate type.
  if (mined.titlePt && mined.bodyPt) {
    const ratio = mined.titlePt / mined.bodyPt
    const feel = ratio >= 3 ? 'DRAMÁTICA (títulos enormes, slides arejados, muito espaço em branco)'
      : ratio >= 2 ? 'equilibrada (títulos claramente dominantes, densidade média)'
      : 'sóbria/densa (contraste tipográfico baixo, muita informação por slide)'
    lines.push(`- Personalidade tipográfica ${feel}: título ~${Math.round(mined.titlePt)}pt vs corpo ~${Math.round(mined.bodyPt)}pt. Respeite essa proporção de contraste no CSS dos slides.`)
  }

  // the DS's OWN slides (mined structures) — the strongest signal of how this
  // brand composes: how many points per slide, whether it leans on imagery,
  // and the actual voice of its headings. A handful of real examples teaches
  // the model this DS's rhythm far better than any adjective.
  const ps = (template.previewSlides || []).filter((s) => s.title || s.bullets?.length)
  if (ps.length) {
    const avgBullets = ps.reduce((a, s) => a + (s.bullets?.length || 0), 0) / ps.length
    const imgShare = ps.filter((s) => s.imageDataUrl || s.imageMediaPath).length / ps.length
    const density = avgBullets <= 2 ? 'ENXUTA (poucas linhas por slide, uma ideia por slide)'
      : avgBullets <= 4 ? 'moderada (3–4 pontos por slide)'
      : 'densa (listas longas)'
    lines.push(`- Densidade de conteúdo ${density}; ${imgShare >= 0.4 ? 'forte apoio em imagens/visuais' : 'predominantemente tipográfica'}.`)
    const examples = ps.slice(0, 5).map((s) => {
      const b = (s.bullets || []).slice(0, 3).map((x) => x.slice(0, 60))
      return `  · "${(s.title || '').slice(0, 80)}"${b.length ? ` — ${b.join(' | ')}` : ''}`
    })
    if (examples.length) {
      lines.push('- Slides REAIS deste design system (imite a estrutura e o ritmo, não copie o conteúdo):\n' + examples.join('\n'))
    }
  }

  // BUNDLE specimens (Claude Design imports): the design system's own slide/
  // component compositions, mined as HTML cards. Their group+title+description
  // is the bundle's equivalent of previewSlides — the strongest signal of how
  // THIS brand composes a slide. We list the slide/template-flavored ones so
  // the model models its freeform composition on the DS's real specimens.
  const specimens = template.dsCardsMeta || (template.dsCards || []).map((c) => ({ group: c.group, title: c.title, description: c.description }))
  const slideSpecs = specimens.filter((c) => /slide|template|deck|layout|capa|cover|section|divis/i.test(`${c.group} ${c.title}`))
  const pool = (slideSpecs.length ? slideSpecs : specimens).slice(0, 8)
  if (pool.length) {
    lines.push(
      '- Composições REAIS deste design system (specimens do bundle — modele os slides freeform ' +
      'nesta linguagem de layout, não copie o texto):\n' +
      pool.map((c) => `  · ${c.group ? `[${c.group}] ` : ''}${(c.title || '').slice(0, 80)}${c.description ? ` — ${(c.description).slice(0, 90)}` : ''}`).join('\n')
    )
  }

  if (!lines.length) return ''
  return (
    '\n\n=== LINGUAGEM DE COMPOSIÇÃO DESTE DESIGN SYSTEM (adeque os slides a ELE) ===\n' +
    'Este design system tem uma identidade visual PRÓPRIA. Um deck genérico repintado com as ' +
    'cores dele NÃO basta — a COMPOSIÇÃO (hierarquia, densidade, onde vai o espaço em branco, ' +
    'como os elementos se agrupam) precisa parecer nativa desta marca. Guie-se por estas ' +
    'características mineradas do próprio design system, reproduzindo-as no HTML que flui:\n' +
    lines.join('\n') +
    '\n\nDENSIDADE (calibre de deck profissional) — abaixo do título, a área de conteúdo deve ser ' +
    'preenchida com uma COMPOSIÇÃO estruturada (flexbox/grid), não um bloco de texto solto. ' +
    'Prefira, conforme o conteúdo: grade de 2–4 cards para pilares/capacidades; faixa de 2–4 ' +
    'métricas grandes para KPIs; diagrama multi-coluna ligado por setas para arquiteturas/fluxos; ' +
    'matriz de comparação para trade-offs. Distribua os blocos pela largura toda, mantenha ' +
    'gaps/paddings consistentes e alinhe as bordas. Cada slide de conteúdo deve sair CHEIO de ' +
    'conteúdo real — um slide com só um título ou uma placa vazia é uma falha. ' +
    'ÍCONES são OPCIONAIS, não obrigatórios: um ícone só entra num card quando existe um ativo do ' +
    'DS (ou, na falta dele, um glifo simples) que representa DE VERDADE aquele item — caso contrário, ' +
    'o card fica só com rótulo + texto, o que é perfeitamente profissional. Um bom deck do DS usa ' +
    'ícones com PARCIMÔNIA; não force um ícone em cada card só para preencher.'
  )
}

// A short addendum steering a deck toward the user's selected template. When
// the DS is just colors + a logo, this only nudges wording/tone (the renderer
// already applies the visual side). When the DS is rich, templateComposition
// (above) additionally steers the COMPOSITION so the deck looks native to the
// brand rather than a repainted generic skeleton.
function templateHint(template) {
  if (!template || (!template.name && !template.styleNotes && !template.brandRules && !template.iconAssets?.length && !template.minedStyle?.diagrams?.length)) return ''
  const rich = hasRichDesignSystem(template)
  const parts = []
  if (template.name) parts.push(`modelo selecionado: "${template.name}"`)
  if (template.styleNotes) parts.push(`notas de estilo: ${template.styleNotes}`)
  // ceiling removed for rich DS: telling the model "visual is automatic, only
  // adjust tone" is exactly what makes every DS look the same — for a DS with
  // its own visual language, the model must own composition (templateComposition).
  let hint = rich
    ? `\n\nO usuário tem um design system ativo, com identidade visual própria (${parts.join('; ') || 'sem nome'}). ` +
      'Cores, fontes e logo são aplicados automaticamente, mas isso é só a superfície — a ' +
      'COMPOSIÇÃO dos slides precisa refletir esta marca (ver a linguagem de composição abaixo), ' +
      'não um layout genérico repintado. Ajuste tom, estrutura E composição para condizer com o design system.'
    : `\n\nO usuário tem um design system ativo para os decks (${parts.join('; ') || 'sem nome'}). ` +
      'Cores, fontes e logo já são aplicados automaticamente pelo Estúdio de Slides — ajuste ' +
      'apenas o tom e a estrutura do conteúdo (título, bullets, notas) para condizer com essas ' +
      'notas de estilo quando fizer sentido.'
  if (template.brandRules) {
    // the design-system bundle's own README (condensed at import — see
    // dsImport.js condenseReadme): brand voice, casing, color/type rules.
    // This is COPY guidance (how headlines/bullets/notes should sound), the
    // visual side is already applied by the renderer.
    hint +=
      '\n\nRegras de marca do próprio design system (siga-as na REDAÇÃO do deck — voz, casing, ' +
      'tom; a parte visual já é automática):\n---\n' +
      template.brandRules +
      '\n---'
  }
  // === ASSETS REAIS DO DESIGN SYSTEM (motor HTML) ===
  // Colors and fonts ride CSS tokens; raster/vector assets can't, so the model
  // references a real DS asset by id via `<img data-ds-asset-id="ID">` (the
  // renderer swaps in the brand's real inlined art — see client deckAssets.js).
  // This is the ONLY correct way to place brand imagery in the pure-HTML engine.
  const icons = usableIconAssets(template)
  const illustrations = (template.iconAssets || []).filter((a) => a.kind === 'illustration')
  const images = usableImageAssets(template)
  const hasAnyAsset = icons.length || illustrations.length || images.length || template.logoDataUrl

  if (hasAnyAsset) {
    hint +=
      '\n\n=== ATIVOS VISUAIS REAIS DESTE DESIGN SYSTEM ===\n' +
      'Para inserir um ativo REAL da marca (ícone, ilustração/motivo, imagem, logo) num slide, ' +
      'use uma tag `<img data-ds-asset-id="ID">` com um dos ids abaixo — o renderizador substitui ' +
      'pelo asset de verdade. Controle o tamanho/posição com CSS (width/height/etc.) como em ' +
      'qualquer <img>. NUNCA escreva `src="..."` você mesmo nem invente um id fora desta lista ' +
      '(um id inexistente some do slide). Ícones/ilustrações do DS NÃO são emoji — a marca nunca ' +
      'usa emoji.'
    if (template.logoDataUrl) {
      hint += '\n• LOGO da marca: `<img data-ds-logo>` — use na capa e no encerramento (nunca em todo slide).'
    }
    if (icons.length) {
      hint +=
        '\n• ÍCONES do design system (para itens de cards, KPIs, listas — um por item, sem repetir ' +
        'no mesmo slide). REGRA DE PERTINÊNCIA (crítica): só use um id quando o rótulo dele for uma ' +
        'correspondência SEMÂNTICA REAL do conteúdo daquele item. Muitos destes são ícones de ' +
        'PRODUTO/marca (ex.: um produto específico, um logo); um ícone de produto SÓ entra quando o ' +
        'item fala literalmente daquele produto. NÃO pegue um ícone de produto só porque "tem um ' +
        'ícone disponível" — um ícone que não tem relação com o texto confunde mais do que ajuda e ' +
        'parece amador. Na dúvida, não use ícone naquele item. Ids disponíveis (com rótulo):\n' +
        icons.slice(0, 40).map((a) => `  - ${a.id}: "${a.label || 'ícone sem nome'}"`).join('\n')
    }
    if (illustrations.length) {
      hint +=
        '\n• ILUSTRAÇÕES / MOTIVOS decorativos da marca (a arte gráfica do DS — ex.: padrões nodais) ' +
        '— use com MUITA PARCIMÔNIA, como o próprio DS faz: um motivo entra APENAS na capa, num ' +
        'divisor de seção ou no encerramento, para dar identidade — NUNCA em slides de conteúdo ' +
        '(cards, tabelas, KPIs, listas). No MÁXIMO um motivo por slide, e na maioria dos slides ' +
        'NENHUM. Quando usar, coloque UMA num canto/lateral (tipicamente ~300–420px). Use o motivo ' +
        'ORIGINAL do design system; só componha um motivo novo se o usuário pedir explicitamente. ' +
        'Ids disponíveis:\n' +
        illustrations.slice(0, 12).map((a) => `  - ${a.id}: "${a.label || 'ilustração'}"`).join('\n')
    }
    if (images.length) {
      hint +=
        '\n• IMAGENS/FOTOS reais do DS (só quando o rótulo indicar claramente que combina com o ' +
        'slide; rótulos genéricos como "Imagem 3" não dizem nada — nesse caso não use):\n' +
        images.slice(0, 12).map((a) => `  - ${a.id}: "${a.label || 'sem rótulo'}"`).join('\n')
    }
  } else {
    hint += '\n\nEste design system não cadastrou ícones/ilustrações reais — não use `<img data-ds-asset-id>` (não há ids) e NUNCA use emoji.'
  }

  // Anti-invention + anti-misuse rule — the reported bugs (#4/#5): the model
  // used to invent its own brand SVG/motifs; the over-correction then slapped
  // MISMATCHED product icons everywhere. The rule now distinguishes BRAND
  // identity assets (never invent) from CONTENT icons (a plain, on-topic glyph
  // beats a mismatched product icon). Applies whether or not the DS is "rich".
  hint +=
    '\n\nÍCONES, LOGOS E MOTIVOS — regra dura, com uma hierarquia clara de decisão por item:\n' +
    '1. Marca (LOGO e MOTIVOS decorativos): use SEMPRE o ativo REAL do DS (`<img data-ds-logo>` / ' +
    '`<img data-ds-asset-id>`). NUNCA desenhe um logo, um motivo ou um "lockup" da marca em ' +
    'SVG/CSS próprio (círculos, elipses, "blobs", grades de pontos) — isso destrói a identidade ' +
    'visual. Motivos, só com parcimônia e nunca em slides de conteúdo (ver acima).\n' +
    '2. Ícone de um item de conteúdo (card/KPI/lista): PRIMEIRO procure um ícone do DS cujo rótulo ' +
    'combine DE VERDADE com o item e use-o. Se NENHUM ícone do DS combina, você tem duas opções — ' +
    'nesta ordem de preferência: (a) NÃO usar ícone naquele item (rótulo + texto já é profissional); ' +
    '(b) desenhar um ícone SVG SIMPLES, de traço, monocromático na cor de texto/acento do tema, que ' +
    'represente o CONCEITO do item (ex.: um cadeado p/ segurança, uma engrenagem p/ processo). ' +
    'O que você NUNCA deve fazer é forçar um ícone de PRODUTO/marca do DS num item que não fala ' +
    'daquele produto só para "ter um ícone" — um ícone de produto fora de contexto é pior que ' +
    'nenhum ícone. Consistência: se um slide usa ícones SVG próprios, todos os itens daquele grupo ' +
    'seguem o mesmo estilo (não misture ícone de produto do DS com glifo desenhado no mesmo grupo).\n' +
    '(SVG inline sempre correto para GRÁFICOS de dados — barras, linhas, pizza — que são conteúdo.)'

  // the composition brief goes last so it sits closest to where the model
  // starts generating — the freshest, most actionable guidance for a rich DS
  hint += templateComposition(template)
  return hint
}

// Capability detection (progressive disclosure — "skills fase 1"). The deck and
// spreadsheet policies are BIG (~5k and ~2.2k tokens) and the deck template hint
// adds more; sending all of them on every turn means a trivial "quanto é 2+2?"
// pays for the entire deck+spreadsheet+design-system surface it will never use.
// This detects, deterministically and at zero latency, whether a turn is even
// PLAUSIBLY about a deck or a spreadsheet, and the caller only includes the
// heavy policy when it is.
//
// Safety is asymmetric and we lean into it: a FALSE POSITIVE just re-adds tokens
// (harmless); a FALSE NEGATIVE would strip a capability the user wanted (bad).
// So the vocabulary is generous, and — critically — a capability stays ON for
// the whole session once its flow is active (a prior deck/deck-questions or
// spreadsheet block in history, or the answers-marker follow-up), because the
// deck flow is inherently multi-turn (ask → answer → tweak). CHART_POLICY is
// always sent regardless: it's small and it's what stops the model from emitting
// unrenderable Plotly/HTML code for the very common "faça um gráfico" ask.
const DECK_INTENT_RE =
  /\b(apresenta[çc][ãa]o|apresenta[çc][õo]es|apresentar|slides?|slide\s*deck|deck|decks|pitch|pptx|powerpoint|power\s*point|keynote|present(ation|e)|capa\s+do\s+deck)\b/i
// Standalone spreadsheet tokens — specific enough that their bare presence is a
// real request (they don't show up as institutional-deck narrative the way
// "planilha"/"clientes" do).
const SPREADSHEET_STRONG_RE =
  /\b(xlsx|excel|workbook|valuation|dcf|fluxo\s+de\s+caixa|proje[çc][ãa]o\s+financeira|modelo\s+(de\s+)?(c[áa]lculo|financeiro|valuation))\b/i
const SPREADSHEET_NOUN_SRC = 'planilhas?|google\\s*sheets?|sheets?|spreadsheet|or[çc]amento|planejamento\\s+financeiro'
const SPREADSHEET_NOUN = new RegExp(`\\b(?:${SPREADSHEET_NOUN_SRC})\\b`, 'i')
// "adjust this presentation to the template/design system" — captures the
// re-theming intent even when the word "deck/apresentação" isn't repeated
// (the .pptx attachment already implies the artifact).
const ADJUST_INTENT_RE =
  /\b(ajust\w+|adapt\w+|aplic\w+|reestrutur\w+|padroniz\w+|formatar|reformatar|refazer|converter|transform\w+|adjust|adapt|apply|restructure|reformat|convert|rework)\b/i
// Builds a matcher requiring a create-VERB adjacent to an artifact NOUN (within
// ~4 words, either order). This is the fix for the reported bug where a deck
// briefing that NARRATES "geração de slides, planilhas, documentos, imagens" as
// product features lit up the spreadsheet/image/document capabilities too: a
// bare noun somewhere in a long prompt no longer counts — the verb has to be
// acting ON that noun. Follow-up turns ("gere a planilha") still match, and true
// multi-artifact requests ("crie um deck e uma planilha") match both because the
// verb sits next to each noun. Stickiness (history) covers verb-less follow-ups.
const GAP4 = '(?:\\s+\\S+){0,4}\\s+'
function verbNearNoun(verbSrc, nounSrc) {
  const vn = new RegExp(`\\b(?:${verbSrc})${GAP4}(?:${nounSrc})\\b`, 'i')
  const nv = new RegExp(`\\b(?:${nounSrc})${GAP4}(?:${verbSrc})\\b`, 'i')
  return { test: (t) => vn.test(t) || nv.test(t) }
}
// "generate/create/draw an image/illustration/logo/…" — the image-generation
// tool + policy. Verb must sit next to the image noun (see verbNearNoun).
const IMAGE_CREATE_VERB_SRC = 'gere?|gerar|cri[ae]r?|desenh\\w+|ilustr\\w+|fa[çc]a|fazer|produz\\w+|render\\w+|generate|create|draw|make|render|design|paint|imagine'
const IMAGE_NOUN_SRC = 'imagem|imagens|ilustra[çc][õo]es|ilustra[çc][ãa]o|figuras?|fotos?|fotografias?|desenhos?|artwork|logotipos?|logos?|[íi]cones?|banner|p[ôo]ster|wallpaper|thumbnail|images?|illustrations?|pictures?|photos?|drawings?|logo|icons?|posters?'
const IMAGE_INTENT_RE = verbNearNoun(IMAGE_CREATE_VERB_SRC, IMAGE_NOUN_SRC)
// "write/draft a document/report/article/letter/…" — the document-writing
// capability (rich-text Studio + DOCX/MD/PDF export). Verb next to the doc noun.
const DOC_CREATE_VERB_SRC = 'escrev\\w+|redij\\w+|redig\\w+|elabor\\w+|crie|criar|gere?|gerar|produz\\w+|prepar\\w+|monte|montar|rascunh\\w+|write|draft|compose|create|generate|prepare|author'
const DOC_NOUN_SRC = 'documento|documentos|relat[óo]rios?|artigos?|ensaios?|carta|cartas|of[íi]cio|memorando|memorandos|proposta|propostas|contrato|contratos|pol[íi]tica|pol[íi]ticas|manuais?|especifica[çc][ãa]o|readme|whitepaper|white\\s*paper|briefing|document|documents|reports?|articles?|essays?|letters?|memo|memos|proposals?|contracts?|policy|policies|specs?|specifications?'
const DOC_INTENT_RE = verbNearNoun(DOC_CREATE_VERB_SRC, DOC_NOUN_SRC)
// Spreadsheet: a strong standalone token OR a create-verb next to a sheet noun.
const SPREADSHEET_CREATE_VERB_SRC = 'gere?|gerar|cri[ae]r?|monte|montar|fa[çc]a|fazer|produz\\w+|prepar\\w+|elabor\\w+|build|create|generate|make|prepare'
const SPREADSHEET_VERB_NEAR_NOUN = verbNearNoun(SPREADSHEET_CREATE_VERB_SRC, SPREADSHEET_NOUN_SRC)
const SPREADSHEET_INTENT_RE = {
  test: (t) => SPREADSHEET_STRONG_RE.test(t) || SPREADSHEET_VERB_NEAR_NOUN.test(t),
}

// Signals that the user wants THEIR OWN workspace/company data — the only thing
// the company-data tools (Genie One / Genie Spaces / UC functions / vector
// search) are for. The trap the first cut fell into: business nouns like
// "clientes", "vendas", "receita" appear ALL THE TIME as narrative content in an
// institutional deck ("impacto/tração com clientes", "geração de receita") —
// treating a bare noun as a data request lit up Genie One on a deck that never
// needed any data (the reported bug). So a bare business noun is NOT enough. A
// real data request shows one of three stronger signals:
//   1. an unmistakable data-SOURCE reference (Unity Catalog, Genie, a warehouse,
//      "tabela de ...", "nossa base de dados") — those mean querying, period;
//   2. a possessive/scope to the user's org NEXT TO a data noun ("nossa receita",
//      "our sales", "dados da empresa");
//   3. a query/analyze VERB applied to a data noun ("analise as vendas",
//      "puxe o churn", "calcule o consumo").
// An unmistakable data-SOURCE reference — a company data store. These mean
// "query my data", period, wherever they appear.
const DATA_SOURCE = /\b(unity\s*catalog|genie|data\s*warehouse|datamart|lakehouse|tabelas?\s+(do|da|de)\s+\w+|nossa\s+base\s+de\s+dados|nosso\s+banco\s+de\s+dados|our\s+(data\s*)?(warehouse|tables?|database))\b/i
// Fragments reused in the proximity patterns below.
const POSSESSIVE = 'nossos?|nossas?|minhas?|meus?|da\\s+empresa|do\\s+neg[óo]cio|our|my|company\'?s'
const DATA_NOUN_SRC =
  'receitas?|faturamento|vendas?|revenue|sales|pipeline|churn|arr|mrr|ltv|cac|estoques?|invent[áa]rios?|inventory|m[ée]tricas?|metrics?|kpis?|indicadores?|consumo|usage|transa[çc][õo]es|transactions?|pedidos?|orders?|leads?|oportunidades?|opportunities|assinaturas?|subscriptions?|dashboards?|dados|data'
const DATA_QUERY_VERB_SRC =
  'consult\\w+|puxe?|puxar|busque?|buscar|analis\\w+|calcul\\w+|extrai\\w+|extra[íi]\\w+|traga|trazer|liste?|listar|agrupe?|agrupar|filtre?|filtrar|query|pull|fetch|analy[sz]e|compute|aggregate'
// PROXIMITY is what separates a real data request from a data noun merely
// MENTIONED in narrative. "nossa receita", "vendas da empresa", "our sales",
// "analise o churn", "puxe os pedidos" — possessive/verb sitting NEXT TO the
// data noun (within ~3 words), in either order. A blob that happens to contain
// "da empresa" (from "design system da empresa") 500 chars away from "clientes"
// no longer counts — which is exactly the reported false positive.
const GAP = '(?:\\s+\\S+){0,3}\\s+'
const POSSESSIVE_NOUN = new RegExp(`\\b(?:${POSSESSIVE})${GAP}(?:${DATA_NOUN_SRC})\\b`, 'i')
const NOUN_POSSESSIVE = new RegExp(`\\b(?:${DATA_NOUN_SRC})\\s+(?:de\\s+|do\\s+|da\\s+|of\\s+)?(?:${POSSESSIVE})\\b`, 'i')
const VERB_NOUN = new RegExp(`\\b(?:${DATA_QUERY_VERB_SRC})${GAP}(?:${DATA_NOUN_SRC})\\b`, 'i')
export function hasDataIntent(userText) {
  const t = String(userText || '')
  if (DATA_SOURCE.test(t)) return true
  if (POSSESSIVE_NOUN.test(t) || NOUN_POSSESSIVE.test(t)) return true
  if (VERB_NOUN.test(t)) return true
  return false
}

function historyHasBlock(history, types) {
  for (const m of history || []) {
    const blocks = m.blocks
    if (Array.isArray(blocks) && blocks.some((b) => types.includes(b?.type))) return true
  }
  return false
}

// HYBRID gating for the cheap intent classifier (see classifyIntent in llm.js).
// The classifier is worth its (tiny) cost/latency only on turns whose intent is
// genuinely ambiguous to the regex router. It is SKIPPED — falling back to the
// fast regexes — on two kinds of turn whose intent is clear by nature:
//   1. Trivial/plain-chat turns with no artifact or data vocabulary at all
//      ("quanto é 2+2?") — running it would only add latency (the reported
//      "stuck in Thinking" pain) for a guaranteed all-false verdict.
//   2. A follow-up TWEAK on an artifact already in the thread, with no fresh
//      artifact noun and a short message ("deixe mais escuro", "mais formal",
//      "outra versão") — the sticky capability already resolves it; the intent
//      is 100% clear by essence (the user's own point about document tweaks,
//      generalized to any artifact).
// Deterministic turns (deck-questions answer) also skip. Everything else — the
// briefings and multi-artifact asks where the regex is unreliable — classifies.
export function shouldClassifyIntent(userText, history, opts = {}) {
  const t = String(userText || '')
  if (/^\s*perguntas respondidas\s*:/i.test(t)) return false
  const maybeArtifact =
    DECK_INTENT_RE.test(t) ||
    SPREADSHEET_STRONG_RE.test(t) ||
    SPREADSHEET_NOUN.test(t) ||
    new RegExp(IMAGE_NOUN_SRC, 'i').test(t) ||
    new RegExp(DOC_NOUN_SRC, 'i').test(t)
  const maybeData = DATA_SOURCE.test(t) || new RegExp(DATA_NOUN_SRC, 'i').test(t)
  // plain chat: no artifact/data signal and no attachment implying one → skip.
  if (!maybeArtifact && !maybeData && !opts.hasPptxAttachment && !opts.hasImageAttachment) return false
  // short tweak on an existing artifact, no fresh artifact noun → skip.
  const hasArtifactHistory = historyHasBlock(history, ['deck', 'deck-questions', 'spreadsheet', 'image', 'document'])
  if (hasArtifactHistory && !maybeArtifact && t.length < 240) return false
  return true
}

// Returns { deck, spreadsheet } — whether each heavy capability's policy should
// be included this turn. `userText` is the current prompt; `history` is the
// prior thread (each message may carry a `blocks` array).
//
// `opts.classifier` (optional) is the result of the cheap LLM intent classifier
// (llm.js classifyIntent). When present it is AUTHORITATIVE for the per-type
// artifact intents and the data intent — it reads the sentence semantically, so
// it doesn't trip on artifact nouns that appear only as narrative content (the
// reported bug). The regexes below stay as the zero-latency fast-path and as the
// fallback when the classifier wasn't run or failed. Deterministic signals that
// aren't narrative-ambiguous (deck-questions answer, .pptx attachment, image
// attachment) are always honored on top of whichever source we use.
export function detectCapabilities(userText, history, opts = {}) {
  const text = String(userText || '')
  const cls = opts.classifier?.intents || null
  // the deck flow's follow-up turn arrives as "Perguntas respondidas: ..." (see
  // DECK_POLICY etapa 2) — keep deck on so generation gets the full policy
  const answeringDeckQuestions = /^\s*perguntas respondidas\s*:/i.test(text)
  // A .pptx attached WITH an adjust/deck intent → the "adjust presentation" skill.
  // A bare .pptx with no intent stays plain-text (handled upstream). When it does
  // fire, deck is implied (same generation/render pipeline, re-themed to the DS).
  const pptxAdjust =
    !!opts.hasPptxAttachment && (DECK_INTENT_RE.test(text) || ADJUST_INTENT_RE.test(text))
  // Per-type EXPLICIT intent in the CURRENT message. When the classifier ran, its
  // verdict is the source of truth for the narrative-ambiguous artifact types;
  // otherwise we fall back to the (proximity-tightened) regexes.
  const deckIntent = (cls ? cls.deck : DECK_INTENT_RE.test(text)) || answeringDeckQuestions || pptxAdjust
  const spreadsheetIntent = cls ? cls.spreadsheet : SPREADSHEET_INTENT_RE.test(text)
  // an attached image also warms image (the user likely wants to edit it, and
  // "deixe em p&b" carries no image-noun the regex would catch)
  const imageIntent = (cls ? cls.image : IMAGE_INTENT_RE.test(text)) || !!opts.hasImageAttachment
  const documentIntent = cls ? cls.document : DOC_INTENT_RE.test(text)

  // Sticky capabilities: a thread that already produced an artifact keeps that
  // capability warm so a FOLLOW-UP with no explicit noun ("deixe mais escuro",
  // "outra versão", "mais formal") still resolves against the right artifact.
  //
  // BUT stickiness must NOT bleed across artifact types: if the current turn
  // has an explicit intent for SOME OTHER type (e.g. "gere uma imagem" right
  // after a document was created), the unrelated sticky capabilities are
  // dropped — otherwise the model receives the document policy on an image turn
  // and "helpfully" emits a document nobody asked for (the exact bug). So a
  // capability turns on when: it's explicitly requested this turn, OR the thread
  // has that artifact AND the current turn makes no competing explicit request.
  const anyExplicitIntent = deckIntent || spreadsheetIntent || imageIntent || documentIntent
  const sticky = (myIntent, types) =>
    myIntent || (historyHasBlock(history, types) && (!anyExplicitIntent || myIntent))

  const deck = sticky(deckIntent, ['deck', 'deck-questions'])
  const spreadsheet = sticky(spreadsheetIntent, ['spreadsheet'])
  const image = sticky(imageIntent, ['image'])
  const document = sticky(documentIntent, ['document'])
  // Company-data tools (Genie One / Genie Spaces / UC / vector search) are for
  // answering with the user's OWN workspace data. On a turn whose whole point is
  // generating an artifact (deck/spreadsheet/document/image) and that shows no
  // sign of needing internal data, those tools are pure risk: the model reaches
  // for Genie One "just in case" (the reported bug — a spurious connectivity
  // probe before an institutional deck), adding latency and confusing the user.
  // Suppress them on such turns. A turn that DOES want data (possessive + data
  // noun, or a business-data noun) keeps them, even while making a deck — a
  // data-grounded deck is legitimate. A plain chat turn (no artifact intent)
  // always keeps them; the tool description handles the general-knowledge case.
  const dataIntent = cls ? cls.data : hasDataIntent(text)
  const artifactOnly = (deck || spreadsheet || image || document) && !dataIntent
  const suppressDataTools = artifactOnly
  return { deck, spreadsheet, pptxAdjust, image, document, suppressDataTools }
}

// The product's built-in capabilities, surfaced as read-only "system skills":
// they show up in the Skills tab (so every deployment ships them pre-listed,
// no seeding needed) and drive the ephemeral "skill active" badge when the
// router turns a capability on. These are NOT stored in the DB — their bodies
// live in code (DECK_POLICY/SPREADSHEET_POLICY/CHART_POLICY above); this is
// just their catalog metadata. `chart` is always-on (CHART_POLICY is always
// injected), so it isn't badged per-turn — only deck/spreadsheet are gated.
export const SYSTEM_SKILLS = [
  {
    name: 'deck-generation',
    title: 'Geração de apresentações',
    description:
      'Cria apresentações (decks de slides) a partir de um pedido, com design system e exportação .pptx.',
    cap: 'deck',
  },
  {
    name: 'spreadsheet-generation',
    title: 'Geração de planilhas',
    description:
      'Monta planilhas (.xlsx) com abas, tabelas, fórmulas e gráficos a partir de um pedido ou de dados da conversa.',
    cap: 'spreadsheet',
  },
  {
    name: 'chart-generation',
    title: 'Gráficos e destaques',
    description:
      'Insere gráficos e cartões de destaque na resposta a partir de dados reais da conversa.',
    cap: 'chart',
    alwaysOn: true,
  },
  {
    name: 'pptx-adjust',
    title: 'Ajuste de apresentação',
    description:
      'Reestrutura um .pptx anexado no design system selecionado, preservando o conteúdo e a intenção de cada slide.',
    cap: 'pptxAdjust',
  },
  {
    name: 'image-generation',
    title: 'Geração de imagens',
    description:
      'Gera imagens a partir de uma descrição (text-to-image) e as exibe inline na conversa.',
    cap: 'image',
  },
  {
    name: 'document-generation',
    title: 'Geração de documentos',
    description:
      'Escreve documentos de texto (relatórios, artigos, cartas) em markdown, com edição por IA e exportação DOCX/Markdown/PDF.',
    cap: 'document',
  },
]

// Maps the detectCapabilities() result to badge-shaped system skills for the
// turn — the deck/spreadsheet capabilities that were actually turned on. Used
// to emit the `skill_active` SSE event so built-in capabilities light up the
// same ephemeral badge as authored skills. Chart is excluded (always on → not
// a meaningful per-turn signal).
export function activeSystemSkills(caps) {
  if (!caps) return []
  return SYSTEM_SKILLS.filter((s) => !s.alwaysOn && caps[s.cap]).map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
  }))
}

export function buildBlocksInstruction(candidates, template, caps) {
  // default to all-on so any caller that doesn't pass caps keeps the original
  // (always-include-everything) behavior — the gating is strictly opt-in.
  const c = caps || { deck: true, spreadsheet: true }

  let out
  if (!candidates?.length) {
    out = CHART_POLICY + NO_CANDIDATES_INSTRUCTION
  } else {
    out =
      CHART_POLICY +
      '\nVocê tem acesso a dados reais pré-calculados para visualização. Quando algum deles ' +
      'ilustrar bem um trecho da sua resposta, insira o bloco logo APÓS o parágrafo relacionado ' +
      '(não junte todos no final da mensagem — cada um deve ficar próximo do trecho que comenta), ' +
      'em sua própria linha, neste formato:\n' +
      '```prism-block\n{"type":"chart","ref":"candidate_1","caption":"legenda curta"}\n```\n' +
      'Se você tiver dados reais desta conversa que NÃO estão na lista de candidatos abaixo (ex.: ' +
      'resultado de uma tool), use o modo de dados em linha descrito acima (chartType + series→data→' +
      '{label,value}) — nunca invente um "ref" para um candidato inexistente.\n' +
      'Para destacar um achado importante (sem gráfico), use:\n' +
      '```prism-block\n{"type":"insight","title":"...","body":"..."}\n```\n' +
      'Regras: "ref" apenas com os IDs abaixo (nunca invente dados de gráfico); no máximo 12 blocos ' +
      'no total — se o usuário pediu um relatório com várias seções/métricas, é esperado usar um ' +
      'bloco por seção, não apenas 1 ou 2; posicione cada um imediatamente após o trecho de texto ' +
      'que ele ilustra; omita blocos se nenhum candidato for realmente útil para aquele trecho.' +
      '\n\nCandidatos disponíveis:\n' +
      candidatesText(candidates)
  }

  // heavy, capability-specific policies — included only when the turn is
  // plausibly about that capability. Order preserved from the original
  // (DECK, then SPREADSHEET, then the deck templateHint) for byte-stability
  // when both are on, which also keeps the prompt-cache prefix stable.
  if (c.deck) {
    // Decks are always generated by the pure-HTML engine (the model writes
    // flowing <section> HTML). DECK_POLICY carries Etapa 1 (the shared
    // deck-questions flow + "when to enter deck mode"); DECK_HTML_POLICY carries
    // Etapa 2 (the flowing-HTML generation contract) plus the DS style examples.
    out += DECK_POLICY
    out += DECK_HTML_POLICY + '\n\n' + buildDsStyleContract(template)
  }
  if (c.spreadsheet) out += SPREADSHEET_POLICY
  if (c.image) out += IMAGE_POLICY
  if (c.document) out += DOCUMENT_POLICY
  // Grounding: a deck or document with wrong figures loses all credibility no
  // matter how polished. When one of those is in play, reinforce that any
  // current/factual number must come from web_search (when available) and carry
  // its source — appended after the policies so it's the freshest instruction.
  if (c.deck || c.document) out += groundingDirective()
  if (c.deck) out += templateHint(template)
  return out
}

// Reinforces grounding for the artifacts where a wrong number is most damaging
// (deck/document). The instruction is TOOL-AWARE: it may only tell the model to
// call `web_search` when that tool is actually registered for the turn — i.e.
// when an admin configured a backing connection (WEB_SEARCH_CONNECTION). If it
// isn't, mentioning the tool would make the model emit a call to a tool that
// doesn't exist, which breaks the turn (observed). So without a connection we
// fall back to a directive that only requires marking unconfirmed figures as
// estimates — never invoking a phantom tool. This stays forward-compatible: the
// day web search ships as a deploy-time UC-function-backed connection, setting
// WEB_SEARCH_CONNECTION flips the directive back to the grounded variant with
// no code change here.
function groundingDirective() {
  const header = '\n\n=== DADOS REAIS E FONTES (apresentações e documentos) ===\n'
  const preamble =
    'Este artefato precisa ser factualmente correto. Para QUALQUER número, estatística, cotação, ' +
    'data ou fato que dependa do mundo real atual (ex.: taxas, índices, resultados, market share, ' +
    'notícias recentes), NÃO estime de memória sem sinalizar. '
  const markAsEstimate =
    'Se você não tiver como confirmar um número, diga explicitamente que é uma estimativa/ordem de ' +
    'grandeza em vez de apresentá-lo como fato — nunca invente precisão que você não tem.'
  // A tool NATIVA de busca está desativada nesse primeiro momento (ver tools.js):
  // a busca na internet, quando disponível, vem de um MCP externo que o admin
  // conectar. A diretiva abaixo é neutra — não presume nem promete uma tool
  // específica: instrui a confirmar com qualquer ferramenta de busca/navegação
  // oferecida no turno e, na ausência dela, a sinalizar estimativa.
  //
  // Ramo nativo mantido comentado para reativação (junto com o bloco em tools.js):
  // if (webSearchConfigured()) {
  //   return (
  //     header + preamble +
  //     'Use `web_search` para localizar fontes e `web_fetch` para ler e confirmar o conteúdo da página original. ' +
  //     'Cite a fonte e a data ao lado do dado. ' + markAsEstimate
  //   )
  // }
  return (
    header +
    preamble +
    'Se esta conversa tiver alguma ferramenta de busca ou navegação na web disponível (por exemplo, ' +
    'uma conexão MCP externa de busca), use-a para localizar e confirmar as fontes e cite a fonte e a ' +
    'data ao lado do dado (nota de rodapé, legenda de gráfico ou entre parênteses no texto). ' +
    markAsEstimate
  )
}

function candidatesText(candidates) {
  return candidates.map((c) => `- ${c.id} (${c.chartType}): "${c.title}"`).join('\n')
}

// Appended to a tool result's model-facing content (never the chip shown to
// the user) right after a Genie call returns query data — tells the model
// these new candidate ids exist so a prism-block referencing them actually
// resolves, without re-sending the whole chart policy on every round.
export function buildNewCandidatesHint(newCandidates) {
  if (!newCandidates?.length) return ''
  return (
    '\n\n[Novos candidatos de gráfico disponíveis a partir deste resultado — se forem úteis, ' +
    'use o bloco ```prism-block já descrito, com um destes IDs em "ref":]\n' +
    candidatesText(newCandidates)
  )
}


// Coerces the alternate chart shapes a model tends to improvise into the one
// canonical shape sanitizeChartSeries expects (series→data→{label,value}).
// Chart.js/Plotly-flavored `{labels:[...], series:[{values:[...]}]}` is the
// most common drift (it's what leaked as a raw code block before inline charts
// were allowed) — parallel `labels`+`values` arrays are zipped back into
// {label,value} points. Returns raw untouched when it's already the canonical
// array of series, so the normal path is unaffected.
function normalizeChartSeries(raw, container) {
  if (Array.isArray(raw) && raw.every((s) => s && Array.isArray(s.data))) return raw
  // labels can sit on the chart-level `data` object or alongside the series
  const labels = Array.isArray(container?.labels)
    ? container.labels
    : Array.isArray(container?.data?.labels)
      ? container.data.labels
      : null
  // series may be raw itself, or nested under a `data` wrapper (data.series)
  const seriesList = Array.isArray(raw)
    ? raw
    : Array.isArray(container?.data?.series)
      ? container.data.series
      : null
  if (!Array.isArray(seriesList)) return raw
  return seriesList.map((s, si) => {
    if (s && Array.isArray(s.data)) return s // already canonical points
    const values = Array.isArray(s?.values) ? s.values : Array.isArray(s?.data) ? s.data : null
    if (!Array.isArray(values)) return s
    const data = values.map((v, i) => ({
      label: labels && labels[i] != null ? String(labels[i]) : String(i + 1),
      value: v,
    }))
    return { name: typeof s?.name === 'string' ? s.name : `Série ${si + 1}`, data }
  })
}

// Validates an already-resolved chart series (either freshly baked from a
// trusted candidate, or round-tripped through a Studio edit) — same shape as
// the candidates in server/analysis.js: [{name, data:[{label, value}]}].
function sanitizeChartSeries(raw) {
  if (!Array.isArray(raw)) return null
  const series = raw
    .slice(0, 6)
    .map((s) => {
      if (!s || typeof s.name !== 'string' || !Array.isArray(s.data)) return null
      const data = s.data.slice(0, 30).map((d) => ({
        label: String(d?.label ?? '').slice(0, 60),
        value: typeof d?.value === 'number' ? d.value : Number(d?.value) || 0,
      }))
      return { name: s.name.slice(0, 60), data }
    })
    .filter(Boolean)
  return series.length ? series : null
}




// --- element-canvas validation (freeform slides) -----------------------------











function sanitizeDeckQuestion(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null
  if (typeof raw.label !== 'string' || !raw.label.trim()) return null
  const type = DECK_QUESTION_TYPES.has(raw.type) ? raw.type : 'text'
  const q = { id: raw.id.slice(0, 40), label: raw.label.slice(0, 200), type }
  if (typeof raw.description === 'string' && raw.description.trim()) q.description = raw.description.slice(0, 240)
  if (type !== 'text') {
    const options = Array.isArray(raw.options)
      ? raw.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, MAX_QUESTION_OPTIONS).map((o) => o.slice(0, 80))
      : []
    if (!options.length) return null
    q.options = options
  }
  return q
}

// Sanitizes a model-authored `deck-questions` block (see DECK_POLICY) — the
// clarifying-questions step that always precedes a fresh `deck` block.
function sanitizeDeckQuestions(raw) {
  if (!raw || !Array.isArray(raw.questions)) return null
  const questions = raw.questions.slice(0, MAX_DECK_QUESTIONS).map(sanitizeDeckQuestion).filter(Boolean)
  if (!questions.length) return null
  const out = { questions }
  if (typeof raw.intro === 'string' && raw.intro.trim()) out.intro = raw.intro.slice(0, 400)
  // answers are persisted into the block once the user submits (so the box
  // shows the history on reload and stays editable) — carry them through
  // sanitize too, keyed by question id. Values: string | string[].
  const answers = sanitizeQuestionAnswers(raw.answers, questions)
  if (answers) {
    out.answers = answers
    if (typeof raw.answeredAt === 'string') out.answeredAt = raw.answeredAt.slice(0, 40)
  }
  return out
}

// Coerces a client/model-supplied answers map to a safe shape: only keys that
// are real question ids, values trimmed strings (or string arrays for multi).
export function sanitizeQuestionAnswers(raw, questions) {
  if (!raw || typeof raw !== 'object') return null
  const byId = new Map(questions.map((q) => [q.id, q]))
  const out = {}
  for (const [qid, val] of Object.entries(raw)) {
    const q = byId.get(qid)
    if (!q) continue
    if (q.type === 'multi') {
      const arr = (Array.isArray(val) ? val : [val])
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v) => v.slice(0, 200))
      if (arr.length) out[qid] = arr
    } else if (typeof val === 'string' && val.trim()) {
      out[qid] = val.slice(0, 500)
    }
  }
  return Object.keys(out).length ? out : null
}

// ---- spreadsheet blocks ---------------------------------------------------
// A `spreadsheet` block is the tabular sibling of a `deck`: the model authors
// a workbook spec (sheets → ordered blocks of title/note/section/table +
// native charts), we sanitize the SHAPE here, persist it (chat_spreadsheets),
// and render a real .xlsx on export (server/xlsx-export.js). Numbers/formulas
// are model/user-authored (SPREADSHEET_POLICY governs honesty); this only
// bounds shape and validates that formulas/charts reference real cells.
const MAX_SS_SHEETS = 8
const MAX_SS_BLOCKS = 24
const MAX_SS_COLS = 20
const MAX_SS_ROWS = 500
const MAX_SS_CHARTS = 6
const SS_COL_FORMATS = new Set([
  'text', 'number', 'integer', 'currency', 'usd', 'eur', 'percent', 'percent0', 'date', 'datetime',
])
const SS_CELL_ROLES = new Set(['input', 'key', 'formula', 'link', 'normal'])
const SS_BLOCK_KINDS = new Set(['title', 'note', 'section', 'table', 'spacer'])
const SS_CHART_KINDS = new Set(['bar', 'line', 'area', 'pie'])
// Excel sheet-name rules: ≤31 chars, no []:*?/\ — and unique per workbook.
function sanitizeSheetName(raw, used, idx) {
  let name = typeof raw === 'string' ? raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) : ''
  if (!name) name = `Planilha ${idx + 1}`
  let candidate = name
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${n++}`
    candidate = name.slice(0, 31 - suffix.length) + suffix
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function sanitizeSsColumn(raw) {
  if (!raw || typeof raw !== 'object') return null
  const col = { header: typeof raw.header === 'string' ? raw.header.slice(0, 80) : '' }
  if (typeof raw.key === 'string' && raw.key.trim()) col.key = raw.key.slice(0, 40)
  if (SS_COL_FORMATS.has(raw.format)) col.format = raw.format
  else if (typeof raw.format === 'string' && /[#0%@]|[ymdhs]/.test(raw.format)) col.format = raw.format.slice(0, 40)
  if (SS_CELL_ROLES.has(raw.role)) col.role = raw.role
  const w = Number(raw.width)
  if (Number.isFinite(w) && w > 0) col.width = Math.min(80, Math.max(4, Math.round(w)))
  if (Array.isArray(raw.dropdown)) {
    const opts = raw.dropdown.filter((o) => o != null && String(o).trim()).slice(0, 40).map((o) => String(o).slice(0, 60))
    if (opts.length) col.dropdown = opts
  }
  return col
}

// A cell is a scalar, a "=formula" string, or {v, role?, format?}. Formulas are
// kept verbatim (Excel evaluates them); we only cap length and strip nothing
// that would change semantics. Non-formula strings are length-capped.
function sanitizeSsCell(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const cell = {}
    const inner = sanitizeSsCell(raw.v)
    cell.v = inner === undefined ? '' : inner
    if (SS_CELL_ROLES.has(raw.role)) cell.role = raw.role
    if (SS_COL_FORMATS.has(raw.format)) cell.format = raw.format
    // a stable NAME the renderer registers so other formulas can reference this
    // exact cell by [#name] regardless of where it lands in the grid
    if (typeof raw.name === 'string' && raw.name.trim()) cell.name = raw.name.trim().slice(0, 60)
    return cell
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    if (raw[0] === '=') return raw.slice(0, 500) // formula, verbatim
    return raw.slice(0, 500)
  }
  return null
}

function sanitizeSsBlock(raw) {
  if (!raw || !SS_BLOCK_KINDS.has(raw.kind)) return null
  if (raw.kind === 'spacer') return { kind: 'spacer' }
  if (raw.kind === 'title' || raw.kind === 'note' || raw.kind === 'section') {
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 200) : ''
    if (!text) return null
    return { kind: raw.kind, text }
  }
  // table
  const columns = (Array.isArray(raw.columns) ? raw.columns : []).slice(0, MAX_SS_COLS).map(sanitizeSsColumn).filter(Boolean)
  if (!columns.length) return null
  const colCount = columns.length
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, MAX_SS_ROWS).map((row) => {
    const arr = Array.isArray(row) ? row : columns.map((col) => (col.key ? row?.[col.key] : undefined))
    const cells = []
    for (let c = 0; c < colCount; c++) cells.push(sanitizeSsCell(arr[c]))
    return cells
  })
  const block = { kind: 'table', columns, rows }
  if (raw.headerless === true) block.headerless = true
  return block
}

function sanitizeSsChart(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = SS_CHART_KINDS.has(raw.kind) ? raw.kind : 'bar'
  const tableBlock = Number(raw.tableBlock)
  const categoryColumn = Number(raw.categoryColumn)
  if (!Number.isInteger(tableBlock) || tableBlock < 0) return null
  if (!Number.isInteger(categoryColumn) || categoryColumn < 0) return null
  const valueColumns = (Array.isArray(raw.valueColumns) ? raw.valueColumns : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, 6)
  if (!valueColumns.length) return null
  const chart = { kind, tableBlock, categoryColumn, valueColumns }
  if (typeof raw.title === 'string' && raw.title.trim()) chart.title = raw.title.slice(0, 120)
  if (raw.anchor && typeof raw.anchor === 'object') {
    const col = Number(raw.anchor.col)
    const row = Number(raw.anchor.row)
    if (Number.isInteger(col) && col >= 0 && Number.isInteger(row) && row >= 0) chart.anchor = { col, row }
  }
  return chart
}

// Validates a chart references a table block that exists in its sheet, and
// that its columns are within that table's column count — a chart can never
// point at cells that don't exist (mirrors the deck data-honesty invariant).
function pruneSheetCharts(sheet) {
  if (!sheet.charts?.length) return
  const tableIdx = sheet.blocks.map((b, i) => (b.kind === 'table' ? i : -1)).filter((i) => i >= 0)
  sheet.charts = sheet.charts.filter((ch) => {
    if (!tableIdx.includes(ch.tableBlock)) return false
    const table = sheet.blocks[ch.tableBlock]
    const cols = table.columns.length
    if (ch.categoryColumn >= cols) return false
    ch.valueColumns = ch.valueColumns.filter((c) => c < cols && c !== ch.categoryColumn)
    return ch.valueColumns.length > 0
  })
  if (!sheet.charts.length) delete sheet.charts
}

export function sanitizeSpreadsheet(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sheets)) return null
  const used = new Set()
  const sheets = raw.sheets
    .slice(0, MAX_SS_SHEETS)
    .map((s, i) => {
      if (!s || typeof s !== 'object') return null
      const blocks = (Array.isArray(s.blocks) ? s.blocks : []).slice(0, MAX_SS_BLOCKS).map(sanitizeSsBlock).filter(Boolean)
      if (!blocks.length) return null
      const sheet = { name: sanitizeSheetName(s.name, used, i), blocks }
      if (typeof s.purpose === 'string' && s.purpose.trim()) sheet.purpose = s.purpose.trim().slice(0, 200)
      if (s.freeze && typeof s.freeze === 'object') {
        const row = Number(s.freeze.row)
        const col = Number(s.freeze.col)
        sheet.freeze = {
          row: Number.isInteger(row) && row >= 0 ? row : 0,
          col: Number.isInteger(col) && col >= 0 ? col : 0,
        }
      }
      const charts = (Array.isArray(s.charts) ? s.charts : []).slice(0, MAX_SS_CHARTS).map(sanitizeSsChart).filter(Boolean)
      if (charts.length) sheet.charts = charts
      pruneSheetCharts(sheet)
      return sheet
    })
    .filter(Boolean)
  if (!sheets.length) return null
  const out = { title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 160) : 'Planilha', sheets }
  if (Array.isArray(raw.instructions)) {
    const lines = raw.instructions.filter((l) => typeof l === 'string' && l.trim()).slice(0, 12).map((l) => l.trim().slice(0, 300))
    if (lines.length) out.instructions = lines
  }
  return out
}

// A `document` block: a markdown document the model authors directly (no
// external data). The Studio renders it as rich text, lets the user tweak it
// with AI, and exports to DOCX/Markdown/PDF (see server/index.js + db chat_documents).
export function sanitizeDocument(raw) {
  if (!raw || typeof raw !== 'object') return null
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : typeof raw.content === 'string' ? raw.content : ''
  if (!markdown.trim()) return null
  const title =
    typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 200)
      : // fall back to the first markdown heading, else a generic title
        (markdown.match(/^#{1,3}\s+(.+)$/m)?.[1] || 'Documento').trim().slice(0, 200)
  // cap at ~200k chars — a very long report, but bounded so one block can't be
  // unbounded. Longer content is truncated with a visible marker.
  const MAX = 200_000
  const md = markdown.length > MAX ? markdown.slice(0, MAX) + '\n\n<!-- truncado -->' : markdown
  return { title, markdown: md }
}

function resolveOne(raw, byId, template, imageById) {
  if (!raw || !ALLOWED_TYPES.has(raw.type)) return null
  if (raw.type === 'document') {
    const doc = sanitizeDocument(raw)
    if (!doc) return null
    return { type: 'document', title: doc.title, markdown: doc.markdown }
  }
  if (raw.type === 'image') {
    // The image itself was generated by the image tool and persisted to the
    // Volume (server/tools.js). The model only references it by the `imageRef`
    // it was handed; we resolve that to the real image id so the client can
    // fetch GET /api/images/:id. An unknown ref → drop the block (never invent).
    if (!imageById) return null
    const ref = typeof raw.imageRef === 'string' ? raw.imageRef.trim() : ''
    const hit = ref ? imageById.get(ref) : null
    if (!hit) return null
    return {
      type: 'image',
      imageId: String(hit.imageId),
      prompt: typeof hit.prompt === 'string' ? hit.prompt.slice(0, 500) : undefined,
      caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 200) : undefined,
      alt: typeof raw.alt === 'string' ? raw.alt.slice(0, 200) : undefined,
      // generation model + token usage → the block can show a cost estimate
      model: typeof hit.model === 'string' ? hit.model : undefined,
      usage: hit.usage || undefined,
    }
  }
  if (raw.type === 'deck-html') {
    const deck = sanitizeHtmlDeck(raw)
    if (!deck) return null
    return { type: 'deck-html', ...deck }
  }
  if (raw.type === 'deck-questions') {
    const dq = sanitizeDeckQuestions(raw)
    if (!dq) return null
    return { type: 'deck-questions', intro: dq.intro, questions: dq.questions }
  }
  if (raw.type === 'spreadsheet') {
    const ss = sanitizeSpreadsheet(raw)
    if (!ss) return null
    return { type: 'spreadsheet', ...ss }
  }
  if (raw.type === 'chart') {
    // Mode 1: a reference to a deterministic, pre-computed candidate (numbers
    // already validated upstream in analysis.js). Preferred whenever one exists.
    // `chartRef` is accepted as an alias — models drift to it and it should
    // resolve, not silently drop.
    const ref = typeof raw.ref === 'string' ? raw.ref : typeof raw.chartRef === 'string' ? raw.chartRef : undefined
    const cand = ref ? byId.get(ref) : undefined
    if (cand) {
      return {
        type: 'chart',
        chartType: cand.chartType,
        title: cand.title,
        series: cand.series,
        caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 200) : undefined,
      }
    }
    // Mode 2: inline series the model supplies itself — the only path when the
    // data came from a tool (Genie One, Python) or figures already in the
    // conversation, for which no candidate_N exists. Without this, a model
    // asked to plot real tool data had no valid block to emit and would leak an
    // invented JSON shape as a raw code block (the exact bug this fixes). Data
    // honesty is a prompt rule (CHART_POLICY); here we only validate the shape.
    const series = sanitizeChartSeries(normalizeChartSeries(raw.series, raw))
    if (series && ['bar', 'line', 'area', 'pie'].includes(raw.chartType)) {
      return {
        type: 'chart',
        chartType: raw.chartType,
        title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : undefined,
        series,
        caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 200) : undefined,
      }
    }
    return null
  }
  if (raw.type === 'insight') {
    if (!raw.title || !raw.body) return null
    return {
      type: 'insight',
      title: String(raw.title).slice(0, 120),
      body: String(raw.body).slice(0, 800),
      kind: ['summary', 'anomaly', 'opportunity'].includes(raw.kind) ? raw.kind : 'summary',
    }
  }
  if (raw.type === 'table') {
    if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null
    return {
      type: 'table',
      title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : undefined,
      columns: raw.columns.slice(0, 12).map(String),
      rows: raw.rows.slice(0, 50),
    }
  }
  return null
}

/**
 * Replaces every inline ```prism-block fence in the model's answer with a
 * `{{block:N}}` placeholder (or drops it silently if malformed/unresolvable),
 * returning the placeholder-bearing text plus the ordered, resolved blocks.
 * This is the exact shape persisted to the DB and sent to the frontend.
 */
export function extractPrismBlocks(fullText, chartCandidates = [], template, imageRefs = []) {
  const byId = new Map(chartCandidates.map((c) => [c.id, c]))
  // image refs the image tool produced this session, keyed by the `img_<id>`
  // ref the model was told to use (and its bare id, as a lenient alias).
  const imageById = new Map()
  for (const r of imageRefs || []) {
    if (r?.ref) imageById.set(r.ref, r)
    if (r?.imageId != null) imageById.set(String(r.imageId), r)
  }
  const blocks = []

  // Walk the text, replacing each prism-block fence with a {{block:N}} marker.
  // For each opener we scan the JSON by brace balance (``` -agnostic), then skip
  // past the JSON and its optional closing ``` fence. Rebuilt as a string so a
  // block's own ``` (fenced code inside a document's markdown) can't truncate it.
  let out = ''
  let cursor = 0
  FENCE_OPEN_RE.lastIndex = 0
  let m
  while ((m = FENCE_OPEN_RE.exec(fullText)) !== null) {
    const scanned = scanJsonObject(fullText, m.index + m[0].length)
    // no balanced object after the opener (truncated / malformed): drop from the
    // opener to the end of text so raw JSON never leaks, and stop.
    if (!scanned) {
      out += fullText.slice(cursor, m.index)
      cursor = fullText.length
      break
    }
    // text before this fence is kept as-is
    out += fullText.slice(cursor, m.index)
    // advance past the JSON, then past an optional closing ``` (with surrounding
    // whitespace/newlines) so the fence's tail doesn't linger in the output
    let after = scanned.end
    const tail = fullText.slice(after).match(/^[ \t]*\r?\n?```/)
    if (tail) after += tail[0].length
    // Models sometimes emit a stray run of JSON structural punctuation (e.g. an
    // extra `]}` that over-closes the slides array) right after the fence. Real
    // prose is never only brackets/braces/commas, so drop such an orphan up to
    // the next newline — otherwise it leaks into the chat as "]}" (see #12/#13).
    const orphan = fullText.slice(after).match(/^[ \t]*[\]})\s,]*[\]})][ \t]*(?=\r?\n|$)/)
    if (orphan) after += orphan[0].length
    cursor = after

    if (blocks.length >= MAX_BLOCKS) continue
    let parsed
    try {
      parsed = JSON.parse(scanned.json)
    } catch {
      continue // malformed JSON — degrade to plain text, no block
    }
    const resolved = resolveOne(parsed, byId, template, imageById)
    if (!resolved) continue
    blocks.push(resolved)
    out += `\n\n{{block:${blocks.length - 1}}}\n\n`
  }
  out += fullText.slice(cursor)

  const content = out.replace(/\n{3,}/g, '\n\n').trim()

  return { content, blocks }
}

// Strips placeholders from a stored assistant message before it's replayed
// back to the model as conversation history — the model doesn't need (and
// could get confused trying to reproduce) its own past visualization/tool-call
// position markers.
export function stripBlockPlaceholders(text) {
  return text
    .replace(/\{\{block:\d+\}\}/g, '')
    .replace(/\{\{toolcall:[^}]+\}\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
