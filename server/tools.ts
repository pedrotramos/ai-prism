// Tool calling, Databricks-native: tools are either Unity Catalog Functions or
// Genie Spaces, both invoked with the signed-in user's own OAuth token — same
// on-behalf-of pattern already used for Lakebase and the AI Gateway. This
// means tool execution is governed by the user's real permissions (no bespoke
// sandbox to build or trust), and "add a new tool" simply means "let the user
// attach something they can already access".
//
// The one built-in tool (Python) is a UC Python function this module
// provisions lazily (CREATE OR REPLACE, idempotent) in a configurable
// catalog/schema. UC Python functions run in Databricks' own governed,
// network/filesystem-isolated serverless sandbox, so no extra sandboxing is
// layered on top here — that isolation is the platform's job, not this app's.
import { execStatement, warehouseId } from './warehouse.ts'
import { withToolSpan } from './telemetry.ts'
import { askGenie, askGenieOne } from './genie.ts'
import { getGenieConversationId, setGenieConversationId } from './db.ts'
import { chartCandidatesFromRows } from './analysis.ts'
import { listMcpServerCached, callMcpTool } from './mcpClient.ts'
import { fetchUiResource, isModelVisible, toolUiMeta, uiHostsFromEnv, MCP_APPS_LIMITS } from './mcpApps.ts'
import { mcpAppsOn } from './mcpAppsSetting.ts'
import { logger } from './log.ts'
import { externalMcpUrl, mcpAdmissionForTurn } from './externalMcp.ts'
import { assertUserCredentialsAllowed, currentRunAs } from './runIdentity.ts'
import { describeVectorIndexColumns, queryVectorIndex } from './vectorSearch.ts'
import { pythonUdfDDL } from '../shared/pythonUdf.js'
import { randomUUID } from 'node:crypto'
import { generateImage, DEFAULT_IMAGE_MODEL } from './llm.ts'
import { markImageEndpointUnavailable } from './imageAvailability.ts'
import { putImageDataUrl, deleteImageFile } from './imageStore.ts'
import { fetchWebPage } from './web.ts'
import { searchWeb, renderWebSearchForModel } from './webSearch/index.ts'
import { isPlainName, sanitizeLabel, sanitizeMetadata } from './toolMetadata.ts'
import { artifactToolDefs, invokeArtifactTool, ARTIFACT_TOOL_KIND } from './artifactTools.ts'

// Tool args, refs and gateway/MCP payloads are model- or client-supplied JSON read defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the model/client
type Json = any
interface ToolResolver {
  kind: string
  toolName?: string
  ref?: Json
  label?: string
  mcpToolName?: string
  url?: string
  connectionName?: string
  error?: string
  action?: string
  artifact?: string
  // MCP Apps: the UI resource this tool declared (set only when the feature was on for the turn)
  ui?: { resourceUri: string } | null
}
interface ToolCtx {
  email?: string
  sessionId?: string
  model?: string
  lang?: string
  imageModel?: string
  baseImages?: unknown
  signal?: AbortSignal
  onProgress?: (p: Json) => void
  send?: (event: unknown) => void
  artifacts?: Json
  toolCallId?: unknown
  // MCP Apps: how many Apps this turn captured so far (the turn owns it); absent = never capture
  uiCapture?: { count: number }
}
interface McpGuideServer {
  name: string
  label: string
  error?: string
  purpose?: string
  instructions?: string
  prefix?: string
  toolNames?: string[]
}
interface ToolDef {
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}
interface BuildToolOpts {
  includePython?: boolean
  includeImage?: boolean
  webSearch?: { registered?: boolean; shadowedServices?: Set<string> } | null
  toolPolicy?: Record<string, boolean | undefined>
  hiddenMcp?: Set<string>
  mcpInfo?: Map<string, Json>
  suppressDataTools?: boolean
  artifacts?: Json
  mcpAdmission?: (name: string) => { ok?: boolean; credentialClass?: string } | null | undefined
  // MCP Apps on for this turn; undefined = read the admin setting (only when an MCP service is in play)
  mcpApps?: boolean
}
interface ImageDeps {
  generateImage: (token: string, model: string, input: { prompt?: string; baseImages?: unknown[]; signal?: AbortSignal }) => Promise<{ dataUrls: string[]; usage: Json }>
  putImageDataUrl: (token: string, relPath: string, dataUrl: string) => Promise<{ volumePath: string; contentType: string }>
  deleteImageFile: (token: string, volumePath: string) => Promise<unknown>
}

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// Fixed pseudo space id so Genie One's own conversation continuity reuses
// the existing per-session Genie conversation table (space_id is a free-form
// key) without a schema change — Genie One has no real spaceId of its own.
const GENIE_ONE_SPACE_ID = '__genie_one__'
export const GENIE_ONE_TOOL_FN_NAME = 'ask_genie_one'

function catalog() {
  // default to the dedicated AI Prism catalog so the built-in Python UDF lives
  // alongside the image volume (all AI Prism assets in one place)
  return process.env.TOOLS_CATALOG || 'ai_prism'
}
function schema() {
  return process.env.TOOLS_SCHEMA || 'default'
}
function pythonFqName() {
  return `${catalog()}.${schema()}.ai_prism_python_exec`
}

export const PYTHON_TOOL_FN_NAME = 'execute_python'
export const IMAGE_TOOL_FN_NAME = 'generate_image'
export const WEB_SEARCH_TOOL_FN_NAME = 'web_search'
export const WEB_FETCH_TOOL_FN_NAME = 'web_fetch'

// Web grounding has a stable model-facing contract (`web_search` + `web_fetch`)
// whatever backend answers (server/webSearch: managed MCP → designated external
// MCP → keyed APIs). Page retrieval is always native (web.js) so a search
// snippet can never be mistaken for the source's actual contents. Whether the
// pair is registered on a turn is decided ONCE per turn by webSearchForTurn
// (kill-switch WEB_SEARCH_DISABLED, policy, model, availability) and passed in
// as opts.webSearch — this module reads no environment variable for it.

// Localized strings for the image tool's success/error result text — this text
// is shown in the tool chip AND fed back to the model, so it should match the
// user's chosen response language. 'auto'/unknown → pt (the app's default).
interface ImageMsgs {
  okOne: string
  okMany: (n: number) => string
  insertOne: string
  insertMany: string
  missingScope: string
  writeFailed: string
  noImage: string
  noPermission: string
  unavailable: string
  generic: string
}
function imageErrMsgs(lang: string) {
  const C: Record<string, ImageMsgs> = {
    pt: {
      okOne: 'Imagem gerada com sucesso',
      okMany: (n: number) => `Foram geradas ${n} imagens`,
      insertOne: 'Insira-a na resposta com um bloco ```prism-block``` do tipo "image", ex.:',
      insertMany: 'Insira cada uma com um bloco ```prism-block``` do tipo "image" usando o "imageRef" correspondente.',
      missingScope:
        'ERRO: o app não tem permissão para gravar imagens (falta o escopo OAuth "files"). ' +
        'Peça a um administrador para reimplantar o app com esse escopo; depois faça login novamente. Avise isso ao usuário.',
      writeFailed: 'ERRO: falha ao gravar a imagem no Volume. Avise o usuário e sugira tentar de novo.',
      noImage: 'ERRO: o modelo não retornou nenhuma imagem. Avise o usuário e sugira reformular o pedido.',
      noPermission: 'ERRO: você não tem permissão para usar este modelo de imagem (falta USE CATALOG, USE SCHEMA ou EXECUTE ON MODEL PROVIDER SERVICE). Avise o usuário para pedir o acesso a um administrador; outros modelos de imagem podem estar disponíveis nas Configurações.',
      unavailable: 'ERRO: este modelo de imagem não está disponível no workspace. Avise o usuário e sugira escolher outro modelo de imagem nas Configurações.',
      generic: 'ERRO ao gerar a imagem',
    },
    en: {
      okOne: 'Image generated successfully',
      okMany: (n: number) => `${n} images were generated`,
      insertOne: 'Insert it into the reply with an "image" ```prism-block```, e.g.:',
      insertMany: 'Insert each one with an "image" ```prism-block``` using the matching "imageRef".',
      missingScope:
        'ERROR: the app is not allowed to write images (missing the "files" OAuth scope). ' +
        'Ask an administrator to redeploy the app with that scope, then sign in again. Tell the user this.',
      writeFailed: 'ERROR: failed to write the image to the Volume. Tell the user and suggest retrying.',
      noImage: 'ERROR: the model returned no image. Tell the user and suggest rephrasing the request.',
      noPermission: 'ERROR: you are not allowed to use this image model (missing USE CATALOG, USE SCHEMA or EXECUTE ON MODEL PROVIDER SERVICE). Tell the user to ask an administrator for access; other image models may be available in Settings.',
      unavailable: 'ERROR: this image model is not available in the workspace. Tell the user and suggest picking another image model in Settings.',
      generic: 'ERROR generating the image',
    },
    es: {
      okOne: 'Imagen generada con éxito',
      okMany: (n: number) => `Se generaron ${n} imágenes`,
      insertOne: 'Insértala en la respuesta con un bloque ```prism-block``` de tipo "image", p. ej.:',
      insertMany: 'Inserta cada una con un bloque ```prism-block``` de tipo "image" usando el "imageRef" correspondiente.',
      missingScope:
        'ERROR: la app no tiene permiso para escribir imágenes (falta el scope OAuth "files"). ' +
        'Pide a un administrador que vuelva a desplegar la app con ese scope y vuelve a iniciar sesión. Avísale esto al usuario.',
      writeFailed: 'ERROR: no se pudo escribir la imagen en el Volume. Avisa al usuario y sugiere reintentar.',
      noImage: 'ERROR: el modelo no devolvió ninguna imagen. Avisa al usuario y sugiere reformular la solicitud.',
      noPermission: 'ERROR: no tienes permiso para usar este modelo de imagen (falta USE CATALOG, USE SCHEMA o EXECUTE ON MODEL PROVIDER SERVICE). Avisa al usuario que pida acceso a un administrador; puede haber otros modelos de imagen en Configuración.',
      unavailable: 'ERROR: este modelo de imagen no está disponible en el workspace. Avisa al usuario y sugiere elegir otro modelo de imagen en Configuración.',
      generic: 'ERROR al generar la imagen',
    },
  }
  return C[lang] || C.pt!
}

let builtinReady = false
export async function ensureBuiltinPythonTool(token: string): Promise<void> {
  if (builtinReady) return
  // The DDL lives in shared/pythonUdf.js so the deploy-time bundle job and this
  // lazy runtime provisioning stay byte-for-byte identical.
  await execStatement(token, pythonUdfDDL(pythonFqName()))
  builtinReady = true
}

function pythonToolDef() {
  return {
    type: 'function',
    function: {
      name: PYTHON_TOOL_FN_NAME,
      description:
        'Executa código Python para cálculos que exigem precisão exata (aritmética, álgebra, ' +
        'estatística, datas). Sempre prefira esta tool a calcular de cabeça quando o resultado ' +
        'numérico importa. Defina uma variável "result" com a resposta final, ou use print(). ' +
        'A PRIMEIRA linha do código DEVE ser um comentário curto (#) que descreve o passo, escrito ' +
        'no MESMO IDIOMA do usuário — ele vira o rótulo visível deste passo na interface.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Código Python a executar. Comece com um comentário curto (#) no idioma do usuário ' +
              'descrevendo o passo (ex.: "# Receita mensal — apenas meses completos"), pois ele é ' +
              'usado como rótulo do passo na UI.',
          },
        },
        required: ['code'],
      },
    },
  }
}

function imageToolDef() {
  return {
    type: 'function',
    function: {
      name: IMAGE_TOOL_FN_NAME,
      description:
        'Gera uma imagem a partir de uma descrição textual (text-to-image). Use quando o usuário ' +
        'pedir EXPLICITAMENTE para criar/gerar/desenhar uma imagem, ilustração, foto, logo, ícone ou ' +
        'arte. NÃO use para buscar imagens existentes nem para editar um arquivo anexado. Escreva o ' +
        'prompt em INGLÊS e o mais descritivo possível (assunto, estilo, composição, iluminação, ' +
        'cores, enquadramento) — modelos de imagem respondem muito melhor a prompts ricos em inglês, ' +
        'independentemente do idioma do usuário. Após a tool retornar, insira a imagem na resposta ' +
        'com um bloco ```prism-block``` do tipo "image" (o servidor te dará o id).',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Descrição detalhada da imagem, em inglês. Ex.: "A futuristic data center at night, ' +
              'rows of glowing server racks, cool blue and teal lighting, cinematic wide shot, ' +
              'volumetric fog, photorealistic".',
          },
        },
        required: ['prompt'],
      },
    },
  }
}

function webSearchToolDef() {
  return {
    type: 'function',
    function: {
      name: WEB_SEARCH_TOOL_FN_NAME,
      description:
        'Busca informações públicas e ATUAIS na web (fatos recentes, cotações, indicadores, ' +
        'eventos, lançamentos, dados que mudam com o tempo ou que sejam posteriores ao seu ' +
        'conhecimento). Use SEMPRE que precisar de um número ou fato que deva refletir o mundo ' +
        'real hoje — em vez de estimar de memória — em qualquer tipo de resposta (conversa, ' +
        'apresentação ou documento). Cada resultado traz uma URL de fonte: cite a fonte e a data ' +
        'ao usar o dado. Prefira várias buscas específicas a uma genérica. ' +
        'Não inclua na consulta dados internos, nomes de clientes ou conteúdo de anexos: a consulta sai do workspace para o provedor de busca.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Consulta de busca, específica e no idioma do assunto. Ex.: "taxa Selic Copom decisão agosto 2026".',
          },
          limit: { type: 'integer', description: 'Número de resultados (padrão 5, máximo 10).' },
        },
        required: ['query'],
      },
    },
  }
}

function webFetchToolDef() {
  return {
    type: 'function',
    function: {
      name: WEB_FETCH_TOOL_FN_NAME,
      description:
        'Abre e lê o conteúdo real de uma página pública encontrada na web. Use depois de web_search ' +
        'para confirmar os fatos no documento original; snippets de busca não equivalem à leitura da página. ' +
        'Retorna texto legível, título, URL final e indica se o conteúdo foi truncado.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL HTTP/HTTPS pública a abrir.' },
          max_chars: { type: 'integer', description: 'Máximo de caracteres retornados (padrão 30000, máx. 60000).' },
        },
        required: ['url'],
      },
    },
  }
}

// --- Unity Catalog Function discovery (for user-selectable "extra" tools) ---

// UC parameter types we know how to bind as SQL statement parameters and
// describe as JSON Schema. Complex types (ARRAY/MAP/STRUCT) are excluded from
// the picker — the Statement Execution API's parameter binding doesn't cover
// them well, and it keeps the tool-call argument shape simple for the model.
function sqlTypeToJsonSchema(fullType: string | null | undefined): Record<string, string> | null {
  const t = (fullType || '').toLowerCase().trim()
  if (/^(string|varchar|char)/.test(t)) return { type: 'string' }
  if (/^(tinyint|smallint|int|integer|bigint|long|byte)/.test(t)) return { type: 'integer' }
  if (/^(float|double|decimal|numeric|real)/.test(t)) return { type: 'number' }
  if (/^boolean/.test(t)) return { type: 'boolean' }
  if (/^(date|timestamp|interval)/.test(t)) return { type: 'string', description: `formato ${t}` }
  return null // unsupported (array/map/struct/binary/void)
}

function sanitizeToolName(rawName: string): string {
  const raw = rawName.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (raw.length <= 64) return raw
  // Deterministic short suffix keeps names unique without needing a lookup by hash.
  let hash = 0
  for (const ch of raw) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return raw.slice(0, 55) + '_' + hash.toString(36).slice(0, 8)
}

// Function names for MCP tools. The name is the model's strongest signal for
// picking a tool, so it must keep the TOOL's own name readable. The old
// `mcpext__<catalog.schema.service>__<tool>` blew past the 64-char limit for any
// real three-part name (e.g. lojinha_do_tio_pedro_catalog.default.firecrawl_mcp)
// and sanitizeToolName's truncate+hash chopped the tool name off entirely —
// 28 tools named `mcpext__lojinha_do_tio_pedro_catalog_default_firecrawl_m_<hash>`.
// Now: `mcp_<service>__<tool>` (service = last segment, capped), the tool name
// kept whole whenever it fits; a colliding service segment (same service name
// in two catalogs) gets a short hash of the full name.
function shortHash(str: string): string {
  let hash = 0
  for (const ch of str) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash.toString(36).slice(0, 5)
}
function mcpServerSlug(serviceName: string, takenSlugs: Map<string, string>): string {
  const clean = (x: string) => x.replace(/[^a-zA-Z0-9_-]/g, '_')
  let slug = clean(String(serviceName).split('.').pop() || 'mcp').slice(0, 24)
  const owner = takenSlugs.get(slug)
  if (owner && owner !== serviceName) slug = `${slug.slice(0, 18)}_${shortHash(serviceName)}`
  takenSlugs.set(slug, serviceName)
  return slug
}
function mcpToolFnName(slug: string, toolName: unknown): string {
  const tool = String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_')
  const name = `mcp_${slug}__${tool}`
  if (name.length <= 64) return name
  const head = `mcp_${slug}__`
  const room = 64 - head.length - 6 // '_' + 5-char hash
  return `${head}${tool.slice(0, Math.max(room, 8))}_${shortHash(tool)}`.slice(0, 64)
}

/** Search Unity Catalog Functions the user can see, by name substring. */
export async function searchUcFunctions(token: string, query: string, limit = 20) {
  const q = (query || '').trim()
  const { rows: routineRows } = await execStatement(
    token,
    `SELECT specific_catalog, specific_schema, specific_name, comment
     FROM system.information_schema.routines
     WHERE routine_type = 'FUNCTION'
       AND specific_catalog NOT IN ('system')
       AND specific_name ILIKE :pattern
     ORDER BY specific_catalog, specific_schema, specific_name
     LIMIT :limit`,
    [
      { name: 'pattern', type: 'STRING', value: `%${q}%` },
      { name: 'limit', type: 'INT', value: String(limit) },
    ]
  )
  if (!routineRows.length) return []

  const results = await Promise.all(
    routineRows.map(async (row) => {
      const [cat, sch, name, comment] = row as [string | null, string | null, string | null, string | null]
      const { rows: paramRows } = await execStatement(
        token,
        `SELECT parameter_name, full_data_type, comment
         FROM system.information_schema.parameters
         WHERE specific_catalog = :cat AND specific_schema = :sch AND specific_name = :name
           AND parameter_mode = 'IN'
         ORDER BY ordinal_position`,
        [
          { name: 'cat', type: 'STRING', value: cat },
          { name: 'sch', type: 'STRING', value: sch },
          { name: 'name', type: 'STRING', value: name },
        ]
      )
      const params = paramRows.map((prow) => {
        const [pname, ptype, pcomment] = prow as [string | null, string | null, string | null, string | null]
        return {
        name: pname,
        type: ptype,
        comment: pcomment || '',
        jsonSchema: sqlTypeToJsonSchema(ptype),
        }
      })
      return {
        kind: 'uc',
        catalog: cat,
        schema: sch,
        name,
        fullName: `${cat}.${sch}.${name}`,
        comment: comment || '',
        params,
        supported: params.every((p) => p.jsonSchema),
      }
    })
  )
  return results.filter((r) => r.supported)
}

function coerceArg(value: unknown, sqlType: string | null | undefined): string {
  const t = (sqlType || '').toLowerCase()
  if (/^boolean/.test(t)) return String(value) === 'true' || value === true ? 'true' : 'false'
  return String(value)
}

function genieToolName(spaceId: string): string {
  return `genie__${spaceId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function genieOneToolDef() {
  return {
    type: 'function',
    function: {
      name: GENIE_ONE_TOOL_FN_NAME,
      description:
        'Consulta os DADOS DE NEGÓCIO do workspace do usuário (tabelas do Unity Catalog e Genie ' +
        'Spaces) em linguagem natural — Genie traduz para SQL, executa e responde. Use SOMENTE ' +
        'quando responder exigir dados PRÓPRIOS do usuário/empresa que só existem nessas tabelas: ' +
        'métricas de vendas, receita, clientes, estoque, pipeline, uso de produto, números ' +
        'internos, etc.\n' +
        'NÃO USE (responda você mesmo, direto, SEM chamar esta tool) para: conhecimento geral, ' +
        'história, geografia, ciência, definições, cultura, atualidades, perguntas sobre pessoas ' +
        'públicas, tradução, redação, programação, matemática/cálculos, ou qualquer coisa que um ' +
        'assistente competente já sabe responder sem acessar um banco de dados. Ex.: "Quem ' +
        'descobriu o Brasil?", "Quanto é 2+2?", "O que é um data lakehouse?" → responda direto, ' +
        'JAMAIS chame o Genie One. Chamar esta tool para esse tipo de pergunta é um ERRO caro e ' +
        'lento. Na dúvida sobre se a pergunta é sobre os dados internos do usuário, responda ' +
        'direto; só recorra ao Genie One quando estiver claro que a resposta vive nas tabelas dele.\n' +
        'NUNCA chame esta tool para "testar conexão", "verificar disponibilidade" ou qualquer sondagem ' +
        'que não seja uma pergunta real de dados do usuário — não existe caso de uso de teste; se não há ' +
        'uma pergunta concreta sobre os dados internos para fazer, simplesmente NÃO chame a tool.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'Pergunta sobre os DADOS do workspace do usuário (não use para conhecimento geral).',
          },
        },
        required: ['question'],
      },
    },
  }
}

// External MCP servers expose an arbitrary, only-known-at-runtime tool list —
// discovering it on every chat turn would add a slow gateway round trip per
// enabled connection, so listings are cached per (user, connection) with
// stale-while-revalidate (see listMcpServerCached in mcpClient.js). A cold miss
// waits up to this long on the turn (measured 2.6–4.4s for Firecrawl, so the
// old 4s bound dropped it on most cold turns); past it the listing keeps
// running in the background and the next turn gets the tools.
const MCP_COLD_LIST_TIMEOUT_MS = 8000
const listMcpServerForTurn = (url: string, token: string, email: string, ui = false) =>
  listMcpServerCached(url, token, email, { timeoutMs: MCP_COLD_LIST_TIMEOUT_MS, ui })

// Human label for an MCP server: the admin-set display name, else the last
// segment of the three-part name prettified (same rule as the client).
function mcpLabel(name: unknown, info: Json): string {
  if (info?.displayName) return info.displayName
  return (String(name).split('.').pop() || String(name)).replace(/[_-]+/g, ' ').replace(/\b\w/g, (m: string) => m.toUpperCase())
}

// Server-provided instructions can be long (Firecrawl's are ~1.7k chars); keep
// the guide bounded per server so many connected MCPs can't bloat every turn.
const MCP_INSTRUCTIONS_MAX = 2000

/**
 * The per-turn "what each MCP server is for" guide. Raw MCP tool defs only say
 * what ONE tool does, in the server's own words — the model never learned that
 * e.g. "firecrawl_search" is its live-web access, so it answered "I have no web
 * access" with the tool sitting right there. This names each connected server,
 * its purpose (the admin/catalog description) and the server's own
 * instructions, plus the rule to check the tools before claiming a limitation.
 */
function buildMcpToolGuide(servers: McpGuideServer[]): string {
  if (!servers.length) return ''
  const blocks = servers.map((s) => {
    const lines = [`### ${s.label} (servidor MCP \`${s.name}\`)`]
    if (s.error) {
      lines.push(`INDISPONÍVEL neste turno: ${s.error.slice(0, 300)}. Se o pedido depender dele, explique isso ao usuário (e o link de login, se houver) em vez de responder como se ele não existisse.`)
      return lines.join('\n')
    }
    if (s.purpose) lines.push(`Para que serve: ${s.purpose}`)
    lines.push(`Tools (prefixo \`${s.prefix}\`): ${s.toolNames!.join(', ')}`)
    if (s.instructions) {
      const ins = s.instructions.length > MCP_INSTRUCTIONS_MAX ? `${s.instructions.slice(0, MCP_INSTRUCTIONS_MAX)}…` : s.instructions
      lines.push(`Instruções do próprio servidor:\n${ins}`)
    }
    return lines.join('\n')
  })
  return (
    '=== SERVIDORES MCP CONECTADOS NESTE TURNO ===\n' +
    'Além das ferramentas nativas, o usuário conectou os servidores MCP abaixo. Eles AMPLIAM o que você ' +
    'consegue fazer — leia para que cada um serve. ANTES de dizer que não tem acesso a algo (internet, ' +
    'notícias, eventos recentes, páginas web, um sistema externo…), confira se algum destes servidores ' +
    'cobre o pedido; se cobrir, USE a ferramenta em vez de recusar ou responder de memória. Perguntas sobre ' +
    'fatos atuais/recentes (notícias, "ontem", "hoje", cotações, resultados) NÃO são conhecimento geral: ' +
    'se houver uma ferramenta de busca/navegação na web abaixo, use-a e cite as fontes.\n\n' +
    blocks.join('\n\n')
  )
}


/**
 * Builds the OpenAI-style tool defs + a resolver map for a set of enabled
 * tool refs (kind: 'uc' | 'genie' | 'genie-one' | 'vector-search' |
 * 'mcp-external'). Async because external MCP servers need a live
 * tools/list call to know what they expose — everything else is built from
 * data the ref already carries (resolved at search time) or is hardcoded.
 */
// Canonical tool GROUP keys the org policy toggles (see app_tool_policy). Each
// built-in/attachable tool maps to one of these; a policy value of false hides
// the whole group from users and blocks it server-side.
// 'web-search' covers both web_search and web_fetch (W2-11a). 'memory' (W2-4) is
// not a tool: off, it stops memory extraction, injection and listing (server/memory.js).
export const TOOL_GROUP_KEYS = ['python', 'genie-one', 'image-gen', 'web-search', 'genie', 'vector-search', 'uc', 'mcp-external', 'memory']

// Company-data tool groups: they answer with the user's own workspace data
// (Genie translates NL→SQL over UC tables / Genie Spaces; vector search over
// their indexes; UC functions they attached). On an artifact-generation turn
// with no data intent, the router asks to suppress these (see
// detectCapabilities → suppressDataTools) so the model can't misfire a Genie
// call while building an unrelated deck. `python`, `image-gen`, `web-search`,
// and `mcp-external` are NOT data tools and are never suppressed here.
const DATA_TOOL_KINDS = new Set(['genie-one', 'genie', 'vector-search', 'uc'])

export async function buildToolDefs(
  enabledRefs: Json[] | null | undefined,
  token: string,
  email: string,
  {
    includePython = true,
    includeImage = false,
    // the turn's web search decision (webSearchForTurn): { registered, shadowedServices }
    webSearch = null,
    toolPolicy = {},
    hiddenMcp = new Set(),
    mcpInfo = new Map(),
    suppressDataTools = false,
    // the turn's artifact capabilities ({ deck, spreadsheet, document }): offers
    // create_/update_ tools for each (server/artifactTools.js, W2-12)
    artifacts = null,
    // turn-time credential admission of an MCP ref (W2-11d): name → { ok }.
    // Cache-only, never awaits a classification; a cold entry is refused.
    mcpAdmission = (name: string) => mcpAdmissionForTurn(token, email, name, { catalog: [...mcpInfo.values()] }),
    mcpApps,
  }: BuildToolOpts = {}
) {
  const tools: ToolDef[] = []
  const resolvers = new Map<string, ToolResolver>()
  const mcpServers: McpGuideServer[] = [] // feeds buildMcpToolGuide
  const mcpSlugs = new Map<string, string>() // slug -> service name (per-turn uniqueness)
  // org policy: a key absent from the map is enabled (default-on); only an
  // explicit `false` disables a group. Enforced here so a disabled group can
  // never reach the model even if a stale session ref or client still requests it.
  const allowed = (key: string) => toolPolicy[key] !== false
  if (includePython && allowed('python')) {
    tools.push(pythonToolDef())
    resolvers.set(PYTHON_TOOL_FN_NAME, { kind: 'python' })
  }
  // Image generation is gated per-turn (caps.image): only offered when the user
  // plausibly asked for an image, so a plain question never carries the tool.
  if (includeImage && allowed('image-gen')) {
    tools.push(imageToolDef())
    resolvers.set(IMAGE_TOOL_FN_NAME, { kind: 'image-gen' })
  }
  // Web grounding: offered on every turn the decision registers it, so any
  // interaction can be grounded in current facts — the model decides when a
  // question needs the live web from the tool description.
  const hasWebSearch = !!webSearch?.registered && allowed('web-search')
  if (hasWebSearch) {
    tools.push(webSearchToolDef())
    tools.push(webFetchToolDef())
    resolvers.set(WEB_SEARCH_TOOL_FN_NAME, { kind: 'web-search' })
    resolvers.set(WEB_FETCH_TOOL_FN_NAME, { kind: 'web-fetch' })
  }
  // invariant 5: with the native tool on, the user's own refs to the managed
  // search MCP or to the designated search service would duplicate it (and
  // expose the server's whole tool list): skipped for the turn
  const shadowed = hasWebSearch ? webSearch!.shadowedServices || new Set<string>() : new Set<string>()

  for (const ref of enabledRefs || []) {
    // skip any ref whose group the admin disabled for the org
    if (ref?.kind && !allowed(ref.kind)) continue
    // skip company-data tools on an artifact-only turn (see suppressDataTools)
    if (suppressDataTools && DATA_TOOL_KINDS.has(ref?.kind)) continue
    if (ref?.kind === 'genie' && ref.spaceId) {
      const toolName = genieToolName(ref.spaceId)
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: (
            // title/description are third-party text (toolMetadata.js): neutralized before the prompt
            `Faz uma pergunta em linguagem natural para a sala Genie "${sanitizeLabel(ref.title, 120)}". Genie conhece ` +
            `estes dados: ${sanitizeMetadata(ref.description, 400) || 'sem descrição disponível'}. Genie traduz a pergunta em ` +
            `SQL, executa e responde em linguagem natural — use para perguntas sobre esses dados em vez ` +
            `de tentar adivinhar.`
          ).slice(0, 1000),
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Pergunta em linguagem natural para o Genie, sobre os dados dessa sala.',
              },
            },
            required: ['question'],
          },
        },
      })
      resolvers.set(toolName, { kind: 'genie', ref })
      continue
    }

    if (ref?.kind === 'genie-one') {
      tools.push(genieOneToolDef())
      resolvers.set(GENIE_ONE_TOOL_FN_NAME, { kind: 'genie-one' })
      continue
    }

    if (ref?.kind === 'vector-search' && ref.indexName) {
      const toolName = sanitizeToolName(`vs__${ref.indexName}`)
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: (
            `Busca semântica no índice de Vector Search "${ref.indexName}" (tabela de origem: ` +
            `${ref.sourceTable || 'desconhecida'}). Use para encontrar trechos/documentos relevantes ` +
            `por similaridade de significado, não para agregações exatas.`
          ).slice(0, 1000),
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Texto da busca semântica.' },
              num_results: { type: 'integer', description: 'Número de resultados (padrão 5, máx. 20).' },
            },
            required: ['query'],
          },
        },
      })
      resolvers.set(toolName, { kind: 'vector-search', ref })
      continue
    }

    if (ref?.kind === 'mcp-external' && ref.connectionName) {
      if (shadowed.has(ref.connectionName)) continue
      // an admin hid this service from the org catalog → blocked, even for refs
      // adopted before the hide
      if (hiddenMcp.has(ref.connectionName)) continue
      // credential admission (W2-11c rule, applied at turn time): a ref to a
      // shared-credential, unverifiable or not-yet-classified service — e.g.
      // one adopted before the rule, or written straight into a session —
      // offers the model nothing; no status tool either (fail closed). This
      // includes a user ref to the web search slot's designated service with
      // the native tool off: its exemption is the native web_search/web_fetch
      // pair above (search only, server-side), never the server's tool list.
      const admission = mcpAdmission(ref.connectionName)
      if (!admission?.ok) continue
      // an unattended run (app_sp) lends only the app's own Databricks identity (class 'databricks'): a service that
      // needs a person's credential (per_user, a shared one) is refused here with sp_no_user_credentials, never offered
      if (admission.credentialClass !== 'databricks') assertUserCredentialsAllowed('user MCP connection')
      const url = externalMcpUrl(ref.connectionName)
      const info = mcpInfo.get(ref.connectionName)
      // catalog text and server names reach the prompt: neutralized (toolMetadata.js)
      const label = sanitizeLabel(mcpLabel(ref.connectionName, info), 120)
      const purpose = sanitizeMetadata(info?.comment || ref.comment || '', 300)
      const slug = mcpServerSlug(ref.connectionName, mcpSlugs)
      let mcpTools: Json[] = []
      let instructions = ''
      // MCP Apps: the capability is advertised (and a UI tool captured) only when the admin turned the feature on, and never in an
      // unattended run (app_sp): a View needs a person to click it
      const uiOn = currentRunAs() !== 'app_sp' && (mcpApps ?? (await mcpAppsOn(email, token)))
      try {
        ;({ tools: mcpTools, instructions } = (await listMcpServerForTurn(url, token, email, uiOn))!) // undefined would throw into the catch below, as before
      } catch (e: Json) {
        // Some connections need one-time per-user OAuth consent (confirmed
        // live: tools/list itself fails with UNAUTHENTICATED + a login URL
        // until the user visits it) — rather than silently drop the
        // connection, register one status tool so the model can surface the
        // actual reason (and login link) to the user instead of the
        // connection just vanishing with no explanation.
        const toolName = mcpToolFnName(slug, 'status')
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: `Verifica por que a conexão MCP externa "${ref.connectionName}" está indisponível.`,
            parameters: { type: 'object', properties: {} },
          },
        })
        resolvers.set(toolName, { kind: 'mcp-external-error', connectionName: ref.connectionName, label, error: e.message })
        mcpServers.push({ name: ref.connectionName, label, error: e.message })
        continue
      }
      // every tool carries its server's identity + purpose up front, so a tool
      // read in isolation still says WHICH capability it belongs to
      const context = `[${label} — MCP${purpose ? `: ${purpose}` : ''}] `
      const prefix = `mcp_${slug}__`
      // a tool whose visibility leaves 'model' out (an app-only tool) is never offered to the model
      mcpTools = mcpTools.filter((mt) => isModelVisible(mt))
      for (const mt of mcpTools) {
        const toolName = mcpToolFnName(slug, mt.name)
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: (context + (mt.description || `Tool ${mt.name}.`)).slice(0, 1000),  // mt.description: sanitized in mcpClient.js
            parameters: mt.inputSchema || { type: 'object', properties: {} },
          },
        })
        resolvers.set(toolName, { kind: 'mcp-external', ref, label, mcpToolName: mt.name, url, ui: uiOn ? toolUiMeta(mt) : null })
      }
      mcpServers.push({
        name: ref.connectionName,
        label,
        purpose,
        instructions,
        prefix,
        // names that aren't plain words are kept out of the prompt (the call still uses the real name)
        toolNames: mcpTools.map((t: Json) => (isPlainName(t.name) ? t.name : `tool_${shortHash(t.name)}`)),
      })
      continue
    }

    if (!ref?.catalog || !ref?.schema || !ref?.name || !Array.isArray(ref.params)) continue
    const toolName = sanitizeToolName(`uc__${ref.catalog}__${ref.schema}__${ref.name}`)
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const p of ref.params) {
      if (!p.jsonSchema) continue
      properties[p.name] = { ...p.jsonSchema, description: sanitizeMetadata(p.comment, 300) || undefined }
      required.push(p.name)
    }
    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: sanitizeMetadata(ref.comment, 1000) || `Unity Catalog function ${ref.fullName}`,
        parameters: { type: 'object', properties, required },
      },
    })
    resolvers.set(toolName, { kind: 'uc', ref })
  }
  // Artifact tools (W2-12) go LAST, so the position of every other tool is
  // unchanged. They stage their artifact for the answer commit, never write.
  if (artifacts) {
    for (const { def, resolver } of artifactToolDefs(artifacts)) {
      if (resolvers.has(def.function.name)) continue
      tools.push(def)
      resolvers.set(def.function.name, resolver)
    }
  }
  // the function name the model calls, for the tool.call span (invokeTool only
  // gets the resolver)
  for (const [name, resolver] of resolvers) resolver.toolName = name
  return { tools, resolvers, guide: buildMcpToolGuide(mcpServers), hasWebSearch }
}

/**
 * Executes a resolved tool call and returns `{ resultText, chartCandidates }`
 * — resultText is the tool message content (and what's shown in the tool
 * chip), chartCandidates is [] except for Genie, where a query result is
 * turned into the same deterministic chart-candidate shape spreadsheet
 * uploads produce, so the model can actually reference it in a prism-block.
 * `ctx.sessionId`/`ctx.email` let the Genie resolver continue the same
 * Genie conversation across turns in this chat session.
 */
export function invokeTool(token: string, resolver: ToolResolver, args: Json, ctx: ToolCtx = {}) {
  // tool.call span: name, kind, duration, status; never the arguments
  return withToolSpan(resolver, () => abortable(ctx.signal, () => invokeToolRaw(token, resolver, args, ctx)))
}

// `ctx.signal` is the turn's AbortSignal. A cancelled turn stops waiting for its
// tool at once (rejects with AbortError), so the turn unwinds and frees its
// session lock; an already-aborted signal never starts the tool. Backends that
// take the signal themselves (the image endpoint) also stop their request; the
// others (Genie polling, SQL statements, MCP calls) still run to their own end
// in the background, but nothing waits for or records their result.
function abortable<T>(signal: AbortSignal | undefined, fn: () => T | Promise<T>): Promise<T> | T {
  if (!signal) return fn()
  const reason = () => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  if (signal.aborted) return Promise.reject(reason())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

const imageDeps: ImageDeps = { generateImage, putImageDataUrl, deleteImageFile }

/**
 * The generate_image tool. It writes the bytes to the Volume (the model needs a
 * ref to hand back) but inserts NO chat_images row: that row is written by
 * commitTurnAnswer in the answer's transaction (the same staging rule as the
 * artifact tools, W2-12), so a cancelled or failed turn never leaves a row for
 * an answer that does not exist. Each ref returned is `pending` (what the
 * commit inserts); a cancel after the write removes the file again.
 */
export async function generateImageStaged(token: string, args: Json, ctx: ToolCtx, deps: ImageDeps = imageDeps) {
  const { email, imageModel, baseImages, onProgress } = ctx
  const model = imageModel || DEFAULT_IMAGE_MODEL
  const m = imageErrMsgs(ctx.lang as string)
  // image endpoints run ~10–30s; tick the chip so it's not a silent spinner
  const startedAt = Date.now()
  const timer = onProgress ? setInterval(() => onProgress({ elapsedMs: Date.now() - startedAt }), 1000) : null
  const written: string[] = []
  try {
    // baseImages (data-URLs of images the user attached/pasted this turn) turn
    // this into an EDIT/img2img call — the model transforms the given image(s)
    // per the prompt instead of generating from scratch.
    const { dataUrls, usage } = await deps.generateImage(token, model, {
      prompt: args.prompt || '',
      baseImages: Array.isArray(baseImages) ? baseImages.map((b: Json) => b.dataUrl || b).filter(Boolean) : [],
      signal: ctx.signal,
    })
    const imageRefs: Json[] = []
    for (const dataUrl of dataUrls) {
      ctx.signal?.throwIfAborted()
      // bytes go under a per-user folder; the path is recorded at the answer commit
      const relPath = `${encodeURIComponent(email || 'anon')}/${randomUUID()}.png`
      const { volumePath, contentType } = await deps.putImageDataUrl(token, relPath, dataUrl)
      written.push(volumePath)
      // cancelled during the Volume write: the file goes too (the catch below)
      ctx.signal?.throwIfAborted()
      // Attach the generation model + usage so the image block can show its
      // cost estimate (usage covers the whole call; split evenly if the model
      // returned several images so the per-block numbers still sum correctly).
      const perImage =
        usage && dataUrls.length > 1
          ? {
              prompt_tokens: Math.round((usage.prompt_tokens || 0) / dataUrls.length),
              completion_tokens: Math.round((usage.completion_tokens || 0) / dataUrls.length),
              image_output_tokens: Math.round((usage.image_output_tokens || 0) / dataUrls.length),
              // the image tokens only show up in total_tokens (see estimateCost)
              total_tokens: Math.round((usage.total_tokens || 0) / dataUrls.length),
            }
          : usage
      imageRefs.push({
        ref: `img_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        imageId: null,
        pending: { prompt: args.prompt || '', model, volumePath, contentType },
        prompt: args.prompt || '',
        model,
        usage: perImage || null,
      })
    }
    const resultText =
      imageRefs.length === 1
        ? `${m.okOne} (ref: ${imageRefs[0].ref}). ${m.insertOne} {"type":"image","imageRef":"${imageRefs[0].ref}","caption":"..."}.`
        : `${m.okMany(imageRefs.length)} (refs: ${imageRefs.map((r) => r.ref).join(', ')}). ${m.insertMany}`
    return { resultText, chartCandidates: [], imageRefs }
  } catch (e: Json) {
    // nothing will reference the files written so far: remove them (best effort)
    if (written.length) await Promise.allSettled(written.map((p) => deps.deleteImageFile(token, p)))
    // a cancel is not a tool failure: it propagates unchanged
    if (e?.name === 'AbortError') throw e
    // Localize the known failure modes so the chip + the model's relay speak
    // the user's language. The missing-scope 403 is the actionable one.
    const raw = String(e?.message || e)
    let msg: string
    if (/scopes?:\s*files|required scopes/i.test(raw)) msg = m.missingScope
    else if (/Volume (write|read) failed/i.test(raw)) msg = m.writeFailed
    else if (/returned no image/i.test(raw)) msg = m.noImage
    // a model that does not exist (404) leaves the picker until restart; a refused one (403) stays for the others
    else if (markImageEndpointUnavailable(e, model)) msg = m.unavailable
    else if (e?.status === 403 || /PERMISSION_DENIED/.test(String(e?.code || ''))) msg = m.noPermission
    else msg = `${m.generic}: ${raw.slice(0, 200)}`
    // thrown so runAssistantTurn marks the tool call as errored (red chip)
    throw new Error(msg)
  } finally {
    if (timer) clearInterval(timer)
  }
}

// MCP Apps: after the model's call to a tool that declared a UI resource, read it once (same URL, same token) and stage the record
// on the tool trace. Every failure leaves the plain tool result: the code and the CSP the server declared are logged, nothing is
// stored (graceful degradation is the spec's rule). Never under app_sp, never past the per-turn cap.
async function captureUiResource(token: string, resolver: ToolResolver, ctx: ToolCtx, resultText: string, structuredContent: unknown) {
  if (!resolver.ui || !ctx.uiCapture || currentRunAs() === 'app_sp') return null
  if (ctx.uiCapture.count >= MCP_APPS_LIMITS.appsPerTurn) return null
  if (/^ERROR:/.test(resultText)) return null // the call itself failed: there is no App to show
  const serviceName = String(resolver.ref?.connectionName || resolver.connectionName || '')
  const hosts = uiHostsFromEnv()
  const rec = await fetchUiResource(resolver.url as string, token, resolver.ui.resourceUri, {
    serviceName,
    toolName: String(resolver.mcpToolName || ''),
    ...hosts,
    structuredContent,
    signal: ctx.signal ?? null,
  })
  if ('error' in rec) {
    logger.warn(`mcp app ui resource skipped code=${rec.error} service=${serviceName}`)
    return null
  }
  ctx.uiCapture.count += 1
  logger.info(`mcp app ui resource captured service=${serviceName} sha256=${rec.sha256} bytes=${rec.html.length} csp=${JSON.stringify(rec.csp)}`)
  return rec
}

async function invokeToolRaw(token: string, resolver: ToolResolver, args: Json, ctx: ToolCtx): Promise<Json> {
  if (resolver.kind === ARTIFACT_TOOL_KIND) return invokeArtifactTool(token, resolver, args, ctx)

  if (resolver.kind === 'python') {
    const { rows } = await execStatement(token, `SELECT ${pythonFqName()}(:code)`, [
      { name: 'code', type: 'STRING', value: args.code || '' },
    ])
    return { resultText: rows[0]?.[0] ?? '', chartCandidates: [] }
  }

  if (resolver.kind === 'image-gen') return generateImageStaged(token, args, ctx)

  if (resolver.kind === 'genie') {
    const { spaceId, title } = resolver.ref
    const { sessionId, email, onProgress } = ctx
    const existingConvId = sessionId ? await getGenieConversationId(email, token, sessionId, spaceId) : null
    const { conversationId, resultText, queryRows } = await askGenie(
      token,
      spaceId,
      args.question || '',
      existingConvId,
      onProgress
    )
    // a cancelled turn records nothing, not even the Genie conversation to continue
    if (sessionId && conversationId !== existingConvId && !ctx.signal?.aborted) {
      await setGenieConversationId(email, token, sessionId, spaceId, conversationId)
    }
    const chartCandidates = queryRows.length >= 2 ? chartCandidatesFromRows(title, queryRows) : []
    return { resultText, chartCandidates }
  }

  if (resolver.kind === 'genie-one') {
    const { sessionId, email, onProgress } = ctx
    const existingConvId = sessionId
      ? await getGenieConversationId(email, token, sessionId, GENIE_ONE_SPACE_ID)
      : null
    const { conversationId, resultText, queryRows } = await askGenieOne(
      token,
      args.question || '',
      existingConvId,
      onProgress
    )
    if (sessionId && conversationId !== existingConvId && !ctx.signal?.aborted) {
      await setGenieConversationId(email, token, sessionId, GENIE_ONE_SPACE_ID, conversationId)
    }
    // Genie One returns tabular results as a markdown table inside resultText;
    // askGenieOne recovers it as rows so we can build the same deterministic
    // chart candidates a per-space Genie query or a spreadsheet upload would.
    const chartCandidates = queryRows?.length >= 2 ? chartCandidatesFromRows('Genie One', queryRows) : []
    return { resultText, chartCandidates }
  }

  if (resolver.kind === 'vector-search') {
    const { ref } = resolver
    const columns = await describeVectorIndexColumns(token, ref, { userEmail: ctx.email })
    const numResults = Number(args.num_results) > 0 ? Math.min(Number(args.num_results), 20) : 5
    const resultText = await queryVectorIndex(token, ref.indexName, columns, args.query || '', numResults)
    return { resultText, chartCandidates: [] }
  }

  if (resolver.kind === 'mcp-external') {
    const { text, structuredContent } = await callMcpTool(resolver.url as string, token, resolver.mcpToolName as string, args) // set by buildToolDefs for this kind
    const uiResource = await captureUiResource(token, resolver, ctx, text, structuredContent)
    return uiResource ? { resultText: text, chartCandidates: [], uiResource } : { resultText: text, chartCandidates: [] }
  }

  if (resolver.kind === 'web-search') {
    // the only producer of the model-facing text is renderWebSearchForModel
    // (untrusted-content envelope); a failure throws WebSearchError, whose
    // fixed message the turn hands to the model as `ERROR: …`
    const result = await searchWeb(String(args.query ?? args.q ?? ''), {
      limit: args.limit,
      token,
      email: ctx.email,
      signal: ctx.signal,
      callId: ctx.toolCallId as string | null | undefined,
    })
    return { resultText: renderWebSearchForModel(result), chartCandidates: [] }
  }

  if (resolver.kind === 'web-fetch') {
    const page = await fetchWebPage(args.url || '', { maxChars: args.max_chars })
    return { resultText: JSON.stringify(page, null, 2), chartCandidates: [] }
  }

  if (resolver.kind === 'mcp-external-error') {
    return { resultText: `ERROR: ${resolver.error}`, chartCandidates: [] }
  }

  const { ref } = resolver
  const paramNames = ref.params.map((_: unknown, i: number) => `p${i}`)
  const stmt = `SELECT \`${ref.catalog}\`.\`${ref.schema}\`.\`${ref.name}\`(${paramNames.map((n: string) => `:${n}`).join(', ')})`
  const parameters = ref.params.map((p: Json, i: number) => ({
    name: paramNames[i],
    type: p.type,
    value: coerceArg(args[p.name], p.type),
  }))
  const { rows } = await execStatement(token, stmt, parameters, { warehouseId: warehouseId() })
  const val = rows[0]?.[0]
  return { resultText: val == null ? '(sem retorno)' : String(val), chartCandidates: [] }
}
