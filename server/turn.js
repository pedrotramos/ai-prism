// The chat turn: the three routes that produce an assistant answer (POST
// /api/chat, /api/sessions/:id/continue, /api/sessions/:id/messages/:messageId/
// regenerate) and everything they share — history windowing, tool resolution,
// the tool-calling loop (runAssistantTurn), notices, deck outline expansion and
// artifact persistence. Per-turn post-processing must run on all three routes:
// it lives once in prepareTurn/finishTurn, and a per-session lock
// (server/turnLock.js) lets only one turn run per session at a time.
import {
  createSession,
  getSession,
  updateSession,
  addMessage,
  listMessages,
  listMessagesBeforeMessage,
  addToolCalls,
  retrieveRelevantMessages,
  getSessionChartCandidates,
  saveSessionChartCandidates,
  getSelectedDeckTemplate,
  listUserMcpConnections,
  createDeck,
  createSpreadsheet,
  createDocument,
  getSelectedImageModel,
  getToolPolicy,
  insertCompaction,
} from './db.js'
import { modelById, streamChat, generateTitle, classifyIntent, INTENT_MODEL, embed } from './llm.js'
import { rebindUsageScope, setUsageSession, holdUsageUntilSession } from './usage.js'
import { extractText } from './files.js'
import { transcribe, isMediaFile, TranscriptionError, mediaModelName } from './transcribe.js'
import { ingestPptx, pptxDeckToBrief } from './pptxIngest.js'
import { analyzeSpreadsheet, isSpreadsheet } from './analysis.js'
import {
  buildBlocksInstruction,
  detectCapabilities,
  shouldClassifyIntent,
  activeSystemSkills,
  extractPrismBlocks,
  extractDeckOutline,
  stripBlockPlaceholders,
  buildNewCandidatesHint,
} from './blocks.js'
import { ensureBuiltinPythonTool, buildToolDefs, invokeTool } from './tools.js'
import { routeSkills, renderSkillsInstruction } from './skills.js'
import { makeSlideStreamScanner } from './deckHtmlStream.js'
import { generateDeckFromOutline } from './deckHtmlGenerate.js'
import { getMcpCatalog, getHiddenMcpNames } from './externalMcp.js'
import { prepareCompactedReplay, compactionContext, compactConversation } from './compaction.js'
import { appendToolRecap } from './toolRecap.js'
import { TOOL_SOURCE_ROUTING_POLICY, toolSourceRoutingEnabled, turnToolBudgetMs } from './toolRouting.js'
import { getUserModels, resolveModelId } from './models.js'
import { auth } from './middleware/auth.js'
import { ensureReady } from './middleware/ensureReady.js'
import { upload, fixFilename } from './middleware/index.js'
import { stripAttach, updateSessionEmbedding, indexSessionMessages } from './lib/embeddings.js'
import { openSse, makeSend } from './sse.js'
import { turnLock } from './turnLock.js'
import { logger } from './log.js'
import { trace, context, SpanStatusCode } from '@opentelemetry/api'
import { startSpan } from './telemetry.js'

const ATTACH_MARKER = '\n\n--- ANEXOS ---\n\n'

// Two-model media disclosure: audio/video is read by the media model (Gemini),
// then the user's chosen model writes the answer over that transcript. When the
// two differ, return { model, files } so the UI can attribute the media hop;
// null when nothing was media-processed or the same model did both. Chunk names
// ("… (parte K de N).wav" from browser segmentation) collapse to their source.
function computeMediaProcessing(mediaProcessedFiles, answeringModel, usageTotal) {
  if (!mediaProcessedFiles?.length) return null
  const mm = mediaModelName()
  if (!mm || mm === answeringModel) return null
  const files = [...new Set(mediaProcessedFiles.map((n) => n.replace(/ \(parte \d+ de \d+\)\.wav$/, '')))]
  const out = { model: mm, files }
  // token usage of the media-understanding step, so the UI can show its cost
  if (usageTotal?.any) {
    out.usage = { prompt_tokens: usageTotal.prompt_tokens, completion_tokens: usageTotal.completion_tokens }
  }
  return out
}

// Max prior messages replayed to the model per turn (see the window in
// /api/chat). Prompt caching reuses the stable prefix across tool rounds, but
// the prefix itself grows one turn at a time; without a cap a long thread
// reprocesses its entire history every turn. 40 messages ≈ 20 exchanges, well
// beyond the working context of a normal conversation, so it's invisible in
// practice while bounding worst-case latency/cost. The full history is still
// loaded for capability detection and block resolution — this caps only replay.
const MAX_HISTORY_MESSAGES = 40

// Replay of the tool records of older assistant turns (server/toolRecap.js). Off
// unless TOOL_RECAP=on: it adds tokens to every replayed tool turn.
const TOOL_RECAP_ENABLED = String(process.env.TOOL_RECAP || '').trim().toLowerCase() === 'on'

// Per-turn budget for tool time (server/toolRouting.js); 0 = off.
const TURN_TOOL_BUDGET_MS = turnToolBudgetMs()

// Semantic history retrieval (Perplexity-style): when a session is longer than
// the recency window, retrieve the most relevant OLDER messages by pgvector
// similarity and splice them in — so the model "remembers" a detail from 60
// turns ago without replaying all 60. Behind a flag (default off) for safe,
// A/B-able rollout. `RECENCY_KEEP` messages always go verbatim; up to
// RETRIEVE_TOP_N older ones are added when they clear the similarity floor.
const HISTORY_RETRIEVAL = process.env.HISTORY_RETRIEVAL === 'on'
const RECENCY_KEEP = 8
const RETRIEVE_TOP_N = 6
const RETRIEVE_MIN_SIMILARITY = 0.4

// Appends the recent conversation to `apiMessages`, capped at the last
// MAX_HISTORY_MESSAGES turns (see the constant). Starts the window on a user
// turn so the first replayed message isn't a dangling assistant reply, and
// strips {{block:N}} placeholders the model doesn't need echoed back. Shared by
// /api/chat, /continue and /regenerate so all three window identically.
//
// `retrieved` (optional): semantically-relevant OLDER messages fetched by
// pgvector when HISTORY_RETRIEVAL is on. They're injected as ONE compact system
// message right before the recency window — NOT interleaved as real turns — so
// (a) the model clearly sees them as recalled context, not the live thread, and
// (b) the stable system prefix / recency tail keep their shape for prompt
// caching. Any retrieved message already inside the recency window is dropped.
//
// `summary` (optional): the conversation compaction in force (server/compaction.js).
// `history` is then already the replay AFTER its anchor, and the summary goes in
// first as one system message standing in for everything before it.
// TOOL_RECAP=on also replays a bounded record of the tools each old assistant turn
// ran (server/toolRecap.js); off by default, so the replay is unchanged.
function pushWindowedHistory(apiMessages, history, retrieved = [], summary = null) {
  if (summary) apiMessages.push({ role: 'system', content: compactionContext(summary) })
  let windowed = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history
  if (windowed.length && windowed.length < history.length && windowed[0].role !== 'user') {
    const firstUser = windowed.findIndex((m) => m.role === 'user')
    if (firstUser > 0) windowed = windowed.slice(firstUser)
  }
  if (retrieved.length) {
    const inWindow = new Set(windowed.map((m) => String(m.id)))
    const fresh = retrieved.filter((m) => !inWindow.has(String(m.id)))
    if (fresh.length) {
      const recalled = fresh
        .map((m) => `[${m.role === 'user' ? 'Usuário' : 'Assistente'}]: ${stripBlockPlaceholders(stripAttach(m.content)).slice(0, 800)}`)
        .join('\n\n')
      apiMessages.push({
        role: 'system',
        content:
          'Trechos relevantes de mais cedo NESTA conversa (recuperados por similaridade — ' +
          'use-os como memória do que já foi dito, sem repeti-los literalmente):\n\n' +
          recalled,
      })
    }
  }
  for (const m of windowed) {
    const content = stripBlockPlaceholders(m.content)
    apiMessages.push({
      role: m.role,
      content: TOOL_RECAP_ENABLED ? appendToolRecap(content, m.role, m.tool_calls, m.id) : content,
    })
  }
}

// Attaches image data-URLs to the CURRENT user turn as vision input, so a
// vision-capable model actually sees a pasted/attached image (the AI Gateway
// accepts the OpenAI multimodal shape: content = [{type:'text'}, {type:
// 'image_url', image_url:{url:'data:...'}}]). Rewrites the LAST user message in
// apiMessages (the turn being answered) from a plain string into that array.
// No-op when there are no images. Kept out of persisted content — the DB row
// stores only text + the attachment names (bytes aren't re-sent on reload).
export function attachImagesToLastUserTurn(apiMessages, images) {
  if (!images?.length) return
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    if (apiMessages[i].role !== 'user') continue
    const text = typeof apiMessages[i].content === 'string' ? apiMessages[i].content : ''
    apiMessages[i] = {
      role: 'user',
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
      ],
    }
    return
  }
}

// Fetches semantically-relevant older messages for this turn when
// HISTORY_RETRIEVAL is on and the session is longer than the recency window.
// Best-effort: any failure (embed/DB) returns [] so the turn proceeds on the
// recency window alone. `queryText` is the current user message (the retrieval
// query). Returns [] when the feature is off or there's nothing older to find.
async function retrieveHistoryContext(req, sessionId, history, queryText, signal) {
  if (!HISTORY_RETRIEVAL) return []
  if (history.length <= RECENCY_KEEP) return [] // nothing older than the window
  const q = String(queryText || '').trim()
  if (q.length < 3) return []
  try {
    const [qvec] = await embed(
      req.token,
      [`Instruct: Dada a mensagem atual do usuário, recupere trechos relevantes da conversa.\nQuery: ${q}`],
      { signal }
    )
    if (!qvec) return []
    return await retrieveRelevantMessages(req.email, req.token, sessionId, qvec, {
      topN: RETRIEVE_TOP_N,
      excludeRecent: RECENCY_KEEP,
      minSimilarity: RETRIEVE_MIN_SIMILARITY,
    })
  } catch (e) {
    logger.warn('history retrieval failed', { err: e })
    return []
  }
}

// Built-in Python tool provisioning failing (no SQL_WAREHOUSE_ID, no CREATE
// FUNCTION grant, token without the `sql` scope, warehouse down…) must only
// cost us the Python tool — never the user's Genie/UC/Vector/MCP tools. The
// failure is remembered with a cooldown instead of a permanent latch, because
// it can be per-token (scope) or transient rather than a property of the
// environment.
const TOOLS_RETRY_MS = 5 * 60 * 1000
let toolsState = { ready: false, error: null, lastAttempt: 0 }
async function ensureTools(req) {
  if (toolsState.ready) return toolsState
  if (Date.now() - toolsState.lastAttempt < TOOLS_RETRY_MS) return toolsState
  toolsState.lastAttempt = Date.now()
  try {
    await ensureBuiltinPythonTool(req.token)
    toolsState.ready = true
    toolsState.error = null
  } catch (e) {
    toolsState.error = e.message
    logger.warn('python tool setup failed, continuing without it', { err: e })
  }
  return toolsState
}

// Injected as a system message whenever a turn has tools available. Two goals:
// (1) the user should never see a silent gap where the assistant "froze" while
// deciding on / running a tool — so the model narrates a short line BEFORE each
// tool call, which the server already streams as it arrives (result.content in
// runAssistantTurn); (2) that narration doubles as an explanation of the
// reasoning ("vou consultar o Genie para trazer os números reais…"), so the
// tool-call chips read as a coherent train of thought, not a black box.
// The narration policy + (when MCP servers are connected) the per-turn guide of
// what each server is for — one system message, right after the history.
const withToolGuide = (policy, guide) => (guide ? `${policy}\n\n${guide}` : policy)

const TOOL_NARRATION_POLICY =
  'Uso de ferramentas (tools): você tem ferramentas disponíveis (ex.: Genie/Genie One para ' +
  'consultar dados, Python para cálculos). SEMPRE que for chamar uma ferramenta, escreva ANTES ' +
  'uma frase curta em linguagem natural dizendo O QUE vai fazer e POR QUÊ (ex.: "Vou consultar o ' +
  'Genie One para trazer a receita mês a mês direto do banco." ou "Deixa eu calcular a projeção ' +
  'em Python com essas premissas."). Isso vale para CADA chamada, inclusive as intermediárias ' +
  'entre uma ferramenta e outra — o usuário acompanha seu raciocínio em tempo real e não pode ' +
  'ficar sem nenhum sinal enquanto você trabalha. Seja conciso (uma frase por chamada, sem ' +
  'repetir a mesma frase), e ao terminar de usar as ferramentas, entregue a resposta/artefato ' +
  'final normalmente. IMPORTANTE: essa frase de narração E qualquer comentário inicial de código ' +
  '(que vira o rótulo do passo na interface) devem estar SEMPRE no mesmo idioma do usuário — nunca ' +
  'em inglês quando o usuário está em português/espanhol.\n' +
  'NÃO chame ferramenta alguma para o que você já sabe responder: conhecimento geral, história, ' +
  'definições, tradução, redação, matemática simples e afins são respondidos DIRETAMENTE, sem tool. ' +
  'Ferramentas de dados (Genie/Genie One) são só para os DADOS internos do workspace do usuário; ' +
  'usá-las para uma pergunta de conhecimento geral (ex.: "Quem descobriu o Brasil?") é um erro.\n' +
  'Faça APENAS o que o usuário pediu, com a ferramenta CERTA para o pedido — uma vez. NÃO produza ' +
  'artefatos que o usuário não pediu: se ele pediu uma imagem, gere só a imagem; NÃO crie também ' +
  'um documento, um deck ou uma planilha "de brinde". E se uma ferramenta FALHAR (ex.: a geração de ' +
  'imagem retornar erro), NÃO tente compensar produzindo um artefato de OUTRO tipo (ex.: um ' +
  'documento descrevendo a imagem que não saiu) — isso não é o que o usuário quer. Em caso de falha, ' +
  'explique em uma frase o que deu errado e pare; não substitua o pedido por outra coisa nem repita ' +
  'a mesma ferramenta na esperança de um resultado diferente.\n' +
  'QUANDO FALTAR INFORMAÇÃO PARA USAR A FERRAMENTA, PERGUNTE AO USUÁRIO — não invente. Se você não ' +
  'tem um dado obrigatório para chamar a ferramenta (ex.: QUAL sala/tabela do Genie consultar, o ' +
  'período, a moeda, quais premissas usar num cálculo), ou se a ferramenta voltou VAZIA/ambígua e há ' +
  'mais de um caminho razoável, faça UMA pergunta objetiva e curta em vez de chutar um valor, ' +
  'escolher uma fonte ao acaso ou responder com um palpite disfarçado de fato. Prefira perguntar a ' +
  'entregar um resultado que pode estar errado. Só siga sem perguntar quando houver um padrão claro ' +
  'e seguro (então ASSUMA esse padrão e DIGA em uma frase o que assumiu, para o usuário corrigir se ' +
  'quiser). Uma pergunta bem feita vale mais que um número inventado — nunca apresente um dado que ' +
  'você não obteve de uma ferramenta ou do usuário como se fosse real.'

// Tool-use policy for tool-enabled turns: the narration rules, plus the
// source-routing addendum when TOOL_SOURCE_ROUTING=on (server/toolRouting.js).
// Defined after TOOL_NARRATION_POLICY (a const; referencing it earlier would throw).
const TOOL_POLICY = toolSourceRoutingEnabled()
  ? `${TOOL_NARRATION_POLICY}\n${TOOL_SOURCE_ROUTING_POLICY}`
  : TOOL_NARRATION_POLICY

// Forced response-language directive (from the user's Preferences). Injected as
// the LAST system message of the turn — closest to the user's message, so it
// wins over the many PT-authored policy blocks and the user's own language.
// 'auto' → null (the model naturally mirrors the user's language). Emphatic on
// purpose: a single soft line at the top of the prompt loses to volume+recency.
// Wording matters a lot here: a soft "responda em X" is ignored when the user
// writes in another language. What reliably works (tested against the gateway)
// is an imperative that (a) names the target language, (b) explicitly forbids
// the others, and (c) covers the "even if the user writes in Y" case.
const RESPONSE_LANG_DIRECTIVE = {
  pt: 'VOCÊ DEVE escrever TODA a sua resposta em português do Brasil. NÃO use inglês nem espanhol. ' +
    'Mesmo que o usuário escreva em outro idioma, responda em português. Isso inclui títulos, listas, ' +
    'legendas e qualquer texto dentro de artefatos (apresentações, planilhas).',
  en: 'You MUST write your ENTIRE reply in English. Do NOT use Portuguese or Spanish. Even if the user ' +
    'writes in another language, answer in English. This includes titles, lists, captions, and any ' +
    'text inside artifacts (decks, spreadsheets).',
  es: 'DEBES escribir TODA tu respuesta en español. NO uses inglés ni portugués. Aunque el usuario ' +
    'escriba en otro idioma, responde en español. Esto incluye títulos, listas, leyendas y cualquier ' +
    'texto dentro de los artefactos (presentaciones, hojas de cálculo).',
}
function responseLangDirective(lang) {
  return RESPONSE_LANG_DIRECTIVE[lang] || null
}

// User-facing notices/errors composed by the SERVER, localized to the user's
// chosen response language. 'auto' (or any unknown value) falls back to pt —
// the app's authored default — so behavior is unchanged unless the user picked
// a specific language. Keep keys in sync across the three locales.
const SERVER_MESSAGES = {
  pt: {
    truncation:
      '⚠️ A resposta atingiu o limite de tokens de saída do modelo e chegou incompleta. ' +
      'Tente gerar novamente ou peça um conteúdo mais curto (ex.: um deck com menos slides).',
    stoppedLoop:
      'ℹ️ Encerrei as consultas porque o modelo estava repetindo a mesma chamada sem avançar. A ' +
      'resposta acima foi montada com os dados obtidos até então.',
    stoppedCeiling:
      'ℹ️ Esta tarefa exigiu muitos passos e atingi o limite de rodadas de ferramentas. A resposta ' +
      'acima usa os dados reunidos até aqui — se faltou algo, peça a continuação.',
    stoppedTime:
      'ℹ️ Atingi o tempo limite de consultas deste turno. A resposta acima usa os dados obtidos até ' +
      'aqui; o que faltou pode ser pedido em seguida, com uma nova mensagem.',
    imageWriteFailed: 'Falha ao gravar a imagem no Volume',
    imageReadFailed: 'Falha ao ler a imagem do Volume',
    imageEndpointFailed: 'O modelo de imagem retornou um erro',
    imageNoImage: 'O modelo não retornou nenhuma imagem.',
    imageBadDataUrl: 'data URL de imagem inválida',
    imageMissingScope:
      'O app não tem permissão para gravar imagens (falta o escopo OAuth "files"). ' +
      'Peça a um administrador para reimplantar o app com esse escopo e faça login novamente.',
  },
  en: {
    truncation:
      "⚠️ The reply hit the model's output token limit and came back incomplete. " +
      'Try again or ask for something shorter (e.g. a deck with fewer slides).',
    stoppedLoop:
      'ℹ️ I stopped querying because the model kept repeating the same call without progressing. ' +
      'The reply above was assembled from the data gathered so far.',
    stoppedCeiling:
      'ℹ️ This task needed many steps and hit the tool-round limit. The reply above uses the data ' +
      'gathered so far — if something is missing, ask me to continue.',
    stoppedTime:
      'ℹ️ I reached the time limit for queries in this turn. The reply above uses the data gathered so ' +
      'far; ask me to continue for anything missing.',
    imageWriteFailed: 'Failed to write the image to the Volume',
    imageReadFailed: 'Failed to read the image from the Volume',
    imageEndpointFailed: 'The image model returned an error',
    imageNoImage: 'The model returned no image.',
    imageBadDataUrl: 'invalid image data URL',
    imageMissingScope:
      'The app is not allowed to write images (missing the "files" OAuth scope). ' +
      'Ask an administrator to redeploy the app with that scope, then sign in again.',
  },
  es: {
    truncation:
      '⚠️ La respuesta alcanzó el límite de tokens de salida del modelo y llegó incompleta. ' +
      'Intenta de nuevo o pide algo más corto (p. ej. una presentación con menos diapositivas).',
    stoppedLoop:
      'ℹ️ Detuve las consultas porque el modelo repetía la misma llamada sin avanzar. La respuesta ' +
      'de arriba se armó con los datos obtenidos hasta entonces.',
    stoppedCeiling:
      'ℹ️ Esta tarea requirió muchos pasos y alcancé el límite de rondas de herramientas. La ' +
      'respuesta de arriba usa los datos reunidos — si falta algo, pídeme que continúe.',
    stoppedTime:
      'ℹ️ Alcancé el tiempo límite de consultas de este turno. La respuesta de arriba usa los datos ' +
      'obtenidos hasta aquí; pídeme que continúe si falta algo.',
    imageWriteFailed: 'No se pudo escribir la imagen en el Volume',
    imageReadFailed: 'No se pudo leer la imagen del Volume',
    imageEndpointFailed: 'El modelo de imagen devolvió un error',
    imageNoImage: 'El modelo no devolvió ninguna imagen.',
    imageBadDataUrl: 'URL de datos de imagen inválida',
    imageMissingScope:
      'La app no tiene permiso para escribir imágenes (falta el scope OAuth "files"). ' +
      'Pide a un administrador que vuelva a desplegar la app con ese scope e inicia sesión de nuevo.',
  },
}
function serverMsg(lang, key) {
  const cat = SERVER_MESSAGES[lang] || SERVER_MESSAGES.pt
  return cat[key] || SERVER_MESSAGES.pt[key] || ''
}

// Resolves the effective language for SERVER-composed messages/errors. Priority:
// (1) an explicit response-language preference, else (2) the UI language (so an
// English UI on "auto" reply-language still gets English errors), else pt (the
// app's authored default). `uiLang` arrives as 'auto' | 'pt-BR' | 'en' | 'es';
// normalize to the 2-letter base and only accept languages we actually have.
function msgLang(responseLang, uiLang) {
  if (SERVER_MESSAGES[responseLang]) return responseLang
  const base = String(uiLang || '').toLowerCase().split('-')[0]
  const mapped = base === 'pt' ? 'pt' : base === 'es' ? 'es' : base === 'en' ? 'en' : null
  return mapped || 'pt'
}

// Resolves the tool defs for one turn: the built-in Python tool (if the model
// supports tools and provisioning succeeded) plus whichever Genie/UC refs the
// session has enabled. Shared by /api/chat and the regenerate endpoint so
// both attach tools identically.
async function resolveToolDefs(req, model, enabledToolRefs, { includeImage = false, suppressDataTools = false } = {}) {
  const modelInfo = modelById(model)
  if (!modelInfo.tools) return { toolDefs: null, toolResolvers: null }
  const ts = await ensureTools(req)
  // org tool policy: an admin can disable a whole tool group for everyone.
  // Best-effort — a lookup failure degrades to "all enabled" (never blocks chat).
  const toolPolicy = await getToolPolicy(req.email, req.token).catch(() => ({}))
  // MCP Services an admin hid from the catalog are blocked here too, so a stale
  // session ref (adopted before the hide) can never reach the model
  const hiddenMcp = await getHiddenMcpNames(req.email, req.token).catch(() => new Set())
  // catalog display name + description per MCP Service → the "what this server
  // is for" context each MCP tool and the per-turn guide carry
  const mcpInfo = new Map(
    (await getMcpCatalog(req.email, req.token).catch(() => [])).map((e) => [e.connectionName, e])
  )
  const refs = await withAdoptedMcp(req, enabledToolRefs)
  // the image tool is offered only when the turn is plausibly about an image
  // (caps.image, passed as includeImage) AND the org hasn't disabled the group;
  // buildToolDefs re-checks the policy, this just avoids the work when off.
  const built = await buildToolDefs(refs, req.token, req.email, {
    includePython: ts.ready,
    includeImage: includeImage && toolPolicy['image-gen'] !== false,
    toolPolicy,
    hiddenMcp,
    mcpInfo,
    // on an artifact-only turn the caps router asks to drop company-data tools
    // (Genie One etc.) so they can't misfire while building an unrelated deck
    suppressDataTools,
  })
  if (!built.tools.length) return { toolDefs: null, toolResolvers: null, toolGuide: '' }
  return { toolDefs: built.tools, toolResolvers: built.resolvers, toolGuide: built.guide || '' }
}

// MCP connections the user adopted are ON by default in every chat — the
// server applies that, not the client. The picker used to add them to the
// session only when it was OPENED, so the first turn of a new chat went out
// without them (observed: "I have no web access" with Firecrawl connected).
// A ref `{ kind: 'mcp-external', connectionName, off: true }` is the explicit
// per-session opt-out (picker toggle off); it suppresses the default and is
// dropped before buildToolDefs. Best-effort: a DB failure keeps the refs as sent.
async function withAdoptedMcp(req, enabledToolRefs) {
  const refs = Array.isArray(enabledToolRefs) ? enabledToolRefs : []
  const mentioned = new Set(refs.filter((r) => r?.kind === 'mcp-external').map((r) => r.connectionName))
  const adopted = await listUserMcpConnections(req.email, req.token).catch(() => [])
  const added = adopted
    .filter((a) => !mentioned.has(a.connectionName))
    .map((a) => ({ kind: 'mcp-external', connectionName: a.connectionName, comment: a.comment }))
  return [...refs.filter((r) => !(r?.kind === 'mcp-external' && r.off)), ...added]
}

/**
 * Drives one assistant answer end-to-end: streams model output, executes any
 * tool calls (looping up to MAX_ROUNDS), and forwards SSE events as it goes.
 * `apiMessages` is mutated in place with the tool-call/tool-result turns.
 * Shared by /api/chat (new turns) and the regenerate endpoint (in-place
 * versions) — the only difference between them is how `apiMessages` and the
 * final message row get built around this call.
 * `chartState` ({nextId, items}) is mutated in place: a Genie tool call that
 * returns tabular data appends real, deterministic candidates to `items`,
 * numbered from the session-wide `nextId` counter, so the caller's later
 * extractPrismBlocks(answer, chartState.items) can resolve any prism-block
 * fence the model placed against them — including ones the model places in
 * a later turn, referencing data a tool call fetched earlier in the session.
 */

// Turns a tool call's own arguments into a short, human-readable subject for
// the chip title — deterministic, zero-latency, no extra LLM call (títulos de
// embrulho devem sair do que já temos, não de uma chamada de modelo — o modelo
// rápido de título já é o Haiku 4.5, mas nem isso precisa entrar no caminho
// crítico do turno). Genie/Genie One carry the user-facing `question`; Python
// carries `code` (we lift a leading comment or the first meaningful line).
// Label text helpers, shared by summarizeIntent and toolCallLabel.
const clean = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
const truncate = (s, n = 72) => {
  const t = clean(s)
  if (t.length <= n) return t
  // cut on a word boundary, drop trailing punctuation, add an ellipsis
  return t.slice(0, n).replace(/\s+\S*$/, '').replace(/[.,;:!?-]+$/, '') + '…'
}

function summarizeIntent(args = {}) {
  // strip common lead-ins that add no information to a title
  const stripLeadIn = (s) =>
    clean(s).replace(
      /^(me\s+)?(diga|d[êe]|mostre|traga|liste|calcule|qual\s+(é|e|foi)?|quais\s+(são|sao)?|quanto[s]?|como|preciso\s+(de|saber)|gere|monte|fa[çc]a|busque|buscar|encontre)\b[:,\s]*/i,
      ''
    )
  if (args.question) {
    const q = stripLeadIn(args.question) || clean(args.question)
    return truncate(q)
  }
  if (args.query) return truncate(clean(args.query))
  if (args.code) {
    const lines = String(args.code).split('\n').map((l) => l.trim())
    // a leading comment usually states intent better than the first statement
    const comment = lines.find((l) => l.startsWith('#'))
    if (comment) return truncate(comment.replace(/^#+\s*/, ''))
    const firstStmt = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('import '))
    if (firstStmt) return truncate(firstStmt)
  }
  return ''
}

// Composes the chip label shown before/after a tool runs. The base name is the
// tool family (Genie One, Python, …); the suffix is the intent summary and/or
// the concrete data source (a Genie space, a VS index) when we know it, so a
// sequence of same-family calls (Genie One → 4× Python) is distinguishable at a
// glance without expanding each box. Deterministic — see summarizeIntent.
export function toolCallLabel(resolver, args, fallbackName) {
  const withParts = (base, ...parts) => {
    const tail = parts.map((p) => (p || '').trim()).filter(Boolean).join(' · ')
    return tail ? `${base} · ${tail}` : base
  }
  const intent = summarizeIntent(args)
  switch (resolver?.kind) {
    case 'python':
      return withParts('Python', intent)
    case 'image-gen':
      // the tool's own prompt (english) is long; show a short, localizable-ish
      // subject only when it's brief, else just the tool name.
      return 'Image Generator'
    case 'genie':
      return withParts('Genie', intent || resolver.ref?.title, intent ? resolver.ref?.title : '')
    case 'genie-one':
      return withParts('Genie One', intent)
    case 'vector-search':
      return withParts('Vector Search', intent, resolver.ref?.indexName)
    case 'web-search':
    case 'web-search-mcp':
      return withParts('Web Search', intent)
    case 'web-fetch':
      return withParts('Web Fetch', args?.url ? truncate(args.url, 80) : intent)
    case 'mcp-external':
      return withParts(resolver.label || resolver.ref?.connectionName || 'MCP', resolver.mcpToolName)
    case 'mcp-external-error':
      return `${resolver.label || resolver.connectionName} · indisponível`
    default:
      return resolver?.ref?.name || fallbackName || 'tool'
  }
}

// Emits the ephemeral `skill_active` badge for a turn: the union of gated
// built-in capabilities (deck/spreadsheet) and routed authored skills,
// deduped by name, capped so the badge row stays compact. No-op when empty.
function emitActiveSkills(send, skills) {
  const seen = new Set()
  const out = []
  for (const s of skills || []) {
    if (!s || seen.has(s.name)) continue
    seen.add(s.name)
    out.push({ name: s.name, title: s.title, description: s.description })
  }
  if (out.length) send({ type: 'skill_active', skills: out.slice(0, 4) })
}

async function runAssistantTurn({
  req,
  res,
  send,
  model,
  temperature,
  apiMessages,
  toolDefs,
  toolResolvers,
  sessionId,
  chartState,
  imageModel,
  baseImages,
  lang = 'pt',
  signal,
}) {
  let answer = ''
  // native reasoning/thinking trace across all rounds — streamed live to the UI
  // AND accumulated here so it can be persisted with the message for later
  // inspection. Bounded so a very long reasoning run can't bloat the row.
  let reasoning = ''
  const REASONING_CAP = 200_000
  const usage = { prompt_tokens: 0, completion_tokens: 0 }
  let hadUsage = false
  const toolTrace = []
  // image refs produced by the generate_image tool this turn — returned so the
  // caller can resolve `image` prism-block fences against real image ids.
  const imageRefs = []
  let finishReason = null
  // null = ran to a natural finish; 'loop' = cut off spinning on identical
  // calls; 'ceiling' = hit MAX_ROUNDS. Surfaced to the user as an honest notice.
  let stoppedEarly = null
  // first tool call of the turn: TURN_TOOL_BUDGET_MS counts from here
  let toolStartedAt = null
  // the model/tool-loop failure, for the chat.turn span (the stream still ends normally)
  let turnError = null

  // Pure-HTML deck streaming (task #25): as the model writes the deck-html
  // block, surface each slide the instant it closes so the Studio builds live
  // instead of showing a blind spinner. One scanner per turn; slides accumulate
  // across rounds via the `deck_slide` event (client keys off `index`).
  const slideScanner = makeSlideStreamScanner({
    onTitle: (title) => send({ type: 'deck_stream_start', title }),
    onSlide: (html, index) => send({ type: 'deck_slide', html, index }),
  })

  async function runRound(msgs, tools) {
    let content = ''
    let toolCalls = null
    for await (const chunk of streamChat(req.token, model, msgs, { temperature, tools, signal })) {
      if (chunk.reasoning) {
        // reasoning-summary tokens (if this endpoint streams them): kept OUT of
        // `content`/`answer` (never replayed to the model), but streamed live to
        // the UI and accumulated so the trace can be persisted for later review.
        send({ type: 'reasoning', value: chunk.reasoning })
        if (reasoning.length < REASONING_CAP) reasoning += chunk.reasoning
      }
      if (chunk.delta) {
        content += chunk.delta
        send({ type: 'token', value: chunk.delta })
        slideScanner(content)
      }
      if (chunk.usage) {
        usage.prompt_tokens += chunk.usage.prompt_tokens || 0
        usage.completion_tokens += chunk.usage.completion_tokens || 0
        hadUsage = true
      }
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
      if (res.writableEnded) break
    }
    return { content, toolCalls }
  }

  try {
    // Hard backstop on tool-calling rounds — NOT "how many steps a task may
    // take" (that should be generous: query → iterate in Python → synthesize an
    // artifact is legitimately many rounds). This ceiling only catches truly
    // pathological runs; the real anti-spin mechanism is identical-call
    // detection below. Set high enough that a genuinely multi-step task never
    // hits it, low enough that a broken run can't rack up unbounded cost.
    const MAX_ROUNDS = 20
    // A model calling the EXACT same tool with the EXACT same arguments over and
    // over is stuck, not progressing — the classic agent failure mode. Distinct
    // calls (different Python code, a new Genie question) are real work and are
    // never counted here. Third identical repeat → force the model to wrap up.
    const REPEAT_LIMIT = 3
    const callCounts = new Map()
    let forceSynthesis = false
    for (let round = 0; round < MAX_ROUNDS && !res.writableEnded && !signal?.aborted; round++) {
      const lastRound = round === MAX_ROUNDS - 1
      // Drop tools on the final allowed round OR once the model is detected
      // spinning — either way it's forced to WRITE its answer with what it has
      // instead of calling yet another tool. Without a guaranteed synthesis
      // round, a turn that keeps calling tools exits with its last content being
      // a tool call (no prose): the message persists empty and any prism-block
      // the user asked for (a spreadsheet, a deck) is never authored.
      const overToolBudget = TURN_TOOL_BUDGET_MS > 0 && toolStartedAt !== null && Date.now() - toolStartedAt >= TURN_TOOL_BUDGET_MS
      const synthesize = lastRound || forceSynthesis || overToolBudget
      const roundTools = synthesize ? null : toolDefs
      if (synthesize) {
        // record WHY we're cutting tools, so the caller can surface an honest
        // notice — the answer isn't "complete", it's the best with data so far
        stoppedEarly = forceSynthesis ? 'loop' : overToolBudget && !lastRound ? 'time' : 'ceiling'
        // one-time nudge so the synthesis round produces the final answer AND
        // any requested artifact, not just a shrug
        apiMessages.push({ role: 'system', content: SYNTHESIS_NUDGE })
      }
      let result
      try {
        result = await runRound(apiMessages, roundTools)
      } catch (e) {
        // some endpoints reject the `tools` field outright — degrade once,
        // on the first round, instead of failing the whole answer
        if (roundTools && round === 0 && !signal?.aborted) {
          toolDefs = null
          result = await runRound(apiMessages, null)
        } else {
          throw e
        }
      }
      answer += result.content
      if (!result.toolCalls?.length || res.writableEnded || signal?.aborted) break

      // a model calling a tool with no parameters (e.g. the mcp-external
      // status tool) sometimes streams an empty `arguments` string instead
      // of "{}" — replaying that empty string back to the gateway as tool
      // history fails ("not a valid JSON string"), so it's normalized here,
      // once, before both replay and parsing below.
      for (const tc of result.toolCalls) {
        if (!tc.function.arguments) tc.function.arguments = '{}'
      }
      if (toolStartedAt === null) toolStartedAt = Date.now()

      // identical-call detection: signature = tool name + verbatim arguments.
      // Once any signature repeats REPEAT_LIMIT times the model is spinning —
      // flag it so the NEXT round drops tools and forces a wrap-up.
      for (const tc of result.toolCalls) {
        const sig = `${tc.function?.name}:${tc.function.arguments}`
        const n = (callCounts.get(sig) || 0) + 1
        callCounts.set(sig, n)
        if (n >= REPEAT_LIMIT) forceSynthesis = true
      }

      // inline markers (same mechanism as {{block:N}}) placed in the *display*
      // text only — apiMessages keeps the model's own plain content, so the
      // model never sees or has to reproduce these — so the frontend can
      // render each tool-call chip exactly where it happened in the
      // conversation, interleaved with the narrative, instead of grouping
      // every call before the answer regardless of when it actually ran
      answer += result.toolCalls.map((tc) => `\n\n{{toolcall:${tc.id}}}\n\n`).join('')

      apiMessages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
      for (const tc of result.toolCalls) {
        const resolver = toolResolvers?.get(tc.function?.name)
        let args = {}
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          // malformed JSON from the model — run with empty args, the tool/UC
          // function will surface its own validation error
        }
        const label = toolCallLabel(resolver, args, tc.function?.name)
        send({ type: 'tool_call', id: tc.id, name: tc.function?.name, label, args })

        const startedAt = Date.now()
        let resultText
        let status = 'ok'
        let newCandidates = []
        try {
          if (!resolver) throw new Error('Tool não reconhecida pelo servidor.')
          // long-blocking tools (Genie polls up to 90s) report elapsed progress
          // so the chip shows "8s" ticking instead of a silent spinner
          const onProgress = ({ elapsedMs }) =>
            send({ type: 'tool_progress', id: tc.id, elapsedMs })
          const invoked = await invokeTool(req.token, resolver, args, { sessionId, email: req.email, imageModel, baseImages, lang, onProgress, signal })
          resultText = invoked.resultText
          newCandidates = invoked.chartCandidates || []
          if (invoked.imageRefs?.length) imageRefs.push(...invoked.imageRefs)
        } catch (e) {
          // a cancelled turn ends here: no result is recorded, no round follows
          if (signal?.aborted) throw e
          status = 'error'
          resultText = `ERROR: ${e.message}`
        }
        const durationMs = Date.now() - startedAt
        toolTrace.push({ id: tc.id, name: tc.function?.name, label, args, result: resultText, status, durationMs })
        send({ type: 'tool_result', id: tc.id, status, result: resultText, durationMs })

        let modelContent = resultText
        if (newCandidates.length && chartState) {
          newCandidates.forEach((c) => (c.id = `candidate_${chartState.nextId++}`))
          chartState.items.push(...newCandidates)
          modelContent += buildNewCandidatesHint(newCandidates)
        }
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: modelContent })
      }
    }
  } catch (e) {
    // a cancel (the client left) is not an error to report: nobody is listening
    if (!signal?.aborted) {
      send({ type: 'error', error: e.message })
      turnError = e
    }
  }

  return { answer, reasoning: reasoning || null, usage, hadUsage, toolTrace, imageRefs, truncated: finishReason === 'length', stoppedEarly, cancelled: !!signal?.aborted, error: turnError }
}

// A `finish_reason: "length"` turn hit the model's max_tokens mid-answer. For
// deck turns that's fatal in a silent way: the unclosed ```prism-block fence é
// descartado pelo extractPrismBlocks e a mensagem persistida ficaria VAZIA, sem
// nenhum feedback (bug real: sessão presa em "gerando" deck e nada renderiza).
// Anexa um aviso visível ao conteúdo persistido e emite o evento `error`, que o
// frontend já mostra como toast + linha inline.
function applyTruncationNotice(truncated, content, send, lang = 'pt') {
  if (!truncated) return content
  const notice = serverMsg(lang, 'truncation')
  send({ type: 'error', error: notice })
  return content ? `${content}\n\n${notice}` : notice
}

// Injected once, right before the guaranteed synthesis round (tools already
// dropped) — tells the model to STOP calling tools and deliver the final
// answer plus any requested artifact with the data gathered so far.
const SYNTHESIS_NUDGE =
  'Pare de usar ferramentas agora e escreva a resposta final ao usuário com os dados que você já ' +
  'reuniu até aqui. Se o pedido inclui um artefato (planilha, deck, gráfico), produza-o agora no ' +
  'bloco ```prism-block``` apropriado. Se algum dado ficou faltando, entregue o melhor resultado ' +
  'possível e diga em uma frase, com honestidade, o que não foi possível obter.'

// The model was cut off before finishing on its own: either spinning on
// identical tool calls ('loop') or having hit the round ceiling ('ceiling').
// The synthesis round still produced a real answer with the data gathered, so
// this is an informational note, not an error — the answer is usable, just
// flagged as "best with what I had" so the user knows it wasn't a clean finish.
function applyStoppedEarlyNotice(stoppedEarly, content, send, lang = 'pt') {
  const key = stoppedEarly === 'loop' ? 'stoppedLoop' : stoppedEarly === 'ceiling' ? 'stoppedCeiling' : stoppedEarly === 'time' ? 'stoppedTime' : null
  if (!key) return content
  const notice = serverMsg(lang, key)
  send({ type: 'error', error: notice })
  return content ? `${content}\n\n${notice}` : notice
}

// Deck generation Phase 2 (opção 1 — por slide). When the turn's answer carries a
// compact `deck-outline` plan, materialize each slide in its own bounded model
// call and splice a `deck-html` fence over the outline span, so the rest of the
// pipeline (extractPrismBlocks → persistDeckBlocks → `blocks` event) is unchanged.
// Each finished slide streams via deck_stream_start/deck_slide (the client's
// live-build events). Shared by EVERY turn-producing route (chat, continue,
// regenerate): the model plans the deck identically on all of them, so all must
// run the expansion — otherwise the `deck-outline` block is dropped and the Studio
// spins on "Building the slides…" forever (the reported regenerate bug). Returns
// the (possibly rewritten) answer; folds the per-slide token spend into `usage`.
// A truncated outline is salvaged upstream (extractDeckOutline), so a
// reasoning-heavy model that ran out of budget still yields a shorter real deck.
async function materializeDeckOutline({ req, res, send, model, answer, caps, template, usage, signal }) {
  if (!caps?.deck || res.writableEnded || signal?.aborted) return answer
  const found = extractDeckOutline(answer)
  if (!found) return answer
  // the turn's signal stops the slide queue (no new slide call, in-flight ones
  // aborted); the caller sees the cancel and persists nothing
  const built = await generateDeckFromOutline(req.token, model, found.outline, {
    template,
    signal,
    onTitle: (title) => send({ type: 'deck_stream_start', title }),
    onSlide: (html, index) => send({ type: 'deck_slide', html, index }),
  })
  if (built.cancelled || !built.slides.length) return answer
  const fence =
    '```prism-block\n' +
    JSON.stringify({
      type: 'deck-html',
      title: found.outline.title,
      audience: found.outline.audience,
      author: found.outline.author,
      slides: built.slides,
    }) +
    '\n```'
  if (built.usage && usage) {
    usage.prompt_tokens += built.usage.prompt_tokens || built.usage.input_tokens || 0
    usage.completion_tokens += built.usage.completion_tokens || built.usage.output_tokens || 0
  }
  return answer.slice(0, found.start) + fence + answer.slice(found.end)
}

// A `deck` block is resolved (validated/sanitized) by extractPrismBlocks like
// any other prism-block, but — unlike chart/table/insight — it also needs a
// row of its own so the Deck Studio can reload/edit/export it later
// independent of the message's stored content. Mutates `blocks` in place to
// attach the new `deckId`.
async function persistDeckBlocks(req, sessionId, blocks) {
  for (const b of blocks) {
    if (b.type === 'deck-html') {
      // pure-HTML deck: slides is an array of self-contained <section> strings.
      // Stored in the same chat_decks table; meta.format='html' marks the format
      // on reload (see the Studio render path).
      const meta = { audience: b.audience, author: b.author, format: 'html' }
      b.deckId = await createDeck(req.email, req.token, sessionId, b.title, b.slides, meta)
    } else if (b.type === 'spreadsheet') {
      // persist the whole spec (title + sheets) so the export route can
      // reload and render it into .xlsx independent of the message content
      const spec = { title: b.title, sheets: b.sheets }
      b.spreadsheetId = await createSpreadsheet(req.email, req.token, sessionId, b.title, spec)
    } else if (b.type === 'document') {
      // persist the markdown so the Document Studio can reload/edit/export it
      b.documentId = await createDocument(req.email, req.token, sessionId, b.title, b.markdown)
    }
  }
}

// ---- the shared turn engine ----
//
// The three turn routes differ only in their input (a new user message + files;
// a trailing unanswered user message; the history before one assistant message)
// and in their SSE envelope (`meta`/`title` on /api/chat, `variant` on the other
// two). Everything between — model options, capability gating, the lazy deck
// template, the system messages, the history replay, tools, the tool loop, the
// deck expansion, block extraction, notices, persistence and the blocks/usage
// events — lives once in prepareTurn → runAssistantTurn → finishTurn, so the
// routes cannot drift apart again (the reported regenerate deck bug).

// Indirection for the heavy deck-template read so the route tests can count
// loads; production code always calls through this object.
export const turnDeps = { getSelectedDeckTemplate }

// Context providers: extra system messages for a turn (e.g. user memory),
// registered once at boot. Each runs as
//   async ({ req, sessionId, history }) => [systemMessage | string, ...]
// after the skills message and before the history replay, in registration
// order, on all three routes. A provider that throws costs only its own
// messages, never the turn. There is no timeout: a provider must bound its own
// I/O, since a hanging one holds the turn (and its session lock). Returns an
// unregister function.
const contextProviders = []
export function registerTurnContextProvider(provider) {
  if (typeof provider !== 'function') throw new TypeError('registerTurnContextProvider needs a function')
  const entry = { provider }
  contextProviders.push(entry)
  return () => {
    const i = contextProviders.indexOf(entry)
    if (i >= 0) contextProviders.splice(i, 1)
  }
}

async function runContextProviders(req, sessionId, history) {
  const results = await Promise.all(
    contextProviders.slice().map(async ({ provider }) => {
      try {
        const out = await provider({ req, sessionId, history })
        return Array.isArray(out) ? out : []
      } catch (e) {
        logger.warn('turn context provider failed', { err: e })
        return []
      }
    })
  )
  // providers may only add SYSTEM context: anything else is coerced, empties dropped
  return results
    .flat()
    .map((m) => (typeof m === 'string' ? m : m?.content))
    .filter((c) => typeof c === 'string' && c.trim())
    .map((content) => ({ role: 'system', content }))
}

// Per-turn options from the request body (JSON on /continue and /regenerate,
// the multipart `payload` on /api/chat). Call after getUserModels(req), which
// warms the enabled-models cache resolveModelId validates against.
function readTurnOptions(body = {}) {
  return {
    model: resolveModelId(body.model),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    systemPrompt: (body.systemPrompt || '').trim(),
    responseLang: body.responseLang,
    uiLang: body.uiLang,
    enabledToolRefs: Array.isArray(body.enabledTools) ? body.enabledTools : [],
    skills: body.skills,
    imageModel: body.imageModel,
  }
}

// Cancellation of one turn. A client that goes away mid-turn (`close` on the
// RESPONSE, not the request: in current Node the request's `close` fires as soon
// as its body has been read, i.e. on every POST):
//   - aborts the turn's own AbortController, whose signal reaches the in-flight
//     gateway request (llm.js), the pending tool call (tools.js), the deck slide
//     queue (deckHtmlGenerate.js) and the post-answer tail, so all of them stop
//     within a second;
//   - ends the response, so no further event is written;
//   - frees the session lock at once, exactly once (`getRelease()` is the
//     route's release, or null before it holds one), so Stop-then-send on the
//     same session is never refused with 409 while abandoned work unwinds.
// Writes go through commit(fn): after a cancel commit() refuses to start, so a
// cancelled turn persists nothing. A cancel that arrives while commit() is
// writing does not cut those writes short (the turn is then saved, `saved` on
// chat.turn). The lock is already free by then, so to keep the session's write
// order the pending commit is recorded as the session's drain
// (`getSession()`): the next turn awaits it (awaitSessionDrain) right after
// taking the lock, before it writes or reads the history.
// guard(fn) is the same rule for a single write that may come late (a
// compaction save after its summary call): it runs fn only while the turn is
// live, else rejects with the AbortError.
// One controller per turn: a cancel never reaches the next turn on the session.
const sessionDrains = new Map() // session id -> Promise of a cancelled turn's pending commit

/** Resolves once no cancelled turn of `sessionId` is still writing (at once in the common case). */
export function awaitSessionDrain(sessionId) {
  return sessionDrains.get(String(sessionId)) ?? Promise.resolve()
}

export function createTurnCancel(res, getRelease = () => null, getSession = () => null) {
  const ac = new AbortController()
  let pending = null // the commit() in progress, if any
  let released = false
  const releaseLock = () => {
    if (released) return
    const release = getRelease()
    if (!release) return // not holding the lock yet: the route's finally frees it
    released = true
    release()
  }
  const state = {
    gone: false,
    signal: ac.signal,
    async commit(fn) {
      if (state.gone) return { committed: false }
      const run = (async () => ({ committed: true, value: await fn() }))()
      pending = run
      try {
        return await run
      } finally {
        if (pending === run) pending = null
      }
    },
    async guard(fn) {
      const out = await state.commit(fn)
      if (!out.committed) throw ac.signal.reason
      return out.value
    },
  }
  res.on('close', () => {
    // the route already ended the response (writableEnded, 'finish' still to
    // come): the turn completed, a late close is not a cancel
    if (res.writableFinished || res.writableEnded) return
    state.gone = true
    ac.abort()
    const key = getSession()
    if (pending && key != null) {
      const k = String(key)
      const drain = pending.then(
        () => {},
        () => {}
      )
      sessionDrains.set(k, drain)
      drain.then(() => {
        if (sessionDrains.get(k) === drain) sessionDrains.delete(k)
      })
    }
    releaseLock()
    res.end()
  })
  return state
}

// No-op cancellation for callers without a response to watch.
const NEVER_CANCELLED = {
  gone: false,
  signal: undefined,
  commit: async (fn) => ({ committed: true, value: await fn() }),
  guard: (fn) => fn(),
}

// ---- chat.turn: the root span of a turn ----
//
// chat.turn{session.id, route, model, caps, status, request_id} wraps the whole
// route handler and is the ACTIVE span while it runs, so every llm.call and
// tool.call of the turn (and the intent, embedding and title calls) is its
// child. `status`: ok | error (the turn failed) | cancelled (the client left) |
// rejected (answered 4xx before streaming: 409 turn_in_flight, 403, 404, 400).
// A cancelled turn also records `saved`: false when it was dropped (the rule),
// true when the cancel arrived while the answer was already being written, so
// that write completed (see createTurnCancel).
// `caps` lists the capabilities gated on for the turn (e.g. "deck,document").
// Like llm.call/tool.call it never carries prompt text or e-mails.
function capsAttr(caps) {
  return Object.keys(caps || {})
    .filter((k) => caps[k] === true)
    .sort()
    .join(',')
}

function endTurnSpan(t, res) {
  try {
    const status = t.cancel?.gone ? 'cancelled' : t.failed ? 'error' : res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'rejected' : 'ok'
    t.span.setAttribute('status', status)
    if (status === 'cancelled') t.span.setAttribute('saved', !!t.saved)
    if (status === 'error') t.span.setStatus({ code: SpanStatusCode.ERROR, message: t.failed?.name || 'Error' })
    else if (status === 'ok') t.span.setStatus({ code: SpanStatusCode.OK })
    t.span.end()
  } catch {
    // telemetry never breaks the turn it observes
  }
}

/** Wraps a turn route handler in its chat.turn span; handler(req, res, t). */
function turnRoute(route, handler) {
  return (req, res) => {
    const span = startSpan('chat.turn', { route, request_id: String(req.id || ''), 'session.id': '', model: '', caps: '' })
    const t = { span, cancel: null, failed: null, saved: false }
    return context.with(trace.setSpan(context.active(), span), () => handler(req, res, t)).finally(() => endTurnSpan(t, res))
  }
}

// makeSend plus a heartbeat on the session's turn lock: every event a turn
// sends (tokens, tool progress, deck slides) marks it live, so only a turn
// silent for the lock's stale window can be taken over (server/turnLock.js).
function heartbeatSend(res, getRelease) {
  const send = makeSend(res)
  return (obj) => {
    getRelease()?.touch?.()
    send(obj)
  }
}

// Takes the per-session turn lock, or answers 409 turn_in_flight and returns
// null. Call only once the caller is known to own the session: taking the lock
// on someone else's id would hold the owner's session, and the status would
// reveal that it is busy.
function lockSession(res, sessionId) {
  const release = turnLock.acquire(sessionId)
  if (!release) res.status(409).json({ error: 'turn_in_flight' })
  return release
}

// Builds the model conversation for one turn. `userText` drives capability
// gating, skills and retrieval; `history` is the full owner-scoped history (its
// last message is the user turn being answered). Only /api/chat passes
// attachments (pptxDeckBrief, imageAttachments, classifyOpts). Returns the
// runAssistantTurn arguments plus what finishTurn needs.
async function prepareTurn({ req, res, send, sessionId, history, userText, opts, chartState, classifyOpts = {}, pptxDeckBrief = null, imageAttachments = [], signal, cancel = NEVER_CANCELLED }) {
  const { model, systemPrompt } = opts
  const apiMessages = []
  if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt })
  // ephemeral, per-turn instruction — never persisted, only sent to the model.
  // Progressive disclosure: only include the heavy deck/spreadsheet policies
  // when the turn is plausibly about them (see detectCapabilities) — a trivial
  // question shouldn't carry ~10k tokens of deck+spreadsheet+design-system.
  // Cheap LLM intent classifier (hybrid-gated): on turns where the regex
  // router is unreliable — a long briefing that narrates artifact/data nouns,
  // a multi-artifact request — a fast/cheap model reads the actual intent so
  // we don't over-fire capabilities/tools (the reported bug). Skipped on
  // trivial chat and obvious tweaks (see shouldClassifyIntent) to keep TTFT
  // flat. Its tiny cost is folded into the turn's estimate (intentClassify
  // in finishTurn). Best-effort: on failure/timeout, caps fall back to the regexes.
  // History blocks keep an in-progress deck/spreadsheet flow's policy on.
  const intentResult = shouldClassifyIntent(userText, history, classifyOpts)
    ? await classifyIntent(req.token, userText, { signal }).catch(() => null)
    : null
  const caps = detectCapabilities(userText, history, { ...classifyOpts, classifier: intentResult })
  // Only the deck flow consumes the (heavy) selected template — both to build
  // its instruction and to resolve deck fences afterward. When this turn isn't
  // about a deck, caps.deck is false, DECK_POLICY is omitted, so the model
  // can't emit a deck fence and extractPrismBlocks never needs the template:
  // skip the fetch entirely. Deck turns still get it (cached across turns).
  const selectedTemplate = caps.deck ? await turnDeps.getSelectedDeckTemplate(req.email, req.token) : null
  const blocksInstruction = buildBlocksInstruction(chartState.items, selectedTemplate, caps)
  if (blocksInstruction) apiMessages.push({ role: 'system', content: blocksInstruction })
  // "Adjust presentation" skill: the user attached a .pptx and asked to adapt
  // it. Hand the model the STRUCTURED slides (not just flattened text) plus a
  // directive to restructure into the selected design system directly — no
  // deck-questions detour, since the content already exists.
  if (caps.pptxAdjust && pptxDeckBrief) {
    apiMessages.push({
      role: 'system',
      content:
        'O usuário anexou uma apresentação existente e pediu para ajustá-la ao ' +
        'design system/template selecionado. A estrutura extraída do arquivo ' +
        'está abaixo (um slide por item, com layout inferido). Reestruture-a ' +
        'como um bloco `deck` no design system ativo, preservando a mensagem e ' +
        'a ordem de cada slide e melhorando a composição. NÃO gere o bloco ' +
        '`deck-questions` nem faça perguntas — ajuste diretamente, pois o ' +
        'conteúdo já existe.\n\n--- APRESENTAÇÃO ANEXADA ---\n' + pptxDeckBrief,
    })
  }
  // authored skills (Fase 2): route the turn to any matching user/global
  // skill, inject its body, and tell the client which fired (ephemeral badge)
  const activeSkills = await routeSkills(req, userText, { forced: opts.skills })
  if (activeSkills.length) {
    apiMessages.push({ role: 'system', content: renderSkillsInstruction(activeSkills) })
  }
  // badge = built-in capabilities (deck/spreadsheet) that were gated on this
  // turn + any authored skills — so generating a spreadsheet/deck also shows a
  // "skill active" chip, not just user-authored skills
  emitActiveSkills(send, [...activeSystemSkills(caps), ...activeSkills])
  // registered context providers (registerTurnContextProvider), after the skills
  apiMessages.push(...(await runContextProviders(req, sessionId, history)))
  // Context window: replay only the recent conversation to the model (the
  // full `history` is still used above for detectCapabilities and below for
  // chart/deck block resolution). Caps latency/cost that would otherwise grow
  // with the conversation length; see pushWindowedHistory / MAX_HISTORY_MESSAGES.
  // With HISTORY_RETRIEVAL on, also pull semantically-relevant older messages.
  // an automatic compaction of a cancelled turn is not saved: its save goes
  // through cancel.guard (a turn the user then sends would compact again)
  const { summary, replay } = await prepareCompactedReplay(req, {
    send,
    sessionId,
    model,
    history,
    maxMessages: MAX_HISTORY_MESSAGES,
    compact: (r, args) => compactConversation(r, { ...args, save: (...a) => cancel.guard(() => insertCompaction(...a)) }),
  })
  const retrieved = await retrieveHistoryContext(req, sessionId, history, userText, signal)
  pushWindowedHistory(apiMessages, replay, retrieved, summary)
  // pasted/attached images → vision input on the turn being answered
  attachImagesToLastUserTurn(apiMessages, imageAttachments)

  // tools: the built-in Python UC function is provisioned lazily once per
  // process; additional tools are whichever UC Functions the user attached
  // to this session. Skip entirely for models flagged tools:false or if
  // provisioning failed (e.g. no SQL_WAREHOUSE_ID / no CREATE FUNCTION grant).
  const { toolDefs, toolResolvers, toolGuide } = await resolveToolDefs(req, model, opts.enabledToolRefs, {
    includeImage: caps.image,
    suppressDataTools: caps.suppressDataTools,
  })
  // narration guidance only when tools are actually in play — appended after
  // the history so it's the freshest instruction when the model decides
  // whether/how to call a tool
  if (toolDefs) apiMessages.push({ role: 'system', content: withToolGuide(TOOL_POLICY, toolGuide) })
  // forced response language (Preferences) — LAST system message, so it's the
  // freshest/highest-salience instruction and overrides the PT-authored
  // policies above and the user's own language. Omitted when 'auto'.
  const langDir = responseLangDirective(opts.responseLang)
  if (langDir) apiMessages.push({ role: 'system', content: langDir })

  // Which image model the generate_image tool should use, if this turn calls
  // it: the client's per-turn choice, else the user's saved preference, else
  // the org default (resolved inside the tool). Only fetched when relevant.
  const imageModel = caps.image
    ? (opts.imageModel || (await getSelectedImageModel(req.email, req.token).catch(() => null)) || undefined)
    : undefined

  return {
    // runAssistantTurn arguments
    req,
    res,
    send,
    model,
    temperature: opts.temperature,
    apiMessages,
    toolDefs,
    toolResolvers,
    sessionId,
    chartState,
    imageModel,
    baseImages: imageAttachments,
    lang: msgLang(opts.responseLang, opts.uiLang),
    signal,
    // for finishTurn
    caps,
    intentResult,
    selectedTemplate,
  }
}

// After the tool loop: expands a deck outline, resolves prism-blocks, appends
// the truncation/stopped-early notices, persists candidates, artifacts, the
// assistant message and its tool trace, and emits `blocks` and `usage`.
// `message` carries the route's extra columns (variantGroup, mediaProcessing);
// `blocksEvent` its extra fields on the blocks event (/api/chat's sessionId).
// Returns { assistantMsg, finalContent, blocks } — assistantMsg is null when the
// client left mid-turn (`cancel`, see createTurnCancel): the answer stopped
// wherever the disconnect cut it (mid stream, in a tool call, during slide
// generation), so nothing is persisted; the user message stays unanswered and
// /continue can recover it.
async function finishTurn(ctx, result, { message = {}, blocksEvent = {}, cancel = NEVER_CANCELLED } = {}) {
  const { req, res, send, model, sessionId, caps, chartState, selectedTemplate, intentResult, lang } = ctx
  const { answer, reasoning, usage, hadUsage, toolTrace, imageRefs, truncated, stoppedEarly } = result
  const nothing = { assistantMsg: null, finalContent: '', blocks: [] }
  if (cancel.gone) return nothing

  // Deck generation, Phase 2 (opção 1 — por slide): materialize the `deck-outline`
  // plan into per-slide HTML — the same path on chat/continue/regenerate.
  const deckAnswer = await materializeDeckOutline({
    req, res, send, model, answer, caps, template: selectedTemplate, usage, signal: cancel.signal,
  })
  // the client left during slide generation: the slide queue stopped, drop the turn
  if (cancel.gone) return nothing

  // resolve any model-placed chart/insight blocks against the real,
  // deterministic candidates (from attachments and/or Genie tool calls made
  // this turn or earlier in the session) — each fence becomes a {{block:N}}
  // placeholder right where the model put it, so the frontend renders it inline.
  // imageRefs resolve `image` fences against images the tool generated this turn.
  let { content: finalContent, blocks } = extractPrismBlocks(deckAnswer, chartState.items, selectedTemplate, imageRefs)
  finalContent = applyTruncationNotice(truncated, finalContent, send, lang)
  finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send, lang)
  // the commit point: from here the answer is written in full, or (cancelled
  // before it) not at all — see createTurnCancel
  const written = await cancel.commit(async () => {
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const row = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      reasoning,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
      ...message,
      // disclose the intent-classifier hop + its (tiny) token spend so it folds
      // into the shown cost estimate, per the design decision to make the
      // pre-analysis cost visible rather than hidden.
      intentClassify: intentResult?.usage
        ? { model: INTENT_MODEL, usage: { prompt_tokens: intentResult.usage.prompt_tokens, completion_tokens: intentResult.usage.completion_tokens } }
        : null,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, row.id, toolTrace)
    return row
  })
  if (!written.committed) return nothing
  const assistantMsg = written.value

  if (blocks.length) send({ type: 'blocks', ...blocksEvent, blocks, content: finalContent })
  if (hadUsage) send({ type: 'usage', usage })
  return { assistantMsg, finalContent, blocks }
}

// The error tail shared by the three routes: a plain 500 before the stream
// opened, else an `error` event and the closing `done`.
function failTurn(res, send, e, t) {
  if (t) t.failed = e
  if (!res.headersSent) {
    res.status(500).json({ error: e.message })
  } else {
    send({ type: 'error', error: e.message })
    send({ type: 'done' })
    res.end()
  }
}

export default function registerTurnRoutes(app) {
  // ---- streaming chat ----
  app.post('/api/chat', auth, upload.array('files'), rebindUsageScope, turnRoute('/api/chat', async (req, res, t) => {
    let release = null
    const send = heartbeatSend(res, () => release)
    let sessionId = null
    const cancel = (t.cancel = createTurnCancel(res, () => release, () => sessionId))
    try {
      await ensureReady(req)

      let payload = {}
      try {
        payload = JSON.parse(req.body.payload || '{}')
      } catch {
        return res.status(400).json({ error: 'payload inválido' })
      }
      const prompt = (payload.prompt || '').trim()
      await getUserModels(req) // warm the enabled-models cache before validating
      const opts = readTurnOptions(payload)
      const { model, systemPrompt, enabledToolRefs } = opts
      t.span.setAttribute('model', String(model || ''))
      sessionId = payload.sessionId || null

      if (!prompt && !(req.files && req.files.length)) {
        return res.status(400).json({ error: 'prompt vazio' })
      }

      // if the client passed an existing session id, verify the caller owns it
      // BEFORE opening the SSE stream — so a forged/guessed id gets a clean 403
      // instead of an error mid-stream. addMessage re-checks ownership atomically,
      // but this keeps the failure a proper HTTP status. (getSession is scoped by
      // user_email, so this returns null for someone else's session.)
      if (sessionId && !(await getSession(req.email, req.token, sessionId))) {
        return res.status(403).json({ error: 'sessão não encontrada' })
      }
      if (sessionId) t.span.setAttribute('session.id', String(sessionId))
      // one turn per session: a second one while this runs gets 409 turn_in_flight
      if (sessionId && !(release = lockSession(res, sessionId))) return
      // a cancelled turn of this session may still be writing its answer: write after it
      if (sessionId) await awaitSessionDrain(sessionId)
      // cost ledger: an existing chat is known now; a new one spends (media,
      // intent classifier) before createSession — hold those rows until it exists
      if (sessionId) setUsageSession(sessionId)
      else holdUsageUntilSession()

      // extract attachment text, and — for spreadsheets — real chart candidates
      // computed deterministically (never by the model, to avoid hallucinated numbers)
      const attachNames = []
      const attachBlocks = []
      const imageAttachments = [] // { name, dataUrl } — sent to the model as vision input
      // audio/video files whose content was read by the multimodal media model
      // (Gemini) — recorded so the answer can disclose the two-model pipeline
      const mediaProcessedFiles = []
      const mediaUsageTotal = { prompt_tokens: 0, completion_tokens: 0, any: false }
      let fileCandidates = []
      let pptxDeckBrief = null // structured slides from an attached .pptx, if any
      for (const f of req.files || []) {
        const name = fixFilename(f.originalname)
        // Image attachments (pasted screenshots, "attach image") are VISION input,
        // not text-extractable documents: hold the bytes as a data-URL to attach
        // to the model turn, and skip the text-extraction path (which would just
        // yield an "unsupported file" note). The name is still recorded so the
        // user's message shows the attachment.
        if ((f.mimetype || '').startsWith('image/')) {
          attachNames.push(name)
          imageAttachments.push({
            name,
            dataUrl: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
          })
          continue
        }
        // Audio/video attachments (meeting recordings, voice notes) are TRANSCRIBED
        // to text — the chat models can't ingest media bytes. The transcript is
        // injected as a normal attachment block, so the user's own prompt drives
        // what's done with it (summary, action items, decisions, follow-up email —
        // never hardcoded). Any failure degrades to a note so the turn still runs.
        if (isMediaFile(name, f.mimetype)) {
          attachNames.push(name)
          try {
            const { text: transcript, usage: mediaUsage } = await transcribe(req.token, name, f.buffer, f.mimetype)
            mediaProcessedFiles.push(name)
            if (mediaUsage) {
              mediaUsageTotal.prompt_tokens += mediaUsage.prompt_tokens || 0
              mediaUsageTotal.completion_tokens += mediaUsage.completion_tokens || 0
              mediaUsageTotal.any = true
            }
            attachBlocks.push(
              `### Transcrição de ${name}\n(gerada automaticamente a partir do áudio/vídeo anexado)\n\n${transcript}`
            )
          } catch (e) {
            const why = e instanceof TranscriptionError ? e.message : e.message
            logger.warn(`transcrição falhou (${name})`, { err: why })
            attachBlocks.push(`### Arquivo: ${name}\n[Não foi possível transcrever o áudio/vídeo: ${why}]`)
          }
          continue
        }
        const text = await extractText(name, f.buffer)
        attachNames.push(name)
        attachBlocks.push(`### Arquivo: ${name}\n${text}`)
        if (isSpreadsheet(name)) {
          try {
            const { chartCandidates: cands } = analyzeSpreadsheet(name, f.buffer)
            fileCandidates = fileCandidates.concat(cands)
          } catch (e) {
            logger.warn(`análise de planilha falhou (${name})`, { err: e })
          }
        }
        // A .pptx also gets a STRUCTURED read (title/bullets/layout per slide) so
        // the "adjust presentation" skill can restructure it into the design
        // system, instead of only seeing the flattened text above.
        if (/\.pptx$/i.test(name) && !pptxDeckBrief) {
          try {
            const ingested = await ingestPptx(f.buffer, name)
            if (ingested) pptxDeckBrief = pptxDeckToBrief(ingested)
          } catch (e) {
            logger.warn(`ingestão de pptx falhou (${name})`, { err: e })
          }
        }
      }

      // open SSE
      // the client left before the stream opened: nothing to answer, nothing written
      if (cancel.gone) return
      openSse(res)

      const fullContent = attachBlocks.length
        ? prompt + ATTACH_MARKER + attachBlocks.join('\n\n')
        : prompt

      // The session (on a first message) and the user message, written together
      // or (the client already left) not at all. Kept by a later cancel: the
      // unanswered user message is what /continue recovers.
      let isNew = false
      let chartStatePromise
      const wrote = await cancel.commit(async () => {
        // create session lazily on first message
        if (!sessionId) {
          isNew = true
          sessionId = await createSession(
            req.email,
            req.token,
            '💬 Nova conversa',
            model,
            systemPrompt,
            enabledToolRefs
          )
          setUsageSession(sessionId) // releases the held media/intent ledger rows
          t.span.setAttribute('session.id', String(sessionId))
          // nobody else can know this id yet; held so GET /api/sessions/:id shows busy
          release = turnLock.acquire(sessionId)
        }

        // Kick off the reads that DON'T depend on the user-message write, so they
        // overlap with it instead of running serially: chart candidates (session
        // lifetime — a report compiled several turns after the Genie calls that
        // fetched the numbers still needs them to resolve its prism-block fences).
        // The selected deck template is NOT fetched here — it's a heavy render-cut
        // payload (MBs of jsonb) only the deck flow uses, so prepareTurn resolves
        // it lazily, and only when this turn is actually about a deck (caps.deck).
        chartStatePromise = isNew
          ? Promise.resolve({ nextId: 1, items: [] })
          : getSessionChartCandidates(req.email, req.token, sessionId)
        // a cancel below must not leave this read's rejection unhandled
        chartStatePromise.catch(() => {})

        // the user-message write MUST land before we read the history back
        await addMessage(req.email, req.token, {
          sessionId,
          role: 'user',
          content: fullContent,
          attachments: attachNames.length ? JSON.stringify(attachNames) : null,
        })
      })
      if (!wrote.committed || cancel.gone) return

      // request_id: the x-request-id of this response, to find the turn's logs and trace
      send({ type: 'meta', sessionId: String(sessionId), isNew, request_id: String(req.id || '') })

      // now resolve everything needed to build the conversation, concurrently:
      // the just-written history plus the chart candidates started above
      const [chartState, history] = await Promise.all([
        chartStatePromise,
        listMessages(req.email, req.token, sessionId),
      ])
      if (fileCandidates.length) {
        fileCandidates.forEach((c) => (c.id = `candidate_${chartState.nextId++}`))
        chartState.items.push(...fileCandidates)
      }

      const ctx = await prepareTurn({
        req,
        res,
        send,
        sessionId,
        history,
        userText: prompt,
        opts,
        chartState,
        classifyOpts: { hasPptxAttachment: !!pptxDeckBrief, hasImageAttachment: imageAttachments.length > 0 },
        pptxDeckBrief,
        imageAttachments,
        signal: cancel.signal,
        cancel,
      })
      t.span.setAttribute('caps', capsAttr(ctx.caps))
      const result = await runAssistantTurn(ctx)
      if (result.error) t.failed = result.error
      const finished = await finishTurn(ctx, result, {
        cancel,
        message: { mediaProcessing: computeMediaProcessing(mediaProcessedFiles, model, mediaUsageTotal) },
        blocksEvent: { sessionId: String(sessionId) },
      })
      t.saved = !!finished.assistantMsg

      // Post-answer work: the semantic-search embedding and (first exchange) the
      // emoji title. Both are GATEWAY calls (embed + generateTitle) — the DB pool
      // doesn't speed them up — and they used to run SERIALLY here, stacking ~4s
      // of dead air AFTER the answer was fully streamed. They're independent, so
      // run them concurrently: the tail becomes max(embed, title) instead of the
      // sum. The `title` still streams as its own event so the client applies it
      // live; a failure in either is logged, never fatal to the turn. Skipped when
      // the client left: no answer was saved, so there is nothing to embed or title.
      // A client that leaves DURING the tail cancels it too: the turn signal aborts
      // the embed/title requests and no embedding, title or session update is
      // written after the cancel (cancel.guard).
      if (cancel.gone) return
      const { signal } = cancel
      const quiet = (what) => (e) => {
        if (!signal.aborted) logger.warn(what, { err: e })
      }
      const embedTask = updateSessionEmbedding(req, sessionId, history, { signal }).catch(quiet('embedding update failed'))
      // per-message embeddings (history retrieval + pgvector search). Independent
      // of the session-level embedding; runs concurrently on the tail, best-effort.
      const msgIndexTask = indexSessionMessages(req, sessionId, { signal }).catch(quiet('message embedding index failed'))
      const titleTask = (async () => {
        if (isNew) {
          const title = await generateTitle(req.token, prompt || attachNames.join(', '), result.answer, { signal })
          await cancel.guard(() => updateSession(req.email, req.token, sessionId, { title }))
          send({ type: 'title', title, sessionId: String(sessionId) })
        } else {
          await cancel.guard(() => updateSession(req.email, req.token, sessionId, {}))
        }
      })().catch(quiet('title/session update failed'))
      await Promise.all([embedTask, msgIndexTask, titleTask])

      send({ type: 'done' })
      res.end()
    } catch (e) {
      failTurn(res, send, e, t)
    } finally {
      release?.()
    }
  }))

  // ---- recovery: answer a trailing UNANSWERED user message ----
  // A turn can leave a user message with no assistant reply — the server crashed
  // or the token expired mid-generation, so /api/chat persisted the user row but
  // never created the answer. There's no assistant message to "regenerate", so
  // the user is stuck. This generates the missing reply as a fresh assistant
  // message (its own variant group), building history exactly like /api/chat.
  app.post('/api/sessions/:id/continue', auth, turnRoute('/api/sessions/:id/continue', async (req, res, t) => {
    let release = null
    const send = heartbeatSend(res, () => release)
    const sessionId = req.params.id
    const cancel = (t.cancel = createTurnCancel(res, () => release, () => sessionId))
    try {
      await ensureReady(req)

      t.span.setAttribute('session.id', String(sessionId))
      await getUserModels(req)
      const opts = readTurnOptions(req.body)
      t.span.setAttribute('model', String(opts.model || ''))

      // owner-scoped load first (empty = not the caller's), then the lock; read
      // again under the lock so a turn that just finished is not answered twice
      if (!(await listMessages(req.email, req.token, sessionId)).length) return res.status(404).json({ error: 'sessão vazia' })
      if (!(release = lockSession(res, sessionId))) return
      // a cancelled turn may still be writing its answer: read the history after it
      await awaitSessionDrain(sessionId)
      const history = await listMessages(req.email, req.token, sessionId)
      if (!history.length) return res.status(404).json({ error: 'sessão vazia' })
      // cost ledger (only ever summed per user_email), after the owner-scoped load
      setUsageSession(sessionId)
      // only valid when the conversation actually ends on an unanswered user
      // message — otherwise there's nothing missing to fill in
      if (history[history.length - 1].role !== 'user') {
        return res.status(409).json({ error: 'a última mensagem já foi respondida' })
      }

      // the client left before the stream opened: nothing to answer, nothing written
      if (cancel.gone) return
      openSse(res)

      const ctx = await prepareTurn({
        req,
        res,
        send,
        sessionId,
        history,
        // the last (unanswered) user message drives capability gating
        userText: history[history.length - 1]?.content || '',
        opts,
        chartState: await getSessionChartCandidates(req.email, req.token, sessionId),
        signal: cancel.signal,
        cancel,
      })
      t.span.setAttribute('caps', capsAttr(ctx.caps))
      const result = await runAssistantTurn(ctx)
      if (result.error) t.failed = result.error
      const { assistantMsg } = await finishTurn(ctx, result, { cancel })
      t.saved = !!assistantMsg
      if (cancel.gone) return
      if (assistantMsg) send({ type: 'variant', messageId: assistantMsg.id })

      // touch updated_at, unless the client left meanwhile (nothing after a cancel)
      await cancel.guard(() => updateSession(req.email, req.token, sessionId, {})).catch((e) => {
        if (!cancel.gone) throw e
      })
      if (cancel.gone) return
      send({ type: 'done' })
      res.end()
    } catch (e) {
      failTurn(res, send, e, t)
    } finally {
      release?.()
    }
  }))

  // ---- in-place regeneration: replaces one assistant turn, keeping every
  // earlier attempt as a browsable version instead of overwriting it ----
  app.post('/api/sessions/:id/messages/:messageId/regenerate', auth, turnRoute('/api/sessions/:id/messages/:messageId/regenerate', async (req, res, t) => {
    let release = null
    const send = heartbeatSend(res, () => release)
    const sessionId = req.params.id
    const cancel = (t.cancel = createTurnCancel(res, () => release, () => sessionId))
    try {
      await ensureReady(req)

      t.span.setAttribute('session.id', String(sessionId))
      await getUserModels(req)
      const opts = readTurnOptions(req.body)
      t.span.setAttribute('model', String(opts.model || ''))

      const { variantGroup, messages: history } = await listMessagesBeforeMessage(
        req.email,
        req.token,
        sessionId,
        req.params.messageId
      )
      if (!variantGroup) return res.status(404).json({ error: 'mensagem não encontrada' })
      // after the owner-scoped load; the history before the regenerated message
      // cannot change under a later turn, so it needs no re-read
      if (!(release = lockSession(res, sessionId))) return
      // a cancelled turn may still be writing its answer: write after it
      await awaitSessionDrain(sessionId)
      // cost ledger (only ever summed per user_email), after the owner-scoped load
      setUsageSession(sessionId)

      // the client left before the stream opened: nothing to answer, nothing written
      if (cancel.gone) return
      openSse(res)

      const ctx = await prepareTurn({
        req,
        res,
        send,
        sessionId,
        history,
        // capability gating keyed on the last user turn being regenerated + the
        // history's blocks (so an in-progress deck/spreadsheet flow keeps its policy)
        userText: [...history].reverse().find((m) => m.role === 'user')?.content || '',
        opts,
        // no new attachment on a regenerate turn, but candidates from earlier in
        // the session (past attachments/Genie calls) are still fair game
        chartState: await getSessionChartCandidates(req.email, req.token, sessionId),
        signal: cancel.signal,
        cancel,
      })
      t.span.setAttribute('caps', capsAttr(ctx.caps))
      const result = await runAssistantTurn(ctx)
      if (result.error) t.failed = result.error
      const { assistantMsg } = await finishTurn(ctx, result, { cancel, message: { variantGroup } })
      t.saved = !!assistantMsg
      if (cancel.gone) return
      if (assistantMsg) send({ type: 'variant', messageId: assistantMsg.id, variantGroup })

      // touch updated_at, unless the client left meanwhile (nothing after a cancel)
      await cancel.guard(() => updateSession(req.email, req.token, sessionId, {})).catch((e) => {
        if (!cancel.gone) throw e
      })
      if (cancel.gone) return
      send({ type: 'done' })
      res.end()
    } catch (e) {
      failTurn(res, send, e, t)
    } finally {
      release?.()
    }
  }))
}
