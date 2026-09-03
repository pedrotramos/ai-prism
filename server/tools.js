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
import { execStatement, warehouseId } from './warehouse.js'
import { askGenie, askGenieOne } from './genie.js'
import { getGenieConversationId, setGenieConversationId } from './db.js'
import { chartCandidatesFromRows } from './analysis.js'
import { listMcpTools, callMcpTool } from './mcpClient.js'
import { externalMcpUrl } from './externalMcp.js'
import { describeVectorIndexColumns, queryVectorIndex } from './vectorSearch.js'
import { pythonUdfDDL } from '../shared/pythonUdf.js'
import { randomUUID } from 'node:crypto'
import { generateImage, DEFAULT_IMAGE_MODEL } from './llm.js'
import { putImageDataUrl } from './imageStore.js'
import { createImage } from './db.js'
import { fetchWebPage, searchWeb, webSearchConfigured } from './web.js'

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
// regardless of the central search backend. Search can use Brave, SearXNG, or
// the legacy governed MCP connection; page retrieval is always native so a
// search snippet can never be mistaken for the source's actual contents.
export function webSearchConnectionName() {
  // Hard kill-switch: WEB_SEARCH_DISABLED=1 turns the whole feature off even if a
  // connection is configured. The web search tool isn't meant to be an ad-hoc
  // MCP call the model can trip over; it should ship as a governed, deploy-time
  // tool (a UC function, like the Python exec UDF) or a connection an admin
  // explicitly configures. Until that lands, this keeps it fully off so the
  // model is never told about a tool that isn't reliably there. Treating the
  // name as empty makes both the tool registration AND the grounding directive
  // (which calls this) degrade to the un-grounded path with no other changes.
  if (process.env.WEB_SEARCH_DISABLED === '1') return ''
  return (process.env.WEB_SEARCH_CONNECTION || '').trim()
}

// Localized strings for the image tool's success/error result text — this text
// is shown in the tool chip AND fed back to the model, so it should match the
// user's chosen response language. 'auto'/unknown → pt (the app's default).
function imageErrMsgs(lang) {
  const C = {
    pt: {
      okOne: 'Imagem gerada com sucesso',
      okMany: (n) => `Foram geradas ${n} imagens`,
      insertOne: 'Insira-a na resposta com um bloco ```prism-block``` do tipo "image", ex.:',
      insertMany: 'Insira cada uma com um bloco ```prism-block``` do tipo "image" usando o "imageRef" correspondente.',
      missingScope:
        'ERRO: o app não tem permissão para gravar imagens (falta o escopo OAuth "files"). ' +
        'Peça a um administrador para reimplantar o app com esse escopo; depois faça login novamente. Avise isso ao usuário.',
      writeFailed: 'ERRO: falha ao gravar a imagem no Volume. Avise o usuário e sugira tentar de novo.',
      noImage: 'ERRO: o modelo não retornou nenhuma imagem. Avise o usuário e sugira reformular o pedido.',
      generic: 'ERRO ao gerar a imagem',
    },
    en: {
      okOne: 'Image generated successfully',
      okMany: (n) => `${n} images were generated`,
      insertOne: 'Insert it into the reply with an "image" ```prism-block```, e.g.:',
      insertMany: 'Insert each one with an "image" ```prism-block``` using the matching "imageRef".',
      missingScope:
        'ERROR: the app is not allowed to write images (missing the "files" OAuth scope). ' +
        'Ask an administrator to redeploy the app with that scope, then sign in again. Tell the user this.',
      writeFailed: 'ERROR: failed to write the image to the Volume. Tell the user and suggest retrying.',
      noImage: 'ERROR: the model returned no image. Tell the user and suggest rephrasing the request.',
      generic: 'ERROR generating the image',
    },
    es: {
      okOne: 'Imagen generada con éxito',
      okMany: (n) => `Se generaron ${n} imágenes`,
      insertOne: 'Insértala en la respuesta con un bloque ```prism-block``` de tipo "image", p. ej.:',
      insertMany: 'Inserta cada una con un bloque ```prism-block``` de tipo "image" usando el "imageRef" correspondiente.',
      missingScope:
        'ERROR: la app no tiene permiso para escribir imágenes (falta el scope OAuth "files"). ' +
        'Pide a un administrador que vuelva a desplegar la app con ese scope y vuelve a iniciar sesión. Avísale esto al usuario.',
      writeFailed: 'ERROR: no se pudo escribir la imagen en el Volume. Avisa al usuario y sugiere reintentar.',
      noImage: 'ERROR: el modelo no devolvió ninguna imagen. Avisa al usuario y sugiere reformular la solicitud.',
      generic: 'ERROR al generar la imagen',
    },
  }
  return C[lang] || C.pt
}

let builtinReady = false
export async function ensureBuiltinPythonTool(token) {
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
        'ao usar o dado. Prefira várias buscas específicas a uma genérica.',
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
function sqlTypeToJsonSchema(fullType) {
  const t = (fullType || '').toLowerCase().trim()
  if (/^(string|varchar|char)/.test(t)) return { type: 'string' }
  if (/^(tinyint|smallint|int|integer|bigint|long|byte)/.test(t)) return { type: 'integer' }
  if (/^(float|double|decimal|numeric|real)/.test(t)) return { type: 'number' }
  if (/^boolean/.test(t)) return { type: 'boolean' }
  if (/^(date|timestamp|interval)/.test(t)) return { type: 'string', description: `formato ${t}` }
  return null // unsupported (array/map/struct/binary/void)
}

function sanitizeToolName(rawName) {
  const raw = rawName.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (raw.length <= 64) return raw
  // Deterministic short suffix keeps names unique without needing a lookup by hash.
  let hash = 0
  for (const ch of raw) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return raw.slice(0, 55) + '_' + hash.toString(36).slice(0, 8)
}

/** Search Unity Catalog Functions the user can see, by name substring. */
export async function searchUcFunctions(token, query, limit = 20) {
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
    routineRows.map(async ([cat, sch, name, comment]) => {
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
      const params = paramRows.map(([pname, ptype, pcomment]) => ({
        name: pname,
        type: ptype,
        comment: pcomment || '',
        jsonSchema: sqlTypeToJsonSchema(ptype),
      }))
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

function coerceArg(value, sqlType) {
  const t = (sqlType || '').toLowerCase()
  if (/^boolean/.test(t)) return String(value) === 'true' || value === true ? 'true' : 'false'
  return String(value)
}

function genieToolName(spaceId) {
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
// discovering it on every chat turn would add a network round trip per
// enabled connection, so the list is cached briefly per (user, connection),
// same pattern as the Genie Spaces search cache in genie.js.
const MCP_TOOLS_CACHE_TTL_MS = 10 * 60 * 1000
const mcpToolsCache = new Map() // `${email}:${url}` -> { ts, tools }
async function listMcpToolsCached(url, token, email) {
  const key = `${email}:${url}`
  const cached = mcpToolsCache.get(key)
  if (cached && Date.now() - cached.ts < MCP_TOOLS_CACHE_TTL_MS) return cached.tools
  const tools = await listMcpTools(url, token)
  mcpToolsCache.set(key, { ts: Date.now(), tools })
  return tools
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
// NOTA: 'web-search' foi removido como tool NATIVA habilitável/desabilitável.
// Nesse primeiro momento a busca na internet é feita por um MCP EXTERNO (grupo
// 'mcp-external'), não pela tool nativa. O código nativo (web.js +
// web_search/web_fetch em buildToolDefs, o card em ToolsAdminTab) segue no repo,
// apenas COMENTADO — para reabilitar, readicione 'web-search' abaixo e
// descomente o bloco correspondente em buildToolDefs e o card em ToolsAdminTab.
export const TOOL_GROUP_KEYS = ['python', 'genie-one', 'image-gen', 'genie', 'vector-search', 'uc', 'mcp-external']

// Company-data tool groups: they answer with the user's own workspace data
// (Genie translates NL→SQL over UC tables / Genie Spaces; vector search over
// their indexes; UC functions they attached). On an artifact-generation turn
// with no data intent, the router asks to suppress these (see
// detectCapabilities → suppressDataTools) so the model can't misfire a Genie
// call while building an unrelated deck. `python`, `image-gen`, `web-search`,
// and `mcp-external` are NOT data tools and are never suppressed here.
const DATA_TOOL_KINDS = new Set(['genie-one', 'genie', 'vector-search', 'uc'])

export async function buildToolDefs(
  enabledRefs,
  token,
  email,
  { includePython = true, includeImage = false, includeWebSearch = true, toolPolicy = {}, suppressDataTools = false } = {}
) {
  const tools = []
  const resolvers = new Map()
  // org policy: a key absent from the map is enabled (default-on); only an
  // explicit `false` disables a group. Enforced here so a disabled group can
  // never reach the model even if a stale session ref or client still requests it.
  const allowed = (key) => toolPolicy[key] !== false
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
  // Web grounding: offered on EVERY turn (includeWebSearch defaults on) so any
  // interaction can be grounded in current facts — the model decides when a
  // question actually needs the live web from the tool description. Still gated
  // by the org policy and by an admin having configured a backing connection;
  // a missing connection → silently skipped (un-grounded, the prior behavior).
  // DESATIVADO (nesse primeiro momento): a busca na internet é feita por um MCP
  // externo, não pela tool nativa. Mantido comentado (não removido) para reativar
  // facilmente — basta descomentar e readicionar 'web-search' a TOOL_GROUP_KEYS.
  // const webSearchConn = webSearchConnectionName()
  // if (includeWebSearch && allowed('web-search') && webSearchConfigured()) {
  //   tools.push(webSearchToolDef())
  //   tools.push(webFetchToolDef())
  //   resolvers.set(WEB_SEARCH_TOOL_FN_NAME, webSearchConn && !process.env.BRAVE_SEARCH_API_KEY && !process.env.SEARXNG_URL
  //     ? { kind: 'web-search-mcp', connectionName: webSearchConn, url: externalMcpUrl(webSearchConn) }
  //     : { kind: 'web-search' })
  //   resolvers.set(WEB_FETCH_TOOL_FN_NAME, { kind: 'web-fetch' })
  // }

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
            `Faz uma pergunta em linguagem natural para a sala Genie "${ref.title}". Genie conhece ` +
            `estes dados: ${ref.description || 'sem descrição disponível'}. Genie traduz a pergunta em ` +
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
      const url = externalMcpUrl(ref.connectionName)
      let mcpTools = []
      try {
        mcpTools = await listMcpToolsCached(url, token, email)
      } catch (e) {
        // Some connections need one-time per-user OAuth consent (confirmed
        // live: tools/list itself fails with UNAUTHENTICATED + a login URL
        // until the user visits it) — rather than silently drop the
        // connection, register one status tool so the model can surface the
        // actual reason (and login link) to the user instead of the
        // connection just vanishing with no explanation.
        const toolName = sanitizeToolName(`mcpext__${ref.connectionName}__status`)
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: `Verifica por que a conexão MCP externa "${ref.connectionName}" está indisponível.`,
            parameters: { type: 'object', properties: {} },
          },
        })
        resolvers.set(toolName, { kind: 'mcp-external-error', connectionName: ref.connectionName, error: e.message })
        continue
      }
      for (const mt of mcpTools) {
        const toolName = sanitizeToolName(`mcpext__${ref.connectionName}__${mt.name}`)
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: (mt.description || `Tool ${mt.name} do MCP externo ${ref.connectionName}`).slice(0, 1000),
            parameters: mt.inputSchema || { type: 'object', properties: {} },
          },
        })
        resolvers.set(toolName, { kind: 'mcp-external', ref, mcpToolName: mt.name, url })
      }
      continue
    }

    if (!ref?.catalog || !ref?.schema || !ref?.name || !Array.isArray(ref.params)) continue
    const toolName = sanitizeToolName(`uc__${ref.catalog}__${ref.schema}__${ref.name}`)
    const properties = {}
    const required = []
    for (const p of ref.params) {
      if (!p.jsonSchema) continue
      properties[p.name] = { ...p.jsonSchema, description: p.comment || undefined }
      required.push(p.name)
    }
    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: ref.comment || `Unity Catalog function ${ref.fullName}`,
        parameters: { type: 'object', properties, required },
      },
    })
    resolvers.set(toolName, { kind: 'uc', ref })
  }
  return { tools, resolvers }
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
export async function invokeTool(token, resolver, args, ctx = {}) {
  if (resolver.kind === 'python') {
    const { rows } = await execStatement(token, `SELECT ${pythonFqName()}(:code)`, [
      { name: 'code', type: 'STRING', value: args.code || '' },
    ])
    return { resultText: rows[0]?.[0] ?? '', chartCandidates: [] }
  }

  if (resolver.kind === 'image-gen') {
    const { sessionId, email, imageModel, baseImages, onProgress } = ctx
    const model = imageModel || DEFAULT_IMAGE_MODEL
    const m = imageErrMsgs(ctx.lang)
    // image endpoints run ~10–30s; tick the chip so it's not a silent spinner
    const startedAt = Date.now()
    const timer = onProgress
      ? setInterval(() => onProgress({ elapsedMs: Date.now() - startedAt }), 1000)
      : null
    try {
      // baseImages (data-URLs of images the user attached/pasted this turn) turn
      // this into an EDIT/img2img call — the model transforms the given image(s)
      // per the prompt instead of generating from scratch.
      const { dataUrls, usage } = await generateImage(token, model, {
        prompt: args.prompt || '',
        baseImages: Array.isArray(baseImages) ? baseImages.map((b) => b.dataUrl || b).filter(Boolean) : [],
      })
      const imageRefs = []
      for (const dataUrl of dataUrls) {
        // write bytes to the Volume under a per-user folder (governed by the
        // user's own grants), then record the path in chat_images.
        const relPath = `${encodeURIComponent(email || 'anon')}/${randomUUID()}.png`
        const { volumePath, contentType } = await putImageDataUrl(token, relPath, dataUrl)
        const id = await createImage(email, token, sessionId, {
          prompt: args.prompt || '',
          model,
          volumePath,
          contentType,
        })
        // Attach the generation model + usage so the image block can show its
        // cost estimate (usage covers the whole call; split evenly if the model
        // returned several images so the per-block numbers still sum correctly).
        const perImage =
          usage && dataUrls.length > 1
            ? {
                prompt_tokens: Math.round((usage.prompt_tokens || 0) / dataUrls.length),
                completion_tokens: Math.round((usage.completion_tokens || 0) / dataUrls.length),
                image_output_tokens: Math.round((usage.image_output_tokens || 0) / dataUrls.length),
              }
            : usage
        imageRefs.push({ ref: `img_${id}`, imageId: id, prompt: args.prompt || '', model, usage: perImage || null })
      }
      const resultText =
        imageRefs.length === 1
          ? `${m.okOne} (ref: ${imageRefs[0].ref}). ${m.insertOne} {"type":"image","imageRef":"${imageRefs[0].ref}","caption":"..."}.`
          : `${m.okMany(imageRefs.length)} (refs: ${imageRefs.map((r) => r.ref).join(', ')}). ${m.insertMany}`
      return { resultText, chartCandidates: [], imageRefs }
    } catch (e) {
      // Localize the known failure modes so the chip + the model's relay speak
      // the user's language. The missing-scope 403 is the actionable one.
      const raw = String(e?.message || e)
      let msg
      if (/scopes?:\s*files|required scopes/i.test(raw)) msg = m.missingScope
      else if (/Volume (write|read) failed/i.test(raw)) msg = m.writeFailed
      else if (/returned no image/i.test(raw)) msg = m.noImage
      else msg = `${m.generic}: ${raw.slice(0, 200)}`
      // thrown so runAssistantTurn marks the tool call as errored (red chip)
      throw new Error(msg)
    } finally {
      if (timer) clearInterval(timer)
    }
  }

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
    if (sessionId && conversationId !== existingConvId) {
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
    if (sessionId && conversationId !== existingConvId) {
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
    const columns = await describeVectorIndexColumns(token, ref)
    const numResults = Number(args.num_results) > 0 ? Math.min(Number(args.num_results), 20) : 5
    const resultText = await queryVectorIndex(token, ref.indexName, columns, args.query || '', numResults)
    return { resultText, chartCandidates: [] }
  }

  if (resolver.kind === 'mcp-external') {
    const { text } = await callMcpTool(resolver.url, token, resolver.mcpToolName, args)
    return { resultText: text, chartCandidates: [] }
  }

  if (resolver.kind === 'web-search') {
    const results = await searchWeb(args.query || args.q || '', { limit: args.limit })
    return { resultText: JSON.stringify({ query: args.query || args.q || '', results }, null, 2), chartCandidates: [] }
  }

  if (resolver.kind === 'web-fetch') {
    const page = await fetchWebPage(args.url || '', { maxChars: args.max_chars })
    return { resultText: JSON.stringify(page, null, 2), chartCandidates: [] }
  }

  if (resolver.kind === 'web-search-mcp') {
    // The backing MCP server exposes its own tool name(s); resolve the one that
    // actually does a search at call time (cheap, cached) so any web-search MCP
    // works behind the single clean `web_search` tool the model sees. The arg
    // key can differ per server too, so pass the query under the common aliases.
    const mcpTools = await listMcpToolsCached(resolver.url, token, ctx.email).catch(() => [])
    const searchTool =
      mcpTools.find((t) => /web[_-]?search/i.test(t.name)) ||
      mcpTools.find((t) => /search/i.test(t.name)) ||
      mcpTools[0]
    if (!searchTool) {
      return { resultText: 'ERROR: nenhuma tool de busca disponível na conexão de web search configurada.', chartCandidates: [] }
    }
    const q = args.query || args.q || ''
    const { text } = await callMcpTool(resolver.url, token, searchTool.name, { query: q, q, ...args })
    return { resultText: text, chartCandidates: [] }
  }

  if (resolver.kind === 'mcp-external-error') {
    return { resultText: `ERROR: ${resolver.error}`, chartCandidates: [] }
  }

  const { ref } = resolver
  const paramNames = ref.params.map((_, i) => `p${i}`)
  const stmt = `SELECT \`${ref.catalog}\`.\`${ref.schema}\`.\`${ref.name}\`(${paramNames.map((n) => `:${n}`).join(', ')})`
  const parameters = ref.params.map((p, i) => ({
    name: paramNames[i],
    type: p.type,
    value: coerceArg(args[p.name], p.type),
  }))
  const { rows } = await execStatement(token, stmt, parameters, { warehouseId: warehouseId() })
  const val = rows[0]?.[0]
  return { resultText: val == null ? '(sem retorno)' : String(val), chartCandidates: [] }
}
