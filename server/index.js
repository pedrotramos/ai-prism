import express from 'express'
import multer from 'multer'
import JSZip from 'jszip'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import {
  ensureSchema,
  ensureSpGrants,
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  addMessage,
  listMessages,
  listMessagesBeforeMessage,
  getMessageRaw,
  activateVariant,
  addToolCalls,
  setSessionEmbedding,
  listSessionsForSearch,
  setMessageEmbedding,
  listMessagesMissingEmbedding,
  listUserMessagesMissingEmbedding,
  retrieveRelevantMessages,
  searchSessionsByVector,
  getSessionChartCandidates,
  saveSessionChartCandidates,
  listDeckTemplates,
  getSelectedDeckTemplate,
  getDeckTemplate,
  templateSummary,
  createDeckTemplate,
  updateDeckTemplate,
  selectDeckTemplate,
  deleteDeckTemplate,
  setDeckTemplateScope,
  listAppAdmins,
  addAppAdmin,
  removeAppAdmin,
  listModelOverrides,
  upsertModelOverride,
  reorderModelOverrides,
  seedModelOverridesIfEmpty,
  listUserMcpConnections,
  adoptUserMcpConnection,
  setUserMcpStatus,
  forgetUserMcpConnection,
  createDeck,
  getDeck,
  updateDeckSlides,
  createSpreadsheet,
  getSpreadsheet,
  updateSpreadsheet,
  createDocument,
  getDocument,
  updateDocument,
  getMessageBlocks,
  setDeckQuestionsAnswers,
  listSkills,
  getSkill,
  upsertSkill,
  deleteSkill,
  setSkillEmbedding,
  getImage,
  listSessionImagePaths,
  getSelectedImageModel,
  setSelectedImageModel,
  getToolPolicy,
  setToolPolicy,
} from './db.js'
import { isAdmin, isOwner, ownerEmail, groupCheckStatus, invalidateAdminsCache, appAccessCandidates, isAppAccessPrincipal } from './authz.js'
import { MODELS, modelById, streamChat, complete, completeWithUsage, generateTitle, classifyIntent, INTENT_MODEL, embed, cosineSim, labelDesignAssets, DEFAULT_IMAGE_MODEL } from './llm.js'
import { extractText, SUPPORTED_EXTENSIONS } from './files.js'
import { transcribe, isMediaFile, transcriptionEnabled, MEDIA_EXTENSIONS, TranscriptionError, mediaModelName } from './transcribe.js'
import { ingestPptx, pptxDeckToBrief } from './pptxIngest.js'
import { analyzeSpreadsheet, isSpreadsheet } from './analysis.js'
import {
  buildBlocksInstruction,
  detectCapabilities,
  shouldClassifyIntent,
  activeSystemSkills,
  SYSTEM_SKILLS,
  extractPrismBlocks,
  stripBlockPlaceholders,
  buildNewCandidatesHint,
  sanitizeHtmlDeck,
  sanitizeSpreadsheet,
  sanitizeDocument,
  sanitizeQuestionAnswers,
  clientWorkingSlides,
  parseInlineImages,
  spliceAttachedImages,
} from './blocks.js'
import { ensureBuiltinPythonTool, searchUcFunctions, buildToolDefs, invokeTool, TOOL_GROUP_KEYS } from './tools.js'
import { routeSkills, renderSkillsInstruction, invalidateSkills } from './skills.js'
import { makeSlideStreamScanner } from './deckHtmlStream.js'
import { buildDsStyleContract } from './deckHtmlPolicy.js'
import { searchGenieSpaces } from './genie.js'
import { searchVectorIndexes } from './vectorSearch.js'
import { searchExternalMcpConnections, probeMcpConnection } from './externalMcp.js'
import { listChatEndpoints, buildAdminCatalog, buildUserModels, buildUserImageModels } from './serving.js'
import { getImageBytes, deleteImageFile } from './imageStore.js'
import { renderPptxFromOps } from './decks.js'
import { renderXlsx } from './xlsx-export.js'
import { renderDocx } from './docx-export.js'

// Resolve the app root for serving the built frontend. In the bundled CJS
// build, Node's native __dirname is the bundle's folder (server-dist/); in ESM
// dev we derive it from import.meta.url. `typeof __dirname` is safe in both.
function baseDir() {
  if (typeof __dirname !== 'undefined') return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}
const DIST = path.join(baseDir(), '..', 'client', 'dist')
const PORT = parseInt(process.env.PORT || '8000', 10)
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
function pushWindowedHistory(apiMessages, history, retrieved = []) {
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
    apiMessages.push({ role: m.role, content: stripBlockPlaceholders(m.content) })
  }
}

// Attaches image data-URLs to the CURRENT user turn as vision input, so a
// vision-capable model actually sees a pasted/attached image (the AI Gateway
// accepts the OpenAI multimodal shape: content = [{type:'text'}, {type:
// 'image_url', image_url:{url:'data:...'}}]). Rewrites the LAST user message in
// apiMessages (the turn being answered) from a plain string into that array.
// No-op when there are no images. Kept out of persisted content — the DB row
// stores only text + the attachment names (bytes aren't re-sent on reload).
function attachImagesToLastUserTurn(apiMessages, images) {
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
async function retrieveHistoryContext(req, sessionId, history, queryText) {
  if (!HISTORY_RETRIEVAL) return []
  if (history.length <= RECENCY_KEEP) return [] // nothing older than the window
  const q = String(queryText || '').trim()
  if (q.length < 3) return []
  try {
    const [qvec] = await embed(req.token, [
      `Instruct: Dada a mensagem atual do usuário, recupere trechos relevantes da conversa.\nQuery: ${q}`,
    ])
    if (!qvec) return []
    return await retrieveRelevantMessages(req.email, req.token, sessionId, qvec, {
      topN: RETRIEVE_TOP_N,
      excludeRecent: RECENCY_KEEP,
      minSimilarity: RETRIEVE_MIN_SIMILARITY,
    })
  } catch (e) {
    console.warn('history retrieval failed:', e.message)
    return []
  }
}

function stripAttach(content) {
  const i = content.indexOf('\n\n--- ANEXOS ---')
  return i >= 0 ? content.slice(0, i) : content
}

// multer/busboy exposes the multipart filename as a latin1-decoded string, so
// UTF-8 names get mangled (e.g. "ção" -> "cÌ§aÌ o"). Re-decode as UTF-8 and
// compose to NFC (macOS sends decomposed accents).
function fixFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8').normalize('NFC')
  } catch {
    return name
  }
}

const app = express()
// 40mb to fit a full design-system BUNDLE import (fonts + specimen cards +
// downscaled backgrounds — see dsImport.js caps); plain mined templates stay
// well under the old 15mb in practice
app.use(express.json({ limit: '40mb' }))
const upload = multer({
  storage: multer.memoryStorage(),
  // Brand .pptx decks are routinely large (embedded imagery/fonts); the real
  // "adjust this presentation" use case needs headroom well past 25MB.
  limits: { fileSize: 80 * 1024 * 1024, files: 10 },
})

// ---- auth (on-behalf-of the signed-in Databricks user) ----
function userEmail(req) {
  return (
    req.headers['x-forwarded-email'] ||
    process.env.DATABRICKS_USER_EMAIL ||
    'local-dev@databricks.com'
  )
}
function userToken(req) {
  return (
    req.headers['x-forwarded-access-token'] ||
    process.env.DATABRICKS_USER_TOKEN ||
    (process.env.LOCAL_DEV_MODE === '1' ? 'local-dev-token' : null)
  )
}

function auth(req, res, next) {
  const token = userToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Token de usuário não encontrado (OAuth do app).' })
  }
  req.email = userEmail(req)
  req.token = token
  next()
}

// schema is created once, lazily, with the first user's token
let schemaReady = false
async function ensureReady(req) {
  if (!schemaReady) {
    await ensureSchema(req.email, req.token)
    schemaReady = true
  }
  // separate latch: the SP role can appear long after the schema did, and
  // only the table owner's identity can apply its grants — so this must keep
  // trying past the schemaReady latch (no-op once granted)
  await ensureSpGrants(req.email, req.token)
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
    console.warn('python tool setup failed, continuing without it:', e.message)
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
  'a mesma ferramenta na esperança de um resultado diferente.'

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
  // the image tool is offered only when the turn is plausibly about an image
  // (caps.image, passed as includeImage) AND the org hasn't disabled the group;
  // buildToolDefs re-checks the policy, this just avoids the work when off.
  const built = await buildToolDefs(enabledToolRefs, req.token, req.email, {
    includePython: ts.ready,
    includeImage: includeImage && toolPolicy['image-gen'] !== false,
    toolPolicy,
    // on an artifact-only turn the caps router asks to drop company-data tools
    // (Genie One etc.) so they can't misfire while building an unrelated deck
    suppressDataTools,
  })
  if (!built.tools.length) return { toolDefs: null, toolResolvers: null }
  return { toolDefs: built.tools, toolResolvers: built.resolvers }
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
function summarizeIntent(args = {}) {
  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
  // strip common lead-ins that add no information to a title
  const stripLeadIn = (s) =>
    clean(s).replace(
      /^(me\s+)?(diga|d[êe]|mostre|traga|liste|calcule|qual\s+(é|e|foi)?|quais\s+(são|sao)?|quanto[s]?|como|preciso\s+(de|saber)|gere|monte|fa[çc]a|busque|buscar|encontre)\b[:,\s]*/i,
      ''
    )
  const truncate = (s, n = 72) => {
    const t = clean(s)
    if (t.length <= n) return t
    // cut on a word boundary, drop trailing punctuation, add an ellipsis
    return t.slice(0, n).replace(/\s+\S*$/, '').replace(/[.,;:!?-]+$/, '') + '…'
  }
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
function toolCallLabel(resolver, args, fallbackName) {
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
      return withParts(resolver.ref?.connectionName || 'MCP', resolver.mcpToolName)
    case 'mcp-external-error':
      return `${resolver.connectionName} · indisponível`
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
}) {
  let answer = ''
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
    for await (const chunk of streamChat(req.token, model, msgs, { temperature, tools })) {
      if (chunk.reasoning) {
        // reasoning-summary tokens (if this endpoint streams them): keep them
        // OUT of `content`/`answer` — they're a live "what I'm working on"
        // signal for the UI during the otherwise-silent gap before the model
        // commits to its next narration/tool call, not part of the saved reply.
        send({ type: 'reasoning', value: chunk.reasoning })
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
    for (let round = 0; round < MAX_ROUNDS && !res.writableEnded; round++) {
      const lastRound = round === MAX_ROUNDS - 1
      // Drop tools on the final allowed round OR once the model is detected
      // spinning — either way it's forced to WRITE its answer with what it has
      // instead of calling yet another tool. Without a guaranteed synthesis
      // round, a turn that keeps calling tools exits with its last content being
      // a tool call (no prose): the message persists empty and any prism-block
      // the user asked for (a spreadsheet, a deck) is never authored.
      const synthesize = lastRound || forceSynthesis
      const roundTools = synthesize ? null : toolDefs
      if (synthesize) {
        // record WHY we're cutting tools, so the caller can surface an honest
        // notice — the answer isn't "complete", it's the best with data so far
        stoppedEarly = forceSynthesis ? 'loop' : 'ceiling'
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
        if (roundTools && round === 0) {
          toolDefs = null
          result = await runRound(apiMessages, null)
        } else {
          throw e
        }
      }
      answer += result.content
      if (!result.toolCalls?.length || res.writableEnded) break

      // a model calling a tool with no parameters (e.g. the mcp-external
      // status tool) sometimes streams an empty `arguments` string instead
      // of "{}" — replaying that empty string back to the gateway as tool
      // history fails ("not a valid JSON string"), so it's normalized here,
      // once, before both replay and parsing below.
      for (const tc of result.toolCalls) {
        if (!tc.function.arguments) tc.function.arguments = '{}'
      }

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
          const invoked = await invokeTool(req.token, resolver, args, { sessionId, email: req.email, imageModel, baseImages, lang, onProgress })
          resultText = invoked.resultText
          newCandidates = invoked.chartCandidates || []
          if (invoked.imageRefs?.length) imageRefs.push(...invoked.imageRefs)
        } catch (e) {
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
    send({ type: 'error', error: e.message })
  }

  return { answer, usage, hadUsage, toolTrace, imageRefs, truncated: finishReason === 'length', stoppedEarly }
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
  const key = stoppedEarly === 'loop' ? 'stoppedLoop' : stoppedEarly === 'ceiling' ? 'stoppedCeiling' : null
  if (!key) return content
  const notice = serverMsg(lang, key)
  send({ type: 'error', error: notice })
  return content ? `${content}\n\n${notice}` : notice
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

// ---- API ----
app.get('/api/me', auth, async (req, res) => {
  try {
    await ensureReady(req)
    res.json({ email: req.email, isAdmin: await isAdmin(req.email, req.token), isOwner: isOwner(req.email) })
  } catch (e) {
    // identity must never fail the app shell — degrade to non-admin
    res.json({ email: req.email, isAdmin: isOwner(req.email), isOwner: isOwner(req.email) })
  }
})

// admin gate for management routes: 403 for signed-in non-admins
async function requireAdmin(req, res, next) {
  try {
    await ensureReady(req)
    if (await isAdmin(req.email, req.token)) return next()
    res.status(403).json({ error: 'apenas administradores' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

app.get('/api/admins', auth, requireAdmin, async (req, res) => {
  try {
    res.json({
      owner: ownerEmail(),
      admins: await listAppAdmins(req.email, req.token),
      groupCheck: groupCheckStatus(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// autocomplete for the admin form: everyone already granted CAN_USE/CAN_MANAGE
// on the app (best-effort — empty list just disables suggestions)
app.get('/api/admins/candidates', auth, requireAdmin, async (req, res) => {
  res.json({ candidates: await appAccessCandidates(req.token) })
})

app.post('/api/admins', auth, requireAdmin, async (req, res) => {
  try {
    const principal = String(req.body?.principal || '').trim()
    const kind = req.body?.kind === 'group' ? 'group' : 'user'
    if (!principal || principal.length > 200) return res.status(400).json({ error: 'principal inválido' })
    if (kind === 'user' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(principal))
      return res.status(400).json({ error: 'para kind=user o principal deve ser um e-mail' })
    // Only principals that already have access to the app (CAN_USE/CAN_MANAGE in
    // the Databricks Apps permission layer) can be promoted to admin. If the ACL
    // couldn't be read at all, don't silently reject — say so (503) so the UI
    // can tell "not allowed" apart from "couldn't verify".
    const access = await isAppAccessPrincipal(principal, kind, req.token)
    if (!access.reachable)
      return res.status(503).json({ error: 'não foi possível verificar o acesso ao app; tente novamente' })
    if (!access.ok)
      return res.status(400).json({ error: 'sem_acesso' })
    await addAppAdmin(req.email, req.token, principal, kind)
    invalidateAdminsCache()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/admins/:principal', auth, requireAdmin, async (req, res) => {
  try {
    await removeAppAdmin(req.email, req.token, decodeURIComponent(req.params.principal))
    invalidateAdminsCache()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Cache of the user-facing model list (enabled-only, admin-curated). Refreshed
// from model_catalog_overrides; a short TTL keeps a newly-enabled model showing
// up quickly without a DB hit on every chat turn. Falls back to static MODELS.
let userModelsCache = { list: MODELS, ids: new Set(MODELS.map((m) => m.id)), ts: 0 }
const USER_MODELS_TTL_MS = 30 * 1000

async function getUserModels(req) {
  if (Date.now() - userModelsCache.ts < USER_MODELS_TTL_MS) return userModelsCache.list
  try {
    await ensureReady(req)
    const overrides = await listModelOverrides(req.email, req.token)
    const list = buildUserModels(overrides)
    userModelsCache = { list, ids: new Set(list.map((m) => m.id)), ts: Date.now() }
  } catch (e) {
    // never fail the picker — keep whatever we last had (or static MODELS)
    userModelsCache = { ...userModelsCache, ts: Date.now() }
  }
  return userModelsCache.list
}

// Validate a requested model id against the enabled set (falls back to the
// default). Uses the cache populated by getUserModels — call after it, or it
// simply allows only what was last cached (safe: worst case the default).
function resolveModelId(requested) {
  const def = userModelsCache.list[0]?.id || MODELS[0].id
  if (typeof requested !== 'string' || !requested) return def
  return userModelsCache.ids.has(requested) ? requested : def
}

app.get('/api/models', auth, async (req, res) => {
  const models = await getUserModels(req)
  // Media extensions are only offered when transcription is enabled, so the
  // file picker doesn't invite an upload the workspace can't process. The two
  // lists are kept separate on the wire so the client can label media distinctly.
  const mediaExtensions = transcriptionEnabled() ? MEDIA_EXTENSIONS : []
  res.json({
    models,
    supported_extensions: SUPPORTED_EXTENSIONS,
    media_extensions: mediaExtensions,
  })
})

// Image-generation models the user can choose from (Settings → image model),
// plus their current selection (null → the org default is used). Separate from
// /api/models: image endpoints never appear in the chat picker and vice-versa.
app.get('/api/image-models', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const overrides = await listModelOverrides(req.email, req.token).catch(() => ({}))
    const models = buildUserImageModels(overrides)
    const selected = await getSelectedImageModel(req.email, req.token).catch(() => null)
    // Which model "Padrão" actually resolves to, so the UI can name it
    // explicitly instead of an opaque "Default". Matches the tool's fallback
    // (DEFAULT_IMAGE_MODEL) when it's among the enabled models, else the first
    // enabled image model — exactly what a turn with no explicit choice uses.
    const defaultId = models.some((m) => m.id === DEFAULT_IMAGE_MODEL)
      ? DEFAULT_IMAGE_MODEL
      : models[0]?.id || null
    res.json({ models, selected, defaultId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/image-models/selected', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : ''
    if (!modelId) return res.status(400).json({ error: 'modelId obrigatório' })
    await setSelectedImageModel(req.email, req.token, modelId)
    res.json({ ok: true, selected: modelId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Org tool policy: which built-in tool GROUPS are available. The user-facing
// read (picker hides disabled groups); a missing key means enabled (default-on).
app.get('/api/tool-policy', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const policy = await getToolPolicy(req.email, req.token).catch(() => ({}))
    res.json({ policy, keys: TOOL_GROUP_KEYS })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/admin/tool-policy/:key', auth, requireAdmin, async (req, res) => {
  try {
    const key = req.params.key
    if (!TOOL_GROUP_KEYS.includes(key)) return res.status(400).json({ error: 'tool inválida' })
    await setToolPolicy(req.email, req.token, key, !!req.body?.enabled)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- admin: AI Gateway model catalog -----------------------------------
// list live endpoints ∪ curated ∪ overrides; seeds overrides from the static
// MODELS the first time so switching /api/models to enabled-only never strands
// the org with no models.
app.get('/api/admin/model-endpoints', auth, requireAdmin, async (req, res) => {
  try {
    await seedModelOverridesIfEmpty(req.email, req.token, MODELS)
    const [discovered, overrides] = await Promise.all([
      listChatEndpoints(req.token),
      listModelOverrides(req.email, req.token),
    ])
    res.json({ endpoints: buildAdminCatalog(discovered, overrides) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/admin/model-endpoints/:id', auth, requireAdmin, async (req, res) => {
  try {
    const endpointId = decodeURIComponent(req.params.id)
    const b = req.body || {}
    // prices: accept a non-negative number, else null (→ fall back to the
    // curated/family-inferred default). Guards against NaN/negatives from the UI.
    const price = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null)
    await upsertModelOverride(req.email, req.token, endpointId, {
      enabled: !!b.enabled,
      displayName: typeof b.displayName === 'string' ? b.displayName.slice(0, 120) : '',
      blurb: typeof b.blurb === 'string' ? b.blurb.slice(0, 300) : '',
      sortOrder: Number.isInteger(b.sortOrder) ? b.sortOrder : null,
      priceIn: price(b.priceIn),
      priceOut: price(b.priceOut),
    })
    userModelsCache.ts = 0 // force refresh so users see the change quickly
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Reorder the enabled models. Body: { order: [endpointId, ...] } — index 0 is
// first in the picker AND the default model for new chats (see getUserModels /
// the client's models[0]). Admin-only, like the other catalog mutations.
app.put('/api/admin/model-endpoints-order', auth, requireAdmin, async (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order.filter((x) => typeof x === 'string') : null
    if (!order || !order.length) return res.status(400).json({ error: 'order (array de ids) obrigatório' })
    await reorderModelOverrides(req.email, req.token, order)
    userModelsCache.ts = 0 // force refresh so the new default/order shows quickly
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/sessions', auth, async (req, res) => {
  try {
    await ensureReady(req)
    res.json({ sessions: await listSessions(req.email, req.token) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// semantic search over the user's chat history — pgvector-backed: the ranking
// runs IN the database over per-message embeddings (indexed HNSW), instead of
// pulling every session vector into Node for a JS cosine loop. Each session
// scores by its best-matching message, so a hit on any turn surfaces it.
app.get('/api/search', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const q = (req.query.q || '').toString().trim()
    if (!q) return res.json({ results: [] })

    // qwen3-embedding is instruction-tuned: queries use an Instruct/Query
    // prefix for asymmetric retrieval; passages (messages) stay plain.
    const qtext = `Instruct: Dada uma busca do usuário, recupere conversas de chat relevantes.\nQuery: ${q}`
    const [qvec] = await embed(req.token, [qtext])
    if (!qvec) return res.json({ results: [] })

    const results = await searchSessionsByVector(req.email, req.token, qvec, { limit: 20, minSimilarity: 0.3 })
    res.json({ results })

    // fire-and-forget: index any history that predates per-message embeddings so
    // subsequent searches cover the full backlog (runs once per user/process)
    backfillUserMessageEmbeddings(req).catch(() => {})
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/sessions/:id/messages', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const msgs = await listMessages(req.email, req.token, req.params.id)
    res.json({ messages: msgs })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/sessions/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const fields = {}
    if (typeof req.body.title === 'string') fields.title = req.body.title
    if (typeof req.body.model === 'string') fields.model = req.body.model
    if (typeof req.body.system_prompt === 'string') fields.system_prompt = req.body.system_prompt
    if (Array.isArray(req.body.enabled_tools)) fields.enabled_tools = req.body.enabled_tools
    await updateSession(req.email, req.token, req.params.id, fields)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Unity Catalog Functions the user can attach as extra tools
app.get('/api/tools/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchUcFunctions(req.token, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Genie Spaces the user can attach as extra tools
app.get('/api/tools/genie/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchGenieSpaces(req.token, req.email, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Vector Search indexes the user can attach as extra tools
app.get('/api/tools/vector-search/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchVectorIndexes(req.token, req.email, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Unity Catalog connections registered as external MCP servers
app.get('/api/tools/mcp/external/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchExternalMcpConnections(req.token, req.email, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- external MCP connections (per-user adopt + auth status) -----------
// The settings tab where the user browses the catalog, connects (one-time
// OAuth consent via the managed proxy), and sees status. The tool picker then
// shows adopted connections as on/off toggles (default on).
app.get('/api/mcp/connections', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const q = (req.query.q || '').toString().trim()
    const [catalog, adopted] = await Promise.all([
      // pass the query so a typed fully-qualified name surfaces as a
      // "connect by name" candidate (validated OBO at connect time)
      searchExternalMcpConnections(req.token, req.email, q),
      listUserMcpConnections(req.email, req.token),
    ])
    const adoptedByName = new Map(adopted.map((a) => [a.connectionName, a]))
    // union: everything in the catalog, annotated with adoption + last status
    let connections = catalog.map((c) => {
      const a = adoptedByName.get(c.connectionName)
      return {
        connectionName: c.connectionName,
        comment: c.comment || a?.comment || '',
        adopted: !!a,
        status: a?.status || 'unknown',
        lastCheckedAt: a?.lastCheckedAt || null,
      }
    })
    // semantic search over name + description (item 3). Only when a query is
    // present; ranks by embedding cosine similarity, so "ferramentas de
    // git/código" surfaces "ah-github" even without a literal match. Falls back
    // to substring filtering if embeddings are unavailable.
    if (q) connections = await rankMcpConnections(req.token, q, connections)
    res.json({ connections })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Ranks MCP connections against a natural-language query by embedding cosine
// similarity of "name — description". Connection embeddings are cached per
// process (the catalog changes rarely); only the query is embedded per call.
// On any embedding failure, degrades to substring filtering so search still
// works. Keeps items above a light relevance floor, best-first.
const mcpEmbedCache = new Map() // key `${name}\n${comment}` -> vector
async function rankMcpConnections(token, query, connections) {
  const substringFallback = () => {
    const ql = query.toLowerCase()
    return connections.filter(
      (c) => c.connectionName.toLowerCase().includes(ql) || (c.comment || '').toLowerCase().includes(ql)
    )
  }
  try {
    const passages = connections.map((c) => `${c.connectionName} — ${c.comment || 'sem descrição'}`)
    const missing = passages.filter((p) => !mcpEmbedCache.has(p))
    if (missing.length) {
      const vecs = await embed(token, missing)
      missing.forEach((p, i) => vecs[i] && mcpEmbedCache.set(p, vecs[i]))
    }
    // qwen3-embedding is instruction-tuned: queries take an Instruct/Query prefix
    const [qvec] = await embed(token, [
      `Instruct: Dada a intenção do usuário, recupere conexões MCP (ferramentas) relevantes.\nQuery: ${query}`,
    ])
    if (!qvec) return substringFallback()
    const scored = connections
      .map((c, i) => ({ c, score: cosineSim(qvec, mcpEmbedCache.get(passages[i])) }))
      .sort((a, b) => b.score - a.score)
    // Relative floor: keep items within a band of the top score, so a clearly
    // irrelevant tail drops off but near-ties survive. This adapts to the
    // embedding model's baseline similarity (qwen runs high) better than a
    // fixed threshold. Union in any substring match so a literal query never
    // loses an obvious hit to ranking.
    const top = scored[0]?.score || 0
    const ql = query.toLowerCase()
    const kept = scored.filter(
      (x) =>
        x.score >= top - 0.08 ||
        x.c.connectionName.toLowerCase().includes(ql) ||
        (x.c.comment || '').toLowerCase().includes(ql)
    )
    const out = (kept.length ? kept : scored).map((x) => x.c)
    return out.length ? out : substringFallback()
  } catch {
    return substringFallback()
  }
}

// Probe a connection's auth state now (on demand — used by the "Conectar" /
// "Verificar" button). Persists the probed status if the connection is adopted.
app.post('/api/mcp/connections/:name/probe', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const name = decodeURIComponent(req.params.name)
    const result = await probeMcpConnection(req.token, name)
    // remember the status for adopted connections (best-effort)
    try {
      await setUserMcpStatus(req.email, req.token, name, result.status)
    } catch {}
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Adopt a connection (the user chose to use it). Probes status at adopt time so
// the row lands with a real state; default-on in the tool picker follows from
// being adopted.
app.post('/api/mcp/connections/:name', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const name = decodeURIComponent(req.params.name)
    const comment = typeof req.body?.comment === 'string' ? req.body.comment : ''
    const probe = await probeMcpConnection(req.token, name).catch(() => ({ status: 'unknown' }))
    await adoptUserMcpConnection(req.email, req.token, name, comment, probe.status)
    res.json({ ok: true, status: probe.status, loginUrl: probe.loginUrl || '' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/mcp/connections/:name', auth, async (req, res) => {
  try {
    await ensureReady(req)
    await forgetUserMcpConnection(req.email, req.token, decodeURIComponent(req.params.name))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- authored skills -----------------------------------------------------
// A skill = a named capability whose `body` is injected into the system prompt
// only when a turn is routed to it (see server/skills.js). Users CRUD their own
// (scope 'user'); admins additionally CRUD 'global' skills for the whole org.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// Parses a SKILL.md-style document: optional YAML frontmatter (name,
// description) + markdown body. Minimal YAML (key: value) — no dependency.
function parseSkillMarkdown(text) {
  const out = { name: '', description: '', body: String(text || '').trim() }
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(text || ''))
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      let val = kv[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name') out.name = val
      else if (key === 'description') out.description = val
      else if (key === 'title') out.title = val
    }
    out.body = m[2].trim()
  }
  return out
}

// Persist a skill and (re)compute its routing embedding right away, so the
// first turn that could use it doesn't pay the embedding cost. Best-effort on
// the embedding — the router backfills it lazily if this fails.
async function saveSkillWithEmbedding(req, skill) {
  let id
  try {
    id = await upsertSkill(req.email, req.token, skill)
  } catch (e) {
    // the partial unique indexes on (name) enforce one skill-name per scope;
    // surface a clean conflict instead of the raw Postgres constraint error
    if (/unique constraint|duplicate key/i.test(e.message || '')) {
      const err = new Error(`já existe uma skill chamada "${skill.name}" neste escopo`)
      err.status = 409
      throw err
    }
    throw e
  }
  invalidateSkills(req.email)
  if (id) {
    try {
      const [vec] = await embed(req.token, [`${skill.title} — ${skill.description}`])
      if (vec) await setSkillEmbedding(req.email, req.token, id, vec)
    } catch {}
  }
  return id
}

app.get('/api/skills', auth, async (req, res) => {
  try {
    await ensureReady(req)
    // list view doesn't need the (large) bodies/embeddings
    const authored = await listSkills(req.email, req.token, { includeBody: false })
    // prepend the built-in capabilities as read-only "system" skills so every
    // deployment shows deck/spreadsheet/chart generation in the tab out of the
    // box — no seeding, no DB rows; their bodies live in code (blocks.js).
    const system = SYSTEM_SKILLS.map((s) => ({
      id: `system:${s.name}`,
      scope: 'system',
      name: s.name,
      title: s.title,
      description: s.description,
      enabled: true,
      readOnly: true,
    }))
    res.json({ skills: [...system, ...authored], isAdmin: await isAdmin(req.email, req.token) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/skills/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const skill = await getSkill(req.email, req.token, req.params.id)
    if (!skill) return res.status(404).json({ error: 'skill não encontrada' })
    res.json({ skill })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// create or update. `scope: 'global'` requires admin.
async function writeSkillHandler(req, res) {
  try {
    await ensureReady(req)
    const b = req.body || {}
    const scope = b.scope === 'global' ? 'global' : 'user'
    if (scope === 'global' && !(await isAdmin(req.email, req.token))) {
      return res.status(403).json({ error: 'apenas administradores podem editar skills globais' })
    }
    const title = (b.title || '').trim()
    const description = (b.description || '').trim()
    const body = (b.body || '').trim()
    if (!title || !description || !body) {
      return res.status(400).json({ error: 'título, descrição e instruções são obrigatórios' })
    }
    const name = slugify(b.name || title)
    const triggers = Array.isArray(b.triggers)
      ? b.triggers.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : []
    const id = await saveSkillWithEmbedding(req, {
      id: b.id || null,
      scope,
      name,
      title: title.slice(0, 120),
      description: description.slice(0, 400),
      body: body.slice(0, 20000),
      triggers,
      source: b.source || 'write',
      enabled: b.enabled !== false,
    })
    if (!id) return res.status(404).json({ error: 'skill não encontrada ou sem permissão' })
    res.json({ ok: true, id })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
}
app.post('/api/skills', auth, writeSkillHandler)
app.put('/api/skills/:id', auth, (req, res) => {
  req.body = { ...(req.body || {}), id: req.params.id }
  return writeSkillHandler(req, res)
})

// upload a SKILL.md (YAML frontmatter) or a .zip/.skill bundle containing one
app.post('/api/skills/upload', auth, upload.single('file'), async (req, res) => {
  try {
    await ensureReady(req)
    if (!req.file) return res.status(400).json({ error: 'nenhum arquivo enviado' })
    const scope = req.body?.scope === 'global' ? 'global' : 'user'
    if (scope === 'global' && !(await isAdmin(req.email, req.token))) {
      return res.status(403).json({ error: 'apenas administradores podem criar skills globais' })
    }
    const fname = fixFilename(req.file.originalname || '')
    let mdText = ''
    if (/\.(zip|skill)$/i.test(fname)) {
      const zip = await JSZip.loadAsync(req.file.buffer)
      // find a SKILL.md anywhere in the bundle (case-insensitive)
      const entry = Object.keys(zip.files).find((p) => /(^|\/)SKILL\.md$/i.test(p))
      if (!entry) return res.status(400).json({ error: 'o .zip/.skill precisa conter um arquivo SKILL.md' })
      mdText = await zip.files[entry].async('string')
    } else if (/\.(md|markdown|txt)$/i.test(fname)) {
      mdText = req.file.buffer.toString('utf8')
    } else {
      return res.status(400).json({ error: 'formato não suportado — envie um .md ou um .zip/.skill com SKILL.md' })
    }
    const parsed = parseSkillMarkdown(mdText)
    const title = (parsed.title || parsed.name || fname.replace(/\.[^.]+$/, '')).trim()
    const description = parsed.description.trim()
    const body = parsed.body.trim()
    if (!description || !body) {
      return res.status(400).json({ error: 'o SKILL.md precisa de "description" no YAML e um corpo de instruções' })
    }
    const id = await saveSkillWithEmbedding(req, {
      scope,
      name: slugify(parsed.name || title),
      title: title.slice(0, 120),
      description: description.slice(0, 400),
      body: body.slice(0, 20000),
      triggers: [],
      source: 'upload',
      enabled: true,
    })
    res.json({ ok: true, id })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

app.delete('/api/skills/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const ok = await deleteSkill(req.email, req.token, req.params.id, {
      allowGlobal: await isAdmin(req.email, req.token),
    })
    invalidateSkills(req.email)
    if (!ok) return res.status(404).json({ error: 'skill não encontrada ou sem permissão' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/sessions/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    // purge generated-image Volume files before the DB rows cascade away — the
    // chat_images rows go with the session, but the Volume bytes would orphan.
    // Best-effort: a failed file delete never blocks the session delete.
    try {
      const paths = await listSessionImagePaths(req.email, req.token, req.params.id)
      await Promise.all(paths.map((p) => deleteImageFile(req.token, p)))
    } catch (e) {
      console.warn('limpeza de imagens da sessão falhou:', e.message)
    }
    await deleteSession(req.email, req.token, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// a user's collection of presentation style templates ("design systems"),
// exactly one selected at a time (Settings → Modelos de apresentação).
// The list ships SUMMARIES (no readme/specimen cards — see templateSummary);
// the by-id route below returns the full row for the Design System viewer.
app.get('/api/deck-templates', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const [templates, admin] = await Promise.all([
      listDeckTemplates(req.email, req.token),
      isAdmin(req.email, req.token),
    ])
    // visible non-global rows are always the caller's own; global rows are
    // read-only unless the caller is an admin (server enforces on write too)
    res.json({
      templates: templates.map((t) => ({ ...templateSummary(t), canEdit: t.scope !== 'global' || admin })),
      isAdmin: admin,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Render bundle: only the SELECTED template, with iconAssets cut to the kinds
// the painters actually resolve (icon/image refs on slides, illustration art
// in the theme — see shared/deckTheme.js). The chat deck cards and the Studio
// load this on every deck open, so it must stay lean: a mined design system's
// full asset library (backgrounds, lockups) can be tens of MB and belongs
// only to the Settings grid, which keeps the full list endpoint.
// NOTE: registered before /api/deck-templates/:id — Express matches in order.
const RENDER_ASSET_KINDS = new Set(['icon', 'image', 'illustration'])
app.get('/api/deck-templates/selected', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const t = await getSelectedDeckTemplate(req.email, req.token)
    if (!t) return res.json({ template: null })
    const template = templateSummary(t)
    template.iconAssets = (template.iconAssets || []).filter((a) => !a.kind || RENDER_ASSET_KINDS.has(a.kind))
    res.json({ template })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/deck-templates/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const template = await getDeckTemplate(req.email, req.token, req.params.id)
    if (!template) return res.status(404).json({ error: 'modelo não encontrado' })
    res.json({ template })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// cheap shape/cap validation so a malformed client payload can't persist
// garbage into a design system (400 with the offending fields, not a 500)
function validateTemplatePayload(t) {
  const bad = []
  const hexOk = (v) => !v || /^#[0-9A-Fa-f]{6}$/.test(v)
  for (const k of ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor']) {
    if (!hexOk(t[k])) bad.push(k)
  }
  if (t.palette !== undefined) {
    const ok =
      Array.isArray(t.palette) &&
      t.palette.length <= 64 &&
      t.palette.every((p) => p && typeof p.varName === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.value || ''))
    if (!ok) bad.push('palette')
  }
  if (t.iconAssets !== undefined) {
    const kinds = new Set(['icon', 'image', 'watermark', 'illustration', 'background', 'lockup'])
    const ok =
      Array.isArray(t.iconAssets) &&
      t.iconAssets.length <= 200 &&
      t.iconAssets.every(
        (a) => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:') && (!a.kind || kinds.has(a.kind))
      )
    if (!ok) bad.push('iconAssets')
  }
  if (t.fontAssets !== undefined) {
    const ok =
      Array.isArray(t.fontAssets) &&
      t.fontAssets.length <= 16 &&
      t.fontAssets.every((f) => f && typeof f.family === 'string' && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:'))
    if (!ok) bad.push('fontAssets')
  }
  if (t.dsCards !== undefined) {
    // Per-card ceiling matches the importer's CARD_MAX_HTML (dsImport.js): rich
    // template/slide specimens legitimately inline several downscaled rasters
    // (Reference Architecture ~2.1MB), so a 700KB cap here silently 400'd the
    // very cards the flagship bundle exists to show. The 24MB body limit
    // (express.json) and 120-card count still bound the total payload.
    const ok =
      Array.isArray(t.dsCards) &&
      t.dsCards.length <= 120 &&
      t.dsCards.every((c) => c && typeof c.html === 'string' && c.html.length <= 2_600_000)
    if (!ok) bad.push('dsCards')
  }
  return bad
}

app.post('/api/deck-templates', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const body = req.body || {}
    delete body._importReport // review-UI bookkeeping, never persisted
    const bad = validateTemplatePayload(body)
    if (bad.length) return res.status(400).json({ error: `payload inválido nos campos: ${bad.join(', ')}` })
    const template = await createDeckTemplate(req.email, req.token, body)
    res.json({ template })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Semantic labeling of mined design-system assets with a vision model — the
// import flow sends thumbnail-sized copies; the returned labels only steer
// asset choice in prompts (never slide content). Stateless: the client merges
// labels into the (still unsaved) template draft.
app.post('/api/deck-templates/label-assets', auth, async (req, res) => {
  try {
    const assets = (Array.isArray(req.body?.assets) ? req.body.assets : [])
      .filter((a) => a && typeof a.id === 'string' && typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl))
      .slice(0, 40)
      .map((a) => ({ id: a.id.slice(0, 60), kind: typeof a.kind === 'string' ? a.kind.slice(0, 12) : 'icon', dataUrl: a.dataUrl.slice(0, 300_000) }))
    const diagrams = (Array.isArray(req.body?.diagrams) ? req.body.diagrams : [])
      .filter((d) => d && typeof d.id === 'string')
      .slice(0, 8)
      .map((d) => ({ id: d.id.slice(0, 60), texts: (Array.isArray(d.texts) ? d.texts : []).map((t) => String(t).slice(0, 60)) }))
    if (!assets.length && !diagrams.length) return res.json({ labels: {} })
    res.json({ labels: await labelDesignAssets(req.token, assets, diagrams) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/deck-templates/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const body = req.body || {}
    delete body._importReport
    const bad = validateTemplatePayload(body)
    if (bad.length) return res.status(400).json({ error: `payload inválido nos campos: ${bad.join(', ')}` })
    const admin = await isAdmin(req.email, req.token)
    const ok = await updateDeckTemplate(req.email, req.token, req.params.id, body, admin)
    if (!ok) return res.status(403).json({ error: 'sem permissão para editar este modelo' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/deck-templates/:id/select', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const ok = await selectDeckTemplate(req.email, req.token, req.params.id)
    if (!ok) return res.status(404).json({ error: 'modelo não encontrado' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/deck-templates/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const admin = await isAdmin(req.email, req.token)
    const ok = await deleteDeckTemplate(req.email, req.token, req.params.id, admin)
    if (!ok) return res.status(403).json({ error: 'sem permissão para excluir este modelo' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// publishes/unpublishes a template org-wide: global rows appear (read-only)
// for every user and become the default starting point for new users
app.post('/api/deck-templates/:id/scope', auth, requireAdmin, async (req, res) => {
  try {
    const scope = req.body?.scope === 'global' ? 'global' : 'user'
    const ok = await setDeckTemplateScope(req.email, req.token, req.params.id, scope)
    if (!ok) return res.status(404).json({ error: 'modelo não encontrado' })
    res.json({ ok: true, scope })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
      return res.json({ ok: true })
    }
    // Every deck is pure-HTML now; a payload that isn't is a legacy semantic-tree
    // deck whose editor has been removed.
    return res.status(410).json({ error: 'este deck está num formato antigo que não é mais editável — gere um novo deck' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Natural-language "tweak": the Studio sends an instruction (optionally
// scoped to a clicked element — see SelBox in DeckSlidePreview.jsx) and the
// model returns the revised slide/deck JSON, revalidated by the exact same
// sanitizers as generation, then persisted. Small, synchronous, non-streaming:
// a tweak is one focused edit, not a chat turn.
const TWEAK_MAX_TOKENS = 16384

// Robust JSON extraction from a model reply: tolerates a prose preamble/note,
// markdown fences placed anywhere, and trailing text by scanning for the first
// balanced {...} or [...] (respecting string literals + escapes). Returns null
// only when there is genuinely no JSON value to recover. Far more forgiving
// than a leading/trailing fence strip, which broke whenever the model added
// any surrounding prose.
function extractJson(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // fall through to balanced-scan
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = cleaned.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

// Instruction appended to the deck-tweak system prompt when the user attached
// image(s). The model DECIDES per attachment whether it's an ASSET to place in
// the slide or just visual REFERENCE — we don't force a rule (an inspiration
// image must not get dumped onto the slide). When it inserts one, it emits a
// `<img data-attach="N">` marker (N = 1-based attachment index) and we splice
// the real bytes in afterwards, so the exact file (incl. SVG, kept vector) lands
// — never a redrawn approximation.
function imageAttachInstruction(images) {
  const n = images.length
  return (
    ` O usuário anexou ${n === 1 ? 'uma imagem' : `${n} imagens`} (numeradas de 1 a ${n}, na ordem enviada). ` +
    'DECIDA o papel de cada uma pela instrução e pelo contexto: ' +
    '(a) se é um ATIVO para COLOCAR no slide (um logo, uma foto, um ícone que o usuário quer usar), ' +
    'insira-a com um marcador `<img data-attach="N">` (N = número da imagem) posicionando e ' +
    'dimensionando da melhor forma no layout (use style inline com left/top/width/height ou as classes/flex do slide; ' +
    'prefira `object-fit:contain` para não deformar). NÃO redesenhe a imagem em SVG/CSS nem invente um placeholder — ' +
    'use o marcador e nós inserimos o arquivo real. ' +
    '(b) se é apenas REFERÊNCIA visual/inspiração (paleta, estilo, layout a imitar), NÃO a insira — só use como guia. ' +
    'Na dúvida entre inserir ou não, prefira tratar como referência.'
  )
}

// Compact digest of the conversation a deck came from, for grounding an AI
// tweak (task #45). Plain-text roles only, tool traces and block payloads
// dropped, capped so it stays token-affordable. Returns '' when there's no
// session or nothing usable. Never throws to the caller — grounding is
// best-effort.
async function buildTweakChatContext(req, sessionId) {
  if (!sessionId) return ''
  const msgs = await listMessages(req.email, req.token, sessionId)
  if (!msgs?.length) return ''
  const parts = []
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = String(m.content || '')
      .replace(/\{\{block:\d+\}\}/g, '')      // block placeholders
      .replace(/\{\{toolcall:[^}]+\}\}/g, '') // inline tool-call markers
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    parts.push(`${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${text.slice(0, 1200)}`)
  }
  if (!parts.length) return ''
  // keep the most recent exchanges (the deck's subject + latest refinements)
  let digest = parts.slice(-16).join('\n')
  if (digest.length > 6000) digest = digest.slice(-6000)
  return digest
}

app.post('/api/decks/:id/tweak', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const deck = await getDeck(req.email, req.token, req.params.id)
    if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
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

// ---- generated images (bytes live on a UC Volume) ----
// Streams the PNG back, scoped by user_email (the DB read enforces ownership;
// the Volume read uses the user's own token). Cacheable — image bytes for a
// given id never change.
app.get('/api/images/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const img = await getImage(req.email, req.token, req.params.id)
    if (!img) return res.status(404).json({ error: 'imagem não encontrada' })
    const bytes = await getImageBytes(req.token, img.volumePath)
    res.setHeader('Content-Type', img.contentType || 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.send(bytes)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
    await updateSpreadsheet(req.email, req.token, req.params.id, revalidated.title, spec)
    res.json({ spreadsheet: { id: String(req.params.id), ...spec }, usage: ssUsage, model })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
    await updateDocument(req.email, req.token, req.params.id, sanitized.title, sanitized.markdown)
    res.json({ document: { id: String(req.params.id), title: sanitized.title, markdown: sanitized.markdown }, usage: docUsage, model })
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

// ---- streaming chat ----
app.post('/api/chat', auth, upload.array('files'), async (req, res) => {
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
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
    const model = resolveModelId(payload.model)
    const temperature = typeof payload.temperature === 'number' ? payload.temperature : 0.7
    const systemPrompt = (payload.systemPrompt || '').trim()
    const responseLang = payload.responseLang
    const uiLang = payload.uiLang
    const enabledToolRefs = Array.isArray(payload.enabledTools) ? payload.enabledTools : []
    let sessionId = payload.sessionId || null

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
          console.warn(`transcrição falhou (${name}):`, why)
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
          console.warn(`análise de planilha falhou (${name}):`, e.message)
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
          console.warn(`ingestão de pptx falhou (${name}):`, e.message)
        }
      }
    }

    // open SSE
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    // create session lazily on first message
    let isNew = false
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
    }

    // Kick off the reads that DON'T depend on the user-message write, so they
    // overlap with it instead of running serially: chart candidates (session
    // lifetime — a report compiled several turns after the Genie calls that
    // fetched the numbers still needs them to resolve its prism-block fences).
    // The selected deck template is NOT fetched here — it's a heavy render-cut
    // payload (MBs of jsonb) only the deck flow uses, so it's resolved lazily
    // below, and only when this turn is actually about a deck (see caps.deck).
    const chartStatePromise = isNew
      ? Promise.resolve({ nextId: 1, items: [] })
      : getSessionChartCandidates(req.email, req.token, sessionId)

    const fullContent = attachBlocks.length
      ? prompt + ATTACH_MARKER + attachBlocks.join('\n\n')
      : prompt

    // the user-message write MUST land before we read the history back
    await addMessage(req.email, req.token, {
      sessionId,
      role: 'user',
      content: fullContent,
      attachments: attachNames.length ? JSON.stringify(attachNames) : null,
    })

    send({ type: 'meta', sessionId: String(sessionId), isNew })

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
    // below). Best-effort: on failure/timeout, caps fall back to the regexes.
    const classifyOpts = { hasPptxAttachment: !!pptxDeckBrief, hasImageAttachment: imageAttachments.length > 0 }
    const intentResult = shouldClassifyIntent(prompt, history, classifyOpts)
      ? await classifyIntent(req.token, prompt).catch(() => null)
      : null
    const caps = detectCapabilities(prompt, history, { ...classifyOpts, classifier: intentResult })
    // Only the deck flow consumes the (heavy) selected template — both to build
    // its instruction and to resolve deck fences afterward. When this turn isn't
    // about a deck, caps.deck is false, DECK_POLICY is omitted, so the model
    // can't emit a deck fence and extractPrismBlocks never needs the template:
    // skip the fetch entirely. Deck turns still get it (cached across turns).
    const selectedTemplate = caps.deck ? await getSelectedDeckTemplate(req.email, req.token) : null
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
    const activeSkills = await routeSkills(req, prompt, { forced: payload.skills })
    if (activeSkills.length) {
      apiMessages.push({ role: 'system', content: renderSkillsInstruction(activeSkills) })
    }
    // badge = built-in capabilities (deck/spreadsheet) that were gated on this
    // turn + any authored skills — so generating a spreadsheet/deck also shows a
    // "skill active" chip, not just user-authored skills
    emitActiveSkills(send, [...activeSystemSkills(caps), ...activeSkills])
    // Context window: replay only the recent conversation to the model (the
    // full `history` is still used above for detectCapabilities and below for
    // chart/deck block resolution). Caps latency/cost that would otherwise grow
    // with the conversation length; see pushWindowedHistory / MAX_HISTORY_MESSAGES.
    // With HISTORY_RETRIEVAL on, also pull semantically-relevant older messages.
    const retrieved = await retrieveHistoryContext(req, sessionId, history, prompt)
    pushWindowedHistory(apiMessages, history, retrieved)
    // pasted/attached images → vision input on the turn being answered
    attachImagesToLastUserTurn(apiMessages, imageAttachments)

    // tools: the built-in Python UC function is provisioned lazily once per
    // process; additional tools are whichever UC Functions the user attached
    // to this session. Skip entirely for models flagged tools:false or if
    // provisioning failed (e.g. no SQL_WAREHOUSE_ID / no CREATE FUNCTION grant).
    const { toolDefs, toolResolvers } = await resolveToolDefs(req, model, enabledToolRefs, {
      includeImage: caps.image,
      suppressDataTools: caps.suppressDataTools,
    })
    // narration guidance only when tools are actually in play — appended after
    // the history so it's the freshest instruction when the model decides
    // whether/how to call a tool
    if (toolDefs) apiMessages.push({ role: 'system', content: TOOL_NARRATION_POLICY })
    // forced response language (Preferences) — LAST system message, so it's the
    // freshest/highest-salience instruction and overrides the PT-authored
    // policies above and the user's own language. Omitted when 'auto'.
    {
      const langDir = responseLangDirective(responseLang)
      if (langDir) apiMessages.push({ role: 'system', content: langDir })
    }

    // Which image model the generate_image tool should use, if this turn calls
    // it: the client's per-turn choice, else the user's saved preference, else
    // the org default (resolved inside the tool). Only fetched when relevant.
    const imageModel = caps.image
      ? (payload.imageModel || (await getSelectedImageModel(req.email, req.token).catch(() => null)) || undefined)
      : undefined

    const { answer, usage, hadUsage, toolTrace, imageRefs, truncated, stoppedEarly } = await runAssistantTurn({
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
      baseImages: imageAttachments,
      lang: msgLang(responseLang, uiLang),
    })

    // resolve any model-placed chart/insight blocks against the real,
    // deterministic candidates (from attachments and/or Genie tool calls made
    // this turn or earlier in the session) — each fence becomes a {{block:N}}
    // placeholder right where the model put it, so the frontend renders it inline.
    // imageRefs resolve `image` fences against images the tool generated this turn.
    let { content: finalContent, blocks } = extractPrismBlocks(answer, chartState.items, selectedTemplate, imageRefs)
    finalContent = applyTruncationNotice(truncated, finalContent, send, msgLang(responseLang, uiLang))
    finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send, msgLang(responseLang, uiLang))
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const assistantMsg = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
      mediaProcessing: computeMediaProcessing(mediaProcessedFiles, model, mediaUsageTotal),
      // disclose the intent-classifier hop + its (tiny) token spend so it folds
      // into the shown cost estimate, per the design decision to make the
      // pre-analysis cost visible rather than hidden.
      intentClassify: intentResult?.usage
        ? { model: INTENT_MODEL, usage: { prompt_tokens: intentResult.usage.prompt_tokens, completion_tokens: intentResult.usage.completion_tokens } }
        : null,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, assistantMsg.id, toolTrace)

    if (blocks.length) {
      send({ type: 'blocks', sessionId: String(sessionId), blocks, content: finalContent })
    }
    if (hadUsage) send({ type: 'usage', usage })

    // Post-answer work: the semantic-search embedding and (first exchange) the
    // emoji title. Both are GATEWAY calls (embed + generateTitle) — the DB pool
    // doesn't speed them up — and they used to run SERIALLY here, stacking ~4s
    // of dead air AFTER the answer was fully streamed. They're independent, so
    // run them concurrently: the tail becomes max(embed, title) instead of the
    // sum. The `title` still streams as its own event so the client applies it
    // live; a failure in either is logged, never fatal to the turn.
    const embedTask = updateSessionEmbedding(req, sessionId, history).catch((e) =>
      console.warn('embedding update failed:', e.message)
    )
    // per-message embeddings (history retrieval + pgvector search). Independent
    // of the session-level embedding; runs concurrently on the tail, best-effort.
    const msgIndexTask = indexSessionMessages(req, sessionId).catch((e) =>
      console.warn('message embedding index failed:', e.message)
    )
    const titleTask = (async () => {
      if (isNew) {
        const title = await generateTitle(req.token, prompt || attachNames.join(', '), answer)
        await updateSession(req.email, req.token, sessionId, { title })
        send({ type: 'title', title, sessionId: String(sessionId) })
      } else {
        await updateSession(req.email, req.token, sessionId, {})
      }
    })().catch((e) => console.warn('title/session update failed:', e.message))
    await Promise.all([embedTask, msgIndexTask, titleTask])

    send({ type: 'done' })
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    } else {
      send({ type: 'error', error: e.message })
      send({ type: 'done' })
      res.end()
    }
  }
})

// Recomputes the session's semantic-search embedding from the user messages
// (topic/intent) — a focused passage beats embedding the verbose full
// transcript, which dilutes the topic. Shared by the send path (and callable
// elsewhere). Throws on failure so the caller decides whether to swallow it.
async function updateSessionEmbedding(req, sessionId, history) {
  const doc = history
    .filter((m) => m.role === 'user')
    .map((m) => stripAttach(m.content))
    .join('\n')
    .slice(0, 1500)
  const [vec] = await embed(req.token, [doc])
  if (vec) await setSessionEmbedding(req.email, req.token, sessionId, vec)
}

// Per-message embeddings for semantic history retrieval (HISTORY_RETRIEVAL) and
// for the pgvector-backed session search. Embeds every message in the session
// that doesn't yet have a vector — so it covers this turn's new user+assistant
// rows AND lazily backfills older messages the first time a session is touched
// after this feature ships (no migration job). Attachment bodies are stripped
// so a vector reflects the message's intent, not a pasted document. Best-effort:
// called on the turn tail, never blocks the answer. One batched embed call.
async function indexSessionMessages(req, sessionId) {
  const missing = await listMessagesMissingEmbedding(req.email, req.token, sessionId)
  if (!missing.length) return
  const texts = missing.map((m) => stripAttach(m.content).slice(0, 4000))
  const vecs = await embed(req.token, texts)
  await Promise.all(
    missing.map((m, i) => (vecs[i] ? setMessageEmbedding(req.email, req.token, sessionId, m.id, vecs[i]) : null))
  )
}

// One-time-per-process migration backfill: index the user's un-embedded history
// (capped, newest-first) so pgvector search/retrieval work on conversations that
// predate this feature. Fire-and-forget from /api/search; the latch keeps a
// second search from re-scanning while the first is still running. Batches to
// keep any single embed call bounded.
const historyBackfillDone = new Set()
async function backfillUserMessageEmbeddings(req) {
  if (historyBackfillDone.has(req.email)) return
  historyBackfillDone.add(req.email)
  try {
    const missing = await listUserMessagesMissingEmbedding(req.email, req.token, 200)
    for (let i = 0; i < missing.length; i += 40) {
      const batch = missing.slice(i, i + 40)
      const vecs = await embed(req.token, batch.map((m) => stripAttach(m.content).slice(0, 4000)))
      await Promise.all(
        batch.map((m, j) => (vecs[j] ? setMessageEmbedding(req.email, req.token, m.sessionId, m.id, vecs[j]) : null))
      )
    }
    if (missing.length) console.log(`history backfill: indexed ${missing.length} messages for ${req.email}`)
  } catch (e) {
    // let a later search retry by clearing the latch
    historyBackfillDone.delete(req.email)
    console.warn('history backfill failed:', e.message)
  }
}

// ---- recovery: answer a trailing UNANSWERED user message ----
// A turn can leave a user message with no assistant reply — the server crashed
// or the token expired mid-generation, so /api/chat persisted the user row but
// never created the answer. There's no assistant message to "regenerate", so
// the user is stuck. This generates the missing reply as a fresh assistant
// message (its own variant group), building history exactly like /api/chat.
app.post('/api/sessions/:id/continue', auth, async (req, res) => {
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  try {
    await ensureReady(req)

    const sessionId = req.params.id
    await getUserModels(req)
    const model = resolveModelId(req.body.model)
    const temperature = typeof req.body.temperature === 'number' ? req.body.temperature : 0.7
    const systemPrompt = (req.body.systemPrompt || '').trim()
    const responseLang = req.body.responseLang
    const uiLang = req.body.uiLang
    const enabledToolRefs = Array.isArray(req.body.enabledTools) ? req.body.enabledTools : []

    const history = await listMessages(req.email, req.token, sessionId)
    if (!history.length) return res.status(404).json({ error: 'sessão vazia' })
    // only valid when the conversation actually ends on an unanswered user
    // message — otherwise there's nothing missing to fill in
    if (history[history.length - 1].role !== 'user') {
      return res.status(409).json({ error: 'a última mensagem já foi respondida' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const apiMessages = []
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt })
    const [chartState, selectedTemplate] = await Promise.all([
      getSessionChartCandidates(req.email, req.token, sessionId),
      getSelectedDeckTemplate(req.email, req.token),
    ])
    // last (unanswered) user message drives capability gating; history blocks
    // keep an in-progress deck/spreadsheet flow's policy on
    const lastUserText = history[history.length - 1]?.content || ''
    const intentResult = shouldClassifyIntent(lastUserText, history)
      ? await classifyIntent(req.token, lastUserText).catch(() => null)
      : null
    const caps = detectCapabilities(lastUserText, history, { classifier: intentResult })
    const blocksInstruction = buildBlocksInstruction(chartState.items, selectedTemplate, caps)
    if (blocksInstruction) apiMessages.push({ role: 'system', content: blocksInstruction })
    const activeSkills = await routeSkills(req, lastUserText, { forced: req.body.skills })
    if (activeSkills.length) {
      apiMessages.push({ role: 'system', content: renderSkillsInstruction(activeSkills) })
    }
    emitActiveSkills(send, [...activeSystemSkills(caps), ...activeSkills])
    {
      const retrieved = await retrieveHistoryContext(req, sessionId, history, lastUserText)
      pushWindowedHistory(apiMessages, history, retrieved)
    }

    const { toolDefs, toolResolvers } = await resolveToolDefs(req, model, enabledToolRefs, {
      includeImage: caps.image,
      suppressDataTools: caps.suppressDataTools,
    })
    if (toolDefs) apiMessages.push({ role: 'system', content: TOOL_NARRATION_POLICY })
    // forced response language (Preferences) — LAST system message, so it's the
    // freshest/highest-salience instruction and overrides the PT-authored
    // policies above and the user's own language. Omitted when 'auto'.
    {
      const langDir = responseLangDirective(responseLang)
      if (langDir) apiMessages.push({ role: 'system', content: langDir })
    }

    const imageModel = caps.image
      ? (req.body.imageModel || (await getSelectedImageModel(req.email, req.token).catch(() => null)) || undefined)
      : undefined

    const { answer, usage, hadUsage, toolTrace, imageRefs, truncated, stoppedEarly } = await runAssistantTurn({
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
      lang: msgLang(responseLang, uiLang),
    })

    let { content: finalContent, blocks } = extractPrismBlocks(answer, chartState.items, selectedTemplate, imageRefs)
    finalContent = applyTruncationNotice(truncated, finalContent, send, msgLang(responseLang, uiLang))
    finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send, msgLang(responseLang, uiLang))
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const assistantMsg = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
      intentClassify: intentResult?.usage
        ? { model: INTENT_MODEL, usage: { prompt_tokens: intentResult.usage.prompt_tokens, completion_tokens: intentResult.usage.completion_tokens } }
        : null,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, assistantMsg.id, toolTrace)

    if (blocks.length) send({ type: 'blocks', blocks, content: finalContent })
    if (hadUsage) send({ type: 'usage', usage })
    send({ type: 'variant', messageId: assistantMsg.id })

    await updateSession(req.email, req.token, sessionId, {})
    send({ type: 'done' })
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    } else {
      send({ type: 'error', error: e.message })
      send({ type: 'done' })
      res.end()
    }
  }
})

// ---- in-place regeneration: replaces one assistant turn, keeping every
// earlier attempt as a browsable version instead of overwriting it ----
app.post('/api/sessions/:id/messages/:messageId/regenerate', auth, async (req, res) => {
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  try {
    await ensureReady(req)

    const sessionId = req.params.id
    await getUserModels(req)
    const model = resolveModelId(req.body.model)
    const temperature = typeof req.body.temperature === 'number' ? req.body.temperature : 0.7
    const systemPrompt = (req.body.systemPrompt || '').trim()
    const responseLang = req.body.responseLang
    const uiLang = req.body.uiLang
    const enabledToolRefs = Array.isArray(req.body.enabledTools) ? req.body.enabledTools : []

    const { variantGroup, messages: history } = await listMessagesBeforeMessage(
      req.email,
      req.token,
      sessionId,
      req.params.messageId
    )
    if (!variantGroup) return res.status(404).json({ error: 'mensagem não encontrada' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const apiMessages = []
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt })
    // no new attachment on a regenerate turn, but candidates from earlier in
    // the session (past attachments/Genie calls) are still fair game
    const [chartState, selectedTemplate] = await Promise.all([
      getSessionChartCandidates(req.email, req.token, sessionId),
      getSelectedDeckTemplate(req.email, req.token),
    ])
    // capability gating keyed on the last user turn being regenerated + the
    // history's blocks (so an in-progress deck/spreadsheet flow keeps its policy)
    const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content || ''
    const intentResult = shouldClassifyIntent(lastUserText, history)
      ? await classifyIntent(req.token, lastUserText).catch(() => null)
      : null
    const caps = detectCapabilities(lastUserText, history, { classifier: intentResult })
    const blocksInstruction = buildBlocksInstruction(chartState.items, selectedTemplate, caps)
    if (blocksInstruction) apiMessages.push({ role: 'system', content: blocksInstruction })
    const activeSkills = await routeSkills(req, lastUserText, { forced: req.body.skills })
    if (activeSkills.length) {
      apiMessages.push({ role: 'system', content: renderSkillsInstruction(activeSkills) })
    }
    emitActiveSkills(send, [...activeSystemSkills(caps), ...activeSkills])
    {
      const retrieved = await retrieveHistoryContext(req, sessionId, history, lastUserText)
      pushWindowedHistory(apiMessages, history, retrieved)
    }

    const { toolDefs, toolResolvers } = await resolveToolDefs(req, model, enabledToolRefs, {
      includeImage: caps.image,
      suppressDataTools: caps.suppressDataTools,
    })
    if (toolDefs) apiMessages.push({ role: 'system', content: TOOL_NARRATION_POLICY })
    // forced response language (Preferences) — LAST system message, so it's the
    // freshest/highest-salience instruction and overrides the PT-authored
    // policies above and the user's own language. Omitted when 'auto'.
    {
      const langDir = responseLangDirective(responseLang)
      if (langDir) apiMessages.push({ role: 'system', content: langDir })
    }

    const imageModel = caps.image
      ? (req.body.imageModel || (await getSelectedImageModel(req.email, req.token).catch(() => null)) || undefined)
      : undefined

    const { answer, usage, hadUsage, toolTrace, imageRefs, truncated, stoppedEarly } = await runAssistantTurn({
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
      lang: msgLang(responseLang, uiLang),
    })

    let { content: finalContent, blocks } = extractPrismBlocks(answer, chartState.items, selectedTemplate, imageRefs)
    finalContent = applyTruncationNotice(truncated, finalContent, send, msgLang(responseLang, uiLang))
    finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send, msgLang(responseLang, uiLang))
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const assistantMsg = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
      variantGroup,
      intentClassify: intentResult?.usage
        ? { model: INTENT_MODEL, usage: { prompt_tokens: intentResult.usage.prompt_tokens, completion_tokens: intentResult.usage.completion_tokens } }
        : null,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, assistantMsg.id, toolTrace)

    if (blocks.length) {
      send({ type: 'blocks', blocks, content: finalContent })
    }
    if (hadUsage) send({ type: 'usage', usage })
    send({ type: 'variant', messageId: assistantMsg.id, variantGroup })

    await updateSession(req.email, req.token, sessionId, {})
    send({ type: 'done' })
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    } else {
      send({ type: 'error', error: e.message })
      send({ type: 'done' })
      res.end()
    }
  }
})

// switches which stored variant is "active" for its slot — used when the
// user browses the version carousel to something other than the latest
app.patch('/api/messages/:id/activate', auth, async (req, res) => {
  try {
    await ensureReady(req)
    await activateVariant(req.email, req.token, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// edits a previously-sent user prompt: files a new active variant into the
// same slot (the original wording stays in the table, just deactivated) —
// the frontend follows this up with a regenerate of the assistant reply that
// came after it, so the conversation continues from the corrected wording
app.post('/api/sessions/:id/messages/:messageId/edit', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const newText = (req.body.content || '').trim()
    if (!newText) return res.status(400).json({ error: 'conteúdo vazio' })

    const orig = await getMessageRaw(req.email, req.token, req.params.messageId)
    if (!orig || orig.sessionId !== req.params.id || orig.role !== 'user') {
      return res.status(404).json({ error: 'mensagem não encontrada' })
    }

    // preserve the extracted-attachment tail (if any) — only the visible
    // prompt text is editable, not the files that were attached to it
    const markerIdx = orig.content.indexOf('\n\n--- ANEXOS ---')
    const tail = markerIdx >= 0 ? orig.content.slice(markerIdx) : ''

    const newMsg = await addMessage(req.email, req.token, {
      sessionId: req.params.id,
      role: 'user',
      content: newText + tail,
      attachments: orig.attachments,
      variantGroup: orig.variantGroup,
    })
    res.json({ id: newMsg.id, variantGroup: orig.variantGroup })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Persist the user's answers into a deck-questions block (so the box shows the
// history on reload and stays editable). The client sends the raw answers map;
// it's sanitized against the block's own questions server-side. Returns the
// updated blocks so the client can re-render the filled state.
app.post('/api/sessions/:id/messages/:messageId/question-answers', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const messageId = req.params.messageId
    const orig = await getMessageRaw(req.email, req.token, messageId)
    if (!orig || orig.sessionId !== req.params.id) {
      return res.status(404).json({ error: 'mensagem não encontrada' })
    }
    // sanitize the incoming answers against the block's own questions
    const blocksNow = await getMessageBlocks(req.email, req.token, messageId)
    const dq = (blocksNow || []).find((b) => b && b.type === 'deck-questions')
    if (!dq) return res.status(400).json({ error: 'mensagem não tem bloco de perguntas' })
    const clean = sanitizeQuestionAnswers(req.body?.answers, dq.questions || [])
    const answeredAt = new Date().toISOString()
    const updated = await setDeckQuestionsAnswers(req.email, req.token, messageId, clean || {}, answeredAt)
    res.json({ ok: true, blocks: updated })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- static frontend ----
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' })
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Prism listening on :${PORT}`)
})
