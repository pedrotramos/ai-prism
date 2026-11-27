import { usageContext, aiGatewayRequestTags, AI_GATEWAY_REQUEST_TAGS_HEADER } from './resourceTags.ts'
import { currentUsageTags } from './usageTags.ts'
import { logger } from './log.ts'
import { startLlmSpan, finishSpan, recordLlmUsage, withSpan } from './telemetry.ts'
import type { Span } from '@opentelemetry/api'

interface ReasoningFlag {
  param: string
  levels: string[]
}
interface ModelInfo {
  id: string
  label: string
  provider: string
  blurb?: string
  in?: number
  out?: number
  modality?: string
  vision: boolean
  streamUsage?: boolean
  noTemperature?: boolean
  tools: boolean
  maxOut: number
  promptCache?: boolean
  defaultOn?: boolean
  reasoning?: ReasoningFlag
}
// A chat message as the gateway takes it; `content` is a string or an array of parts.
interface ChatMessage {
  role: string
  content?: unknown
  [k: string]: unknown
}
interface ChatOpts {
  maxTokens?: number
  temperature?: number
  tools?: unknown[]
  reasoningEffort?: string | null
  signal?: AbortSignal
  usageKind?: string
  [k: string]: unknown
}
type UsageSink = (kind: string, model: string, usage: unknown, meta?: unknown) => unknown
// Gateway JSON/stream payloads are read defensively (optional chaining), so they stay loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped gateway payload
type Payload = any

// Catalog of AI Gateway models surfaced in the UI. `in`/`out` are the vendors'
// public list prices (USD per 1M tokens, conferidos nas páginas oficiais em
// nov/2026) used for the cost estimate; the billed spend comes from the system
// tables. Ao atualizar um preço aqui, ele propaga para instalações existentes
// (o catálogo do admin só guarda preço quando o admin o customiza).
// `defaultOn:false` keeps a curated model (flags + price known) OFF in a fresh
// catalog — it stays one click away in the admin's "Add model".
// `streamUsage` marks endpoints that accept the OpenAI `stream_options` field
// (Anthropic Claude + proprietary GPT-5). Gemini and the open-weights models
// served here reject it with a 400, so we omit it for them.
// `tools` marks endpoints we attach function-calling tools to (all of them —
// the AI Gateway normalizes tool calling across providers). If a specific
// endpoint ever rejects the `tools` field, index.js retries that turn without
// it rather than failing the whole request, so this flag is a hint, not a hard guarantee.
// `promptCache` marks endpoints that honor Anthropic `cache_control` breakpoints
// through the AI Gateway's OpenAI-compat chat/completions endpoint. Sondado ao
// vivo (jul/2026, workspace e2-demo-field-eng): a família Claude aceita
// `cache_control` num bloco de conteúdo (system OU tool) e devolve
// `cache_read_input_tokens` numa repetição — cache HIT confirmado. Modelos
// não-Claude (GPT-5.6) toleram o campo sem 400 (e já auto-cacheiam). O prefixo
// estável de um turno (system+histórico) é reenviado a cada rodada de tool; com
// cache, a rodada de síntese lê esse prefixo do cache em vez de reprocessá-lo —
// acelera SEM mudar 1 byte do que o modelo vê. Ver applyCacheControl abaixo.
// `maxOut` is the max_tokens sent on chat turns. It must clear two bars: um
// deck completo (o maior artefato de um turno) consome bem mais que 4k tokens,
// e modelos de raciocínio queimam parte do orçamento em thinking oculto. Não
// pode passar do teto do endpoint, que o gateway rejeita com 400 — tetos
// sondados empiricamente: llama-4-maverick 8192, qwen35-122b 16384,
// gpt-oss-120b 16384, demais aceitam ≥32768.
//
// Catálogo curado (fase 1): estes ids/labels/flags foram conferidos ao vivo
// contra os endpoints `llm/v1/chat` do AI Gateway do workspace (e2-demo-field-eng).
// Sondas empíricas confirmaram, por endpoint: rejeição de `temperature` custom
// (→ noTemperature; ex.: toda a família Claude 5, GPT-5.6), aceitação de
// `stream_options` (→ streamUsage; Gemini rejeita com 400) e o teto de
// max_tokens. Modelos são adicionados/atualizados aqui à mão POR ORA — a fase 2
// (auto-discovery via GET /serving-endpoints, filtrando task=llm/v1/chat e
// aplicando estes overrides por padrão de nome) torna esta lista automática.
// Reasoning-effort flag (see the W3-7 block below). Set only from probe evidence:
// scripts/probe/reasoning-effort.mjs, run 2026-11-19 against the E2_Demo-class FEVM
// workspace. Rule: the endpoint accepts low, medium and high AND rejects an invalid
// value (so it validates the field), and an effect is visible or documented.
// Not flagged on purpose: Gemini 4 Argon (400 on both shapes), Llama 4 Maverick and
// Qwen3.5 (validate the field but no effect is demonstrable), Claude Haiku 4.5 and the
// Fable models (400/404 here), image models.
const effortFlag = (param: string): ReasoningFlag => ({ param, levels: ['low', 'medium', 'high'] })

export const MODELS: ModelInfo[] = [
  // Geração atual (nov/2026) — habilitada por padrão. A PRIMEIRA entrada é o
  // default de chats novos. Flags sondadas ao vivo em 02/11/2026 (E2_Demo):
  // toda a geração nova rejeita temperature custom exceto GLM; todas aceitam
  // max_tokens ≥32768; Gemini segue rejeitando stream_options (mas devolve usage
  // no stream mesmo assim); GLM-5.3 (não o Flash) recusa imagem.
  { id: 'databricks-claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'Anthropic', blurb: 'Equilibrado e rápido — ótimo padrão para agentes', in: 2, out: 10, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true, reasoning: effortFlag('anthropic') },
  { id: 'databricks-claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'Anthropic', blurb: 'Máxima capacidade para agentes, código e análise longa', in: 4, out: 20, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true, reasoning: effortFlag('anthropic') },
  { id: 'databricks-claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'Anthropic', blurb: 'O topo da família Claude: raciocínio profundo e escrita criativa', in: 10, out: 50, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true },
  { id: 'databricks-claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'Anthropic', blurb: 'Rápido e muito econômico', in: 0.1, out: 0.5, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true, reasoning: effortFlag('anthropic') },
  { id: 'databricks-gpt-6-1-sol', label: 'GPT-6.1 Sol', provider: 'OpenAI', blurb: 'Agentes, código e raciocínio longo com ótimo custo', in: 2, out: 10, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-gpt-6-1-terra', label: 'GPT-6.1 Terra', provider: 'OpenAI', blurb: 'Equilíbrio de custo e capacidade para o dia a dia', in: 1, out: 5, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-gpt-6-luna', label: 'GPT-6 Luna', provider: 'OpenAI', blurb: 'O mais rápido e econômico da família GPT-6', in: 0.1, out: 0.5, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-gpt-6-astra', label: 'GPT-6 Astra', provider: 'OpenAI', blurb: 'Carro-chefe da OpenAI para os problemas mais difíceis', in: 10, out: 50, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-gemini-4-argon', label: 'Gemini 4 Argon', provider: 'Google', blurb: 'Multimodal de fronteira do Google, contexto longo', in: 4, out: 20, vision: true, streamUsage: false, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gemini-3-8-flash', label: 'Gemini 3.8 Flash', provider: 'Google', blurb: 'Multimodal, rápido e eficiente para alto volume', in: 0.75, out: 3.75, vision: true, streamUsage: false, noTemperature: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-kimi-k3', label: 'Kimi K3', provider: 'Moonshot AI', blurb: 'Contexto longo, multimodal e forte em trabalho agentivo', in: 3, out: 15, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-glm-5-3', label: 'GLM-5.3', provider: 'Zhipu AI', blurb: 'Aberto, forte em raciocínio e código', in: 1.4, out: 4.4, vision: false, streamUsage: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-glm-5-3-flash', label: 'GLM-5.3 Flash', provider: 'Zhipu AI', blurb: 'Aberto, leve e multimodal a custo mínimo', in: 0.15, out: 0.5, vision: true, streamUsage: true, tools: true, maxOut: 32768, reasoning: effortFlag('openai') },
  { id: 'databricks-llama-4-maverick', label: 'Llama 4 Maverick', provider: 'Meta', blurb: 'Pesos abertos, modelo geral robusto', in: 0.5, out: 1.5, vision: false, streamUsage: false, tools: true, maxOut: 8192 },
  { id: 'databricks-qwen35-122b-a10b', label: 'Qwen3.5 122B', provider: 'Alibaba', blurb: 'Aberto e eficiente, raciocínio MoE', in: 0.22, out: 2.2, vision: false, streamUsage: true, tools: true, maxOut: 8192 },
  // Geração anterior — continua curada (flags e preço conhecidos), mas
  // `defaultOn:false`: não entra habilitada num catálogo novo e fica a um clique
  // no "Add model" da aba de admin, com o preço já preenchido.
  { id: 'databricks-claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic', blurb: 'Geração anterior do Sonnet', in: 2, out: 10, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true, defaultOn: false, reasoning: effortFlag('anthropic') },
  { id: 'databricks-claude-opus-5', label: 'Claude Opus 5', provider: 'Anthropic', blurb: 'Geração anterior do Opus', in: 5, out: 25, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true, defaultOn: false, reasoning: effortFlag('anthropic') },
  { id: 'databricks-claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic', blurb: 'Geração anterior do Fable', in: 10, out: 50, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true, defaultOn: false },
  { id: 'databricks-gpt-5-6-luna', label: 'GPT-5.6 Luna', provider: 'OpenAI', blurb: 'O mais rápido e econômico da família 5.6', in: 0.2, out: 1.2, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, defaultOn: false, reasoning: effortFlag('openai') },
  { id: 'databricks-gpt-5-6-terra', label: 'GPT-5.6 Terra', provider: 'OpenAI', blurb: 'Equilíbrio de custo e capacidade da família 5.6', in: 2, out: 12, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, defaultOn: false, reasoning: effortFlag('openai') },
  { id: 'databricks-gpt-5-6-sol', label: 'GPT-5.6 Sol', provider: 'OpenAI', blurb: 'O topo da família 5.6', in: 4, out: 20, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, defaultOn: false, reasoning: effortFlag('openai') },
  { id: 'databricks-gemini-3-6-flash', label: 'Gemini 3.6 Flash', provider: 'Google', blurb: 'Geração anterior do Gemini Flash', in: 1.5, out: 7.5, vision: true, streamUsage: false, noTemperature: true, tools: true, maxOut: 32768, defaultOn: false },
  { id: 'databricks-glm-5-2', label: 'GLM-5.2', provider: 'Zhipu AI', blurb: 'Geração anterior do GLM', in: 1.4, out: 4.4, vision: false, streamUsage: true, tools: true, maxOut: 32768, defaultOn: false },
  // Image-generation endpoints. Sondado ao vivo (jul/2026, e2-demo-field-eng):
  // servem por `task=llm/v1/chat` — NÃO há API de imagem separada. A resposta
  // traz `choices[0].message.content` como um array [{type:"image_url",
  // image_url:{url:"data:image/png;base64,..."}}] e `usage.image_output_tokens`.
  // Aceitam imagem no input (edição/img2img) e `usage_context` (custos). São
  // chamados por generateImage(), nunca pelo streamChat do chat comum — por isso
  // `modality:'image'` os mantém FORA do picker de chat (ver buildUserModels).
  // noTemperature: conservador (nunca causa 400); vision: aceitam image_url no input.
  // Preço (nov/2026): entrada 0,50 e saída de imagem 60 por 1M tokens. O usage
  // do gateway traz a imagem fora de completion_tokens (completion 0, total
  // 522 numa geração sondada) — o ledger cobra total − prompt como saída.
  { id: 'databricks-gemini-3-1-flash-image', label: 'Nano Banana 2', provider: 'Google', blurb: 'Gemini 3.1 Flash — geração de imagem rápida', in: 0.5, out: 60, modality: 'image', vision: true, noTemperature: true, tools: false, maxOut: 8192 },
  { id: 'databricks-gemini-3-pro-image', label: 'Nano Banana Pro', provider: 'Google', blurb: 'Gemini 3 Pro Image — mais detalhe, mais lento', in: 2, out: 120, modality: 'image', vision: true, noTemperature: true, tools: false, maxOut: 8192, defaultOn: false },
]

// Teto de saída dos endpoints de imagem (sondado no Nano Banana 2); vale também
// para ids de imagem fora do catálogo curado.
export const IMAGE_MAX_OUT = 8192

// Nome válido de serving endpoint: letras, dígitos, `-` e `_`, até 63 caracteres
// (regra da API de Model Serving). O 1º caractere alfanumérico impede que o id
// vire uma flag em `databricks serving-endpoints get <id>`. Ids de imagem fora
// dessa forma nunca chegam a uma URL nem ao corpo de uma chamada.
const SERVING_ENDPOINT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
export function isServingEndpointName(id: unknown): id is string {
  return typeof id === 'string' && SERVING_ENDPOINT_NAME_RE.test(id)
}

// Modelo de imagem servido por um Model Provider Service do Unity Catalog
// (entrada `{ provider, model }` do models.json). `provider` é o nome UC de 3
// partes (catálogo.schema.serviço; cada parte só com letras, dígitos e `_`, até
// 255 caracteres) e `model` é o target do Google (ex.: gemini-3.1-flash-image),
// que vai no caminho da URL da chamada.
const UC_NAME_PART_RE = /^[A-Za-z0-9_]{1,255}$/
const PROVIDER_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
export function isModelProviderServiceName(fqn: unknown): fqn is string {
  if (typeof fqn !== 'string') return false
  const parts = fqn.split('.')
  return parts.length === 3 && parts.every((p) => UC_NAME_PART_RE.test(p))
}
export function isProviderTargetName(model: unknown): model is string {
  return typeof model === 'string' && PROVIDER_TARGET_RE.test(model) && !model.includes('..')
}

// Id interno de uma entrada provider: `<provider>/<model>`. É ele que fica no
// catálogo, na escolha salva, em /api/image-models e no payload do turno. Um nome
// de serving endpoint nunca tem `.` nem `/`, então os dois tipos de id não se confundem.
export function providerImageModelId(provider: string, model: string): string {
  return `${provider}/${model}`
}
export function parseProviderImageModelId(id: unknown): { provider: string; model: string } | null {
  if (typeof id !== 'string') return null
  const slash = id.indexOf('/')
  if (slash < 0 || slash !== id.lastIndexOf('/')) return null
  const provider = id.slice(0, slash)
  const model = id.slice(slash + 1)
  return isModelProviderServiceName(provider) && isProviderTargetName(model) ? { provider, model } : null
}

// Id de modelo de imagem que pode chegar a uma URL: nome de serving endpoint ou
// id derivado de uma entrada provider.
export function isImageModelId(id: unknown): id is string {
  return isServingEndpointName(id) || parseProviderImageModelId(id) !== null
}

// Códigos de erro que um 404 do gateway usa para "este endpoint não existe".
export const ENDPOINT_MISSING_CODES = ['ENDPOINT_NOT_FOUND', 'RESOURCE_DOES_NOT_EXIST', 'NOT_FOUND']

// `imageModels` do models.json, registrado no boot (server/modelsConfig.ts):
// null = chave ausente (vale o catálogo curado); [] = geração de imagem desligada.
export interface ConfiguredImageModel {
  id: string
  label: string
  blurb: string
  provider?: string
  model?: string
}
let configuredImageModels: ConfiguredImageModel[] | null = null
let configuredImageIds = new Set<string>()
export function setConfiguredImageModels(list: ConfiguredImageModel[] | null): void {
  configuredImageModels = Array.isArray(list) ? list.map((m) => ({ ...m })) : null
  configuredImageIds = new Set((configuredImageModels || []).map((m) => m.id))
}
export function getConfiguredImageModels(): ConfiguredImageModel[] | null {
  return configuredImageModels
}

// `models` of the models.json (chat), in file order: what a fresh install (no admin catalog rows yet)
// shows instead of the curated defaults. null = no file.
export interface ConfiguredChatModel {
  id: string
  label: string
  blurb: string
}
let configuredChatModels: ConfiguredChatModel[] | null = null
export function setConfiguredChatModels(list: ConfiguredChatModel[] | null): void {
  configuredChatModels = Array.isArray(list) && list.length ? list.map((m) => ({ ...m })) : null
}
export function getConfiguredChatModels(): ConfiguredChatModel[] | null {
  return configuredChatModels
}

// Modality helpers: an endpoint without `modality` is a chat model (the
// overwhelming default). Only image-generation endpoints carry modality:'image'
// (curated) or are listed in the models.json `imageModels`.
export function isImageModel(id: string): boolean {
  return configuredImageIds.has(id) || MODELS.find((m) => m.id === id)?.modality === 'image'
}
export function imageModels() {
  return MODELS.filter((m) => m.modality === 'image')
}
// Default image model when the user hasn't chosen one (mirrors MODELS[0] for chat).
export const DEFAULT_IMAGE_MODEL = 'databricks-gemini-3-1-flash-image'

// The curated serving-endpoint twin of a provider entry (`<catalog>.<schema>.<svc>/gemini-3.1-flash-image`
// ↔ `databricks-gemini-3-1-flash-image`): same model, so same flags and list price.
export function curatedImageTwin(id: string): ModelInfo | undefined {
  const ref = parseProviderImageModelId(id)
  if (!ref) return undefined
  const twin = `databricks-${ref.model.toLowerCase().replace(/\./g, '-')}`
  return MODELS.find((m) => m.id === twin && m.modality === 'image')
}

// The model for the AUXILIARY calls (title, intent classifier, memory extraction, asset labels): the
// conversation's own model, never a hard-coded one (the Haiku 4.5 they used is retired). Without one
// in the context, the first enabled model of the catalog (models.json order). models.ts registers it.
let defaultChatModel: (() => string | null | undefined) | null = null
export function setDefaultChatModelSource(fn: (() => string | null | undefined) | null): void {
  defaultChatModel = fn
}
export function resolveAuxModel(model?: string | null): string {
  return (typeof model === 'string' && model.trim()) || defaultChatModel?.() || MODELS[0]!.id
}

// Auxiliary calls run at the lowest reasoning level: reasoningFields turns 'low' into each family's
// shape (Claude 5.5 adaptive + effort low, reasoning_effort low) and a model without the flag ignores it.
export const AUX_REASONING = 'low'
// A reasoning model spends part of max_tokens on hidden thinking before the answer, so a short
// auxiliary output needs headroom. Reasoning is not always flagged (a curated model may think by default,
// an uncurated endpoint too), so every model gets it; only generated tokens are billed.
const AUX_REASONING_MAX_TOKENS = 512
export function auxMaxTokens(_model: string, base: number): number {
  return Math.max(base, AUX_REASONING_MAX_TOKENS)
}

// Multilingual embedding model — far better Portuguese discrimination than the
// English-tuned gte/bge endpoints.
const EMBED_MODEL = 'databricks-qwen3-embedding-0-6b'

// Per-family DEFAULT max output tokens for endpoints we haven't curated by hand
// (a freshly-enabled gateway endpoint). The goal is "use as much output as the
// model allows without any manual config and without a probe call": pick the
// family's known output ceiling here, and if a specific endpoint actually rejects
// it, the runtime clamp below (learnedMaxOut / postChat) discovers the true ceiling
// from the 400 and remembers it — so the FIRST over-ask self-corrects and every
// later call uses the exact maximum. Order matters (first match wins); families
// whose ceiling is known-small are pinned so they don't eat a needless retry.
// Curated MODELS keep their own maxOut (proven live) — this only fills the gap for
// the uncurated. Raising the default is safe on cost: you pay for tokens actually
// generated, not for the ceiling.
const FAMILY_MAX_OUT: [RegExp, number][] = [
  [/llama/, 8192], // Llama endpoints here cap at 8192
  [/gpt-oss/, 16384], // gpt-oss-120b ceiling sondado: 16384
  [/qwen/, 16384], // qwen35-122b ceiling sondado: 16384
]
const DEFAULT_MAX_OUT = 32768 // modern families accept ≥32768 (sondado); retry clamps if not
export function deriveMaxOut(id: string): number {
  const s = (id || '').toLowerCase()
  for (const [re, v] of FAMILY_MAX_OUT) if (re.test(s)) return v
  return DEFAULT_MAX_OUT
}

// Conservative flags for an endpoint that isn't in the curated MODELS list
// (e.g. an admin enabled a newly-discovered gateway endpoint). These never
// cause a 400: no custom temperature, no stream_options. `maxOut` reaches for the
// family's max (deriveMaxOut) rather than a flat floor — the runtime clamp below
// self-corrects if an endpoint's real ceiling is lower.
// Suboptimal at worst — the cure is to curate the endpoint, one line above.
function conservativeModel(id: string): ModelInfo {
  return { id, label: id, provider: 'Outros', vision: false, streamUsage: false, noTemperature: true, tools: true, maxOut: deriveMaxOut(id), promptCache: false }
}

export function modelById(id: string): ModelInfo {
  const found = MODELS.find((m) => m.id === id)
  if (found) return found
  // an `imageModels` entry of models.json that is not in the curated list (a provider target, or an
  // image endpoint of this workspace): image flags, the curated twin's when it has one
  if (configuredImageIds.has(id)) {
    const twin = curatedImageTwin(id)
    return { ...(twin || { provider: 'Google', vision: true, noTemperature: true, tools: false, maxOut: IMAGE_MAX_OUT }), id, label: id, modality: 'image' }
  }
  // A non-empty id that isn't curated is treated as a valid-but-unknown
  // endpoint with safe defaults; only a missing id falls back to the default.
  return id ? conservativeModel(id) : MODELS[0]! // the catalog is a non-empty literal
}

// ---------------------------------------------------------------------------
// Reasoning effort (W3-7). A per-turn "how hard should the model think" control.
//
// A catalog entry opts in with `reasoning: { param, levels }`, set ONLY from
// probe evidence (scripts/probe/reasoning-effort.mjs, see docs/): never guessed,
// for the same reason as the other flags above. `param` names the provider body
// shape the gateway accepted; `levels` the subset of REASONING_LEVELS it took.
//   'openai'    → reasoning_effort: '<level>'
//   'anthropic' → thinking: { type: 'adaptive' }, output_config: { effort: '<level>' }
//                 (the shape the Claude 5 endpoints ask for; they refuse thinking.enabled)
//   'anthropic-budget' → thinking: { type: 'enabled', budget_tokens: <n> } (older Claude)
//   'gemini'    → thinking_config: { thinking_budget: <n> }
// Without the flag (every model today, and every admin-added endpoint) the
// control is hidden, the value is dropped and the request body is unchanged.
export const REASONING_LEVELS = ['low', 'medium', 'high']
const THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 16384 }

/**
 * Validates a client-supplied effort. Absent / '' / 'default' mean "do not
 * touch" (`value: null`); anything that is not exactly low|medium|high is not ok.
 */
export function parseReasoningEffort(raw: unknown): { ok: boolean; value: string | null } {
  if (raw === undefined || raw === null || raw === '' || raw === 'default') return { ok: true, value: null }
  if (typeof raw === 'string' && REASONING_LEVELS.includes(raw)) return { ok: true, value: raw }
  return { ok: false, value: null }
}

/** Whether `effort` is a level this model really accepts (flag present + level probed). */
export function supportsReasoning(model: string, effort: string): boolean {
  const r = modelById(model).reasoning
  return !!r && REASONING_LEVELS.includes(effort) && (r.levels || REASONING_LEVELS).includes(effort)
}

/** Body fields for one provider shape + level (the probe script reuses this). */
export function reasoningFields(param: string, effort: string, maxOut = 8192): Record<string, unknown> {
  // thinking budgets must stay under the output ceiling
  const budget = Math.max(1024, Math.min(THINKING_BUDGET[effort]!, maxOut - 1024))
  switch (param) {
    case 'openai':
      return { reasoning_effort: effort }
    case 'anthropic':
      return { thinking: { type: 'adaptive' }, output_config: { effort } }
    case 'anthropic-budget':
      return { thinking: { type: 'enabled', budget_tokens: budget } }
    case 'gemini':
      return { thinking_config: { thinking_budget: budget } }
    default:
      return {}
  }
}

/** The body fields to merge for `effort` on `model`; `{}` when it has none to send. */
export function reasoningParams(model: string, effort: string): Record<string, unknown> {
  if (!supportsReasoning(model, effort)) return {}
  const info = modelById(model)
  return reasoningFields(info.reasoning!.param, effort, info.maxOut) // supportsReasoning checked the flag
}

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

function chatUrl() {
  return `${host()}/serving-endpoints/chat/completions`
}

// Some endpoints reject a custom `temperature` with HTTP 400 (all reasoning
// models; the whole Gemini family). The curated catalog flags the known ones
// (noTemperature), but to make ANY model usable — including a freshly-enabled
// endpoint we haven't curated, or one whose behavior changes — we ALSO learn at
// runtime: the first time an endpoint 400s citing `temperature`, we record it
// here and retry the SAME request without it, so every later call to that model
// skips temperature from the start. Process-local (a Set), reset on restart.
const learnedNoTemperature = new Set<string>()

// Whether to send a custom temperature for this model right now.
function sendsTemperature(model: string, info: ModelInfo): boolean {
  return !info.noTemperature && !learnedNoTemperature.has(model)
}

// A 400 whose body blames `temperature` — the cue to drop it and retry.
function isTemperatureRejection(status: number, text: string): boolean {
  return status === 400 && /temperature/i.test(text || '')
}

// The real max_tokens ceiling learned at runtime for an endpoint whose ceiling is
// lower than what we asked for. This is how we "use the maximum without a probe":
// we ask for the family default (deriveMaxOut / curated maxOut), and if THIS
// endpoint rejects it with a 400, we read its stated ceiling (or halve) and honor
// it here from then on. Process-local (a Map), reset on restart — same pattern as
// learnedNoTemperature.
const learnedMaxOut = new Map<string, number>()

// The max_tokens to actually send: the requested amount, clamped to any ceiling
// this endpoint taught us. Callers compute the request from the model's maxOut;
// this only ever lowers it.
function effectiveMaxTokens(model: string, requested: number): number {
  const cap = learnedMaxOut.get(model)
  return cap ? Math.min(requested, cap) : requested
}

// A 400 that blames max_tokens being too high → the ceiling to clamp to. Prefers a
// concrete number in the message that's below what we sent (the endpoint's stated
// max, e.g. "must be <= 16384"); falls back to halving. Returns null when it's not
// a max_tokens rejection or no smaller value can be derived (so we don't loop).
function maxTokensCapFrom(status: number, text: string, sent: number): number | null {
  if (status !== 400 || !/max[_\s-]?tokens|output tokens|maximum.*tokens/i.test(text || '')) return null
  const nums = (String(text).match(/\d{2,7}/g) || []).map(Number).filter((x) => x >= 256 && x < sent)
  if (nums.length) return Math.max(...nums)
  const half = Math.floor(sent / 2)
  return half >= 256 ? half : null
}

// POSTs to chat/completions, retrying once WITHOUT temperature if the endpoint
// rejects it (learnedNoTemperature), and once with a LOWER max_tokens if the
// endpoint rejects the requested ceiling (learnedMaxOut). `buildBody(includeTemperature)`
// returns the request body honoring both learned facts. Returns the raw Response —
// the caller reads it as a stream (streamChat) or JSON (completeWithUsage).
// `signal` (optional, the turn's AbortSignal) cancels the request and the body
// read: an aborted signal rejects with AbortError and never reaches the gateway.
async function postChat(token: string, model: string, buildBody: (withTemp: boolean) => Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const send = (withTemp: boolean) =>
    fetch(chatUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(withUsageContext(buildBody(withTemp))),
      signal,
    })
  let withTemp = sendsTemperature(model, modelById(model))
  let res = await send(withTemp)
  if (res.ok) return res
  // read the error off a clone so the original body stays intact for the caller
  // in the (common) case this isn't a rejection we can recover from
  let text = await res.clone().text().catch(() => '')
  if (withTemp && isTemperatureRejection(res.status, text)) {
    learnedNoTemperature.add(model)
    withTemp = false
    res = await send(false)
    if (res.ok) return res
    text = await res.clone().text().catch(() => '')
  }
  // max_tokens too high for this endpoint: learn its real ceiling and retry once.
  // buildBody reads effectiveMaxTokens, so re-sending picks up the clamped value.
  const sent = buildBody(withTemp).max_tokens as number
  const cap = maxTokensCapFrom(res.status, text, sent)
  if (cap != null && (learnedMaxOut.get(model) ?? Infinity) > cap) {
    learnedMaxOut.set(model, cap)
    res = await send(withTemp)
  }
  return res
}

// Stamp every gateway call so its row in system.serving.endpoint_usage carries
// usage_context['application'] = 'ai-prism' (the admin cost dashboard scopes
// spend to AI Prism) PLUS the operator's resource tags (resourceTags.js — the
// deploy-time --tag/resource_tags, incl. the built-in ai_prism_app). Verified
// live: usage_context lands in system.serving.endpoint_usage.usage_context (a
// MAP) — NOT in system.ai_gateway.usage.request_tags. Additive and safe on
// every endpoint (dashboards/ai-costs.lvdash.json reads it).
function withUsageContext(body: Record<string, unknown>): Record<string, unknown> {
  // an unattended run adds its run kind and agent ids (never an e-mail); the run's tags win over the operator's
  return { ...body, usage_context: { ...usageContext(), ...currentUsageTags() } }
}

// Cost-ledger sink (the taxímetro). index.js wires it to usage.recordUsage;
// every gateway call below reports its usage here with a `kind` (chat, intent,
// title, embedding, image, media, asset_label). Kept as an injected sink so
// llm.js stays import-free of the DB layer. Never throws. `span` (the call's
// llm.call span, server/telemetry.js) gets the token counts and the priced cost.
let usageSink: UsageSink | null = null
export function setUsageSink(fn: UsageSink | null): void {
  usageSink = fn
}
export function reportUsage(kind: string, model: string, usage: unknown, meta?: unknown, span?: Span | null): void {
  if (!usage) return
  let costUsd: unknown = null
  if (usageSink) {
    try {
      costUsd = usageSink(kind, model, usage, meta)
    } catch (e) {
      logger.warn('usage sink failed', { err: e })
    }
  }
  recordLlmUsage(span, usage, costUsd)
}

// Every gateway call runs inside an llm.call span (server/telemetry.js).
function withLlmSpan<T>(model: unknown, fn: (span: Span) => T | Promise<T>): Promise<T> {
  return withSpan('llm.call', { 'gen_ai.request.model': String(model || '') }, fn)
}

// Rough token count from text when an endpoint returns no usage at all:
// ~4 chars/token for prose, plus a flat allowance per attached image. Only a
// fallback — sondado (nov/2026), every chat endpoint streams usage.
export function estimateTokens(content: unknown): number {
  let chars = 0
  let images = 0
  const walk = (c: Payload): void => {
    if (typeof c === 'string') chars += c.length
    else if (Array.isArray(c)) for (const p of c) walk(p)
    else if (c && typeof c === 'object') {
      if (c.type === 'image_url') images++
      else if (typeof c.text === 'string') chars += c.text.length
      else if (c.content) walk(c.content)
      if (c.tool_calls) chars += JSON.stringify(c.tool_calls).length
    }
  }
  walk(content)
  return Math.ceil(chars / 4) + images * 1000
}

/** Embed one or more strings via the AI Gateway embeddings endpoint. */
export function embed(token: string, inputs: string | string[], { signal }: { signal?: AbortSignal } = {}): Promise<number[][]> {
  return withLlmSpan(EMBED_MODEL, (span) => embedRaw(token, inputs, span, signal))
}
async function embedRaw(token: string, inputs: string | string[], span: Span, signal?: AbortSignal): Promise<number[][]> {
  const arr = Array.isArray(inputs) ? inputs : [inputs]
  const res = await fetch(`${host()}/serving-endpoints/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withUsageContext({ model: EMBED_MODEL, input: arr })),
    // the turn's signal (history retrieval), when there is one
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Embeddings ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  reportUsage('embedding', EMBED_MODEL, json.usage?.prompt_tokens ? json.usage : { prompt_tokens: estimateTokens(arr) }, {
    estimated: !json.usage?.prompt_tokens,
  }, span)
  return (json.data || []).map((d: { embedding: number[] }) => d.embedding)
}

// Content can be a plain string or, for harmony-format models (gpt-oss), an
// array of parts (reasoning summaries + text). Extract just the answer text.
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const part of content) {
      if (typeof part === 'string') out += part
      else if (part?.type === 'text' && part.text) out += part.text
      // skip reasoning / summary parts
    }
    return out
  }
  return ''
}

// Pulls a reasoning-summary fragment out of a streamed delta, if present. Two
// shapes seen across gateways: a plain string field (`reasoning_content` /
// `reasoning`), or a content array with a `type:"reasoning"` part. Returns ''
// when there's nothing (the common case for models that don't expose it).
function extractReasoning(delta: Payload): string {
  if (!delta) return ''
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content
  if (typeof delta.reasoning === 'string') return delta.reasoning
  const c = delta.content
  if (Array.isArray(c)) {
    let out = ''
    for (const part of c) {
      if (part?.type === 'reasoning' && typeof part.text === 'string') out += part.text
      else if (part?.type === 'reasoning' && typeof part.reasoning === 'string') out += part.reasoning
    }
    return out
  }
  return ''
}

export function cosineSim(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Merges one streamed tool_calls delta fragment into the accumulator array,
// keyed by the provider's `index` — `arguments` arrives as incremental JSON
// string fragments that must be concatenated, not replaced.
function mergeToolCallDelta(acc: Payload[], deltas: Payload[]): void {
  for (const d of deltas) {
    const i = d.index ?? 0
    if (!acc[i]) acc[i] = { id: d.id, type: d.type || 'function', function: { name: '', arguments: '' } }
    if (d.id) acc[i].id = d.id
    if (d.function?.name) acc[i].function.name += d.function.name
    if (d.function?.arguments) acc[i].function.arguments += d.function.arguments
  }
}

// Attaches an Anthropic `cache_control` breakpoint to a message by coercing its
// content into the array-of-blocks shape the gateway needs (a plain string
// becomes one text block; an existing array gets the marker on its last block).
// Returns a NEW message object — never mutates the caller's — so re-running per
// round can't double-append. Assistant messages that carry only tool_calls
// (content null/empty) have no block to mark, so they're returned untouched.
function withCacheControl(msg: ChatMessage): ChatMessage {
  const cc = { type: 'ephemeral' }
  if (typeof msg.content === 'string' && msg.content.length) {
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: cc }] }
  }
  if (Array.isArray(msg.content) && msg.content.length) {
    const parts = msg.content as Payload[]
    const content = parts.map((b, i) =>
      i === parts.length - 1 ? { ...b, cache_control: cc } : b
    )
    return { ...msg, content }
  }
  return msg
}

// Places up to two cache breakpoints (the API allows 4) on the message list so
// a Claude turn reuses its stable prefix across tool rounds instead of
// reprocessing it: (1) the last `system` message — in this app the narration
// policy sits AFTER the history, so caching there covers system+blocksInstruction
// +history+narration, the whole per-turn prefix that's identical every round;
// (2) the last message overall — as the tool-call/result tail grows each round,
// the prior round's tail becomes a read point. Non-destructive. Only the marked
// messages change; the model sees byte-identical content. Confirmed live that
// the gateway honors this for Claude (cache_read_input_tokens > 0 on repeats).
function applyCacheControl(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.length) return messages
  let lastSystemIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'system') { lastSystemIdx = i; break }
  }
  const lastIdx = messages.length - 1
  return messages.map((m, i) => {
    if (i === lastSystemIdx || i === lastIdx) return withCacheControl(m)
    return m
  })
}

/**
 * Stream a chat completion. Yields { delta } chunks for content tokens, and a
 * final { usage, toolCalls, finishReason } object once the stream ends.
 * `toolCalls` is null unless the model asked to call one or more tools.
 */
// Some gateways are strict about `system` messages: Gemini rejects MORE THAN
// ONE ("Gemini models only support one system prompt"), and Qwen requires the
// system message to be FIRST ("System message must be at the beginning").
// This app legitimately builds several system messages, some appended AFTER the
// history (narration policy, forced language) for salience. To satisfy every
// provider, collapse them all into a SINGLE system message at index 0, joining
// their text in original order (so the last-appended directive — e.g. forced
// language — stays last WITHIN the system block, keeping its intended salience).
// Content-only system blocks are concatenated as text; array-content system
// blocks are flattened to their text. Non-system messages keep their order.
// Harmless for Claude/GPT (which tolerate the original shape); required for
// Gemini/Qwen. Runs BEFORE applyCacheControl so the merged block is what gets
// the cache breakpoint.
function systemBlockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: Payload) => (typeof b === 'string' ? b : b?.text || '')).join('')
  return ''
}
function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systems: string[] = []
  const rest: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') systems.push(systemBlockText(m.content))
    else rest.push(m)
  }
  if (systems.length <= 1) return messages // already compliant — untouched
  const merged: ChatMessage = { role: 'system', content: systems.filter(Boolean).join('\n\n') }
  return [merged, ...rest]
}

// One chunk is either { reasoning }, { delta } or the final { usage, toolCalls, finishReason }.
interface StreamChunk {
  reasoning?: string
  delta?: string
  usage?: Payload | null
  toolCalls?: Payload[] | null
  finishReason?: string | null
}

export async function* streamChat(token: string, model: string, messages: ChatMessage[], opts: ChatOpts = {}): AsyncGenerator<StreamChunk> {
  // a plain span (not made active): a generator's context can't follow its yields
  const span = startLlmSpan(model)
  let error: unknown = null
  try {
    yield* streamChatRaw(token, model, messages, opts, span)
  } catch (e) {
    error = e
    throw e
  } finally {
    // also on an early return (the consumer stopped reading)
    finishSpan(span, error)
  }
}
async function* streamChatRaw(token: string, model: string, messages: ChatMessage[], opts: ChatOpts, span: Span): AsyncGenerator<StreamChunk> {
  const info = modelById(model)
  const normalized = mergeSystemMessages(messages)
  // Prompt caching: mark the stable prefix so tool rounds within a turn reuse
  // it (big latency win on the synthesis round) — zero change to what the model
  // reads. Only for endpoints sondados as honoring cache_control. Computed once
  // (applyCacheControl mutates markers) and reused across a possible retry.
  const outMessages = info.promptCache ? applyCacheControl(normalized) : normalized
  const buildBody = (includeTemperature: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      messages: outMessages,
      max_tokens: effectiveMaxTokens(model, opts.maxTokens || info.maxOut || 8192),
      stream: true,
    }
    // temperature is sent only for models that accept it (see postChat, which
    // also drops it and retries if an endpoint rejects it at runtime).
    if (includeTemperature) body.temperature = opts.temperature ?? 0.7
    // Only endpoints flagged streamUsage accept stream_options; others (Gemini,
    // open-weights) 400 on it. Many still return usage in the final chunk.
    if (info.streamUsage) body.stream_options = { include_usage: true }
    if (opts.tools?.length) body.tools = opts.tools
    // per-turn reasoning effort: merged only for models flagged in the catalog,
    // so a default turn's body is byte-identical to before
    if (opts.reasoningEffort) Object.assign(body, reasoningParams(model, opts.reasoningEffort))
    return body
  }

  // opts.signal: a client that leaves mid-turn aborts the request and the
  // stream read below (reader.read() rejects with AbortError)
  const res = await postChat(token, model, buildBody, opts.signal)

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Endpoint ${model} returned ${res.status}: ${text.slice(0, 500)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage: Payload = null
  let toolCalls: Payload[] = []
  let finishReason: string | null = null
  let outChars = 0 // only for the no-usage fallback estimate

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let json: Payload
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      // Gemini streams an all-null usage chunk before the real one — keep the
      // last chunk that actually carries counts
      if (json.usage && json.usage.prompt_tokens != null) usage = json.usage
      const choice = json.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (choice?.delta?.tool_calls) mergeToolCallDelta(toolCalls, choice.delta.tool_calls)
      // Reasoning summary, if the endpoint streams it. Different gateways expose
      // it differently — a top-level `reasoning_content`/`reasoning` string
      // (DeepSeek-style) or a `type:"reasoning"` part inside the content array
      // (harmony). We surface it as a distinct { reasoning } chunk so the UI can
      // show "what the model is working on" during the long silent gap between a
      // tool result and the next narration token — never mixed into the answer.
      const reasoning = extractReasoning(choice?.delta)
      if (reasoning) yield { reasoning }
      const delta = extractContent(choice?.delta?.content)
      if (delta) {
        outChars += delta.length
        yield { delta }
      }
    }
  }
  if (usage) reportUsage('chat', model, usage, undefined, span)
  else {
    const out = Math.ceil((outChars + (toolCalls.length ? JSON.stringify(toolCalls).length : 0)) / 4)
    reportUsage('chat', model, { prompt_tokens: estimateTokens(outMessages), completion_tokens: out }, { estimated: true }, span)
  }
  yield { usage: usage || null, toolCalls: toolCalls.length ? toolCalls : null, finishReason }
}

/** Non-streaming completion (used for title generation). */
// Non-streaming completion returning BOTH the text and the token usage the
// endpoint reported ({ prompt_tokens, completion_tokens } or null). Auxiliary
// LLM actions (studio tweaks) use this so the UI can show their cost, mirroring
// the chat's per-message estimate. `complete()` is the text-only wrapper kept for
// callers that don't care about usage (titles, asset labels).
export function completeWithUsage(token: string, model: string, messages: ChatMessage[], opts: ChatOpts = {}): Promise<{ text: string; usage: Payload | null }> {
  return withLlmSpan(model, (span) => completeWithUsageRaw(token, model, messages, opts, span))
}
async function completeWithUsageRaw(token: string, model: string, messages: ChatMessage[], opts: ChatOpts, span: Span): Promise<{ text: string; usage: Payload | null }> {
  const buildBody = (includeTemperature: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: effectiveMaxTokens(model, opts.maxTokens || 256),
    }
    // sent only for models that accept it; postChat drops it and retries on a
    // runtime rejection so any model (e.g. Gemini) still completes.
    if (includeTemperature) body.temperature = opts.temperature ?? 0.5
    // the lowest reasoning level for the auxiliary calls: merged only for models flagged in the catalog
    if (opts.reasoningEffort) Object.assign(body, reasoningParams(model, opts.reasoningEffort))
    return body
  }
  const res = await postChat(token, model, buildBody, opts.signal)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Endpoint ${model} returned ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  const text = extractContent(json.choices?.[0]?.message?.content)
  // `usageKind` names the ledger row (title, asset_label…); plain calls are
  // 'chat', which a studio route's scope turns into 'tweak' (see usage.js)
  if (json.usage) reportUsage(opts.usageKind || 'chat', model, json.usage, undefined, span)
  else reportUsage(opts.usageKind || 'chat', model, { prompt_tokens: estimateTokens(messages), completion_tokens: Math.ceil(text.length / 4) }, { estimated: true }, span)
  return { text, usage: json.usage || null }
}

export async function complete(token: string, model: string, messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const { text } = await completeWithUsage(token, model, messages, opts)
  return text
}

// Pulls every generated image out of a chat/completions message `content`.
// Image endpoints (gemini-*-image) return content as an array of parts, with
// the image as {type:"image_url", image_url:{url:"data:image/png;base64,..."}}
// — the exact shape sondado ao vivo. `extractContent` above deliberately skips
// these (it wants the answer TEXT); this is the complementary reader for the
// image path. Returns an array of data-URL strings (usually one).
function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const urls: string[] = []
  for (const part of content as Payload[]) {
    const url = part?.image_url?.url
    if (part?.type === 'image_url' && typeof url === 'string' && url.startsWith('data:image/')) {
      urls.push(url)
    }
  }
  return urls
}

/**
 * Generate (or edit) an image via an image-generation serving endpoint. These
 * endpoints speak the OpenAI-compatible chat/completions protocol — a normal
 * chat request whose model happens to render images — so this reuses chatUrl()
 * and the usage-context stamp. `baseImages` (data-URLs) are attached as input
 * image parts for editing/img2img; omit them for pure text→image.
 *
 * Returns { dataUrls: string[], usage } — dataUrls are `data:image/png;base64,…`
 * strings ready to persist. Throws on a non-200 or when the endpoint returned
 * no image (so the caller can surface an honest error to the model/user).
 */
interface ImageInput {
  prompt?: string
  baseImages?: unknown[]
  signal?: AbortSignal
}
export function generateImage(token: string, model: string, input: ImageInput = {}): Promise<{ dataUrls: string[]; usage: Payload | null }> {
  return withLlmSpan(model, (span) => generateImageRaw(token, model, input, span))
}

// error_code of a gateway error body, or the first missing-endpoint code mentioned in the text
function endpointErrorCode(text: string): string | undefined {
  try {
    const code = JSON.parse(text)?.error_code
    if (typeof code === 'string' && code) return code
  } catch {
    // not JSON
  }
  return ENDPOINT_MISSING_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text))
}

/** An image call that failed with an HTTP status; `code` is the gateway's error code when it sent one. */
export interface ImageCallError extends Error {
  status?: number
  code?: string
  provider?: string
}

async function generateImageRaw(token: string, model: string, { prompt, baseImages = [], signal }: ImageInput = {}, span: Span): Promise<{ dataUrls: string[]; usage: Payload | null }> {
  // an id derived from a models.json `{ provider, model }` entry goes to the Gemini-native route of the
  // UC Model Provider Service, with the same return shape
  const providerRef = parseProviderImageModelId(model)
  if (providerRef) return generateProviderImage(token, providerRef, { prompt, baseImages, signal }, span)
  if (!isServingEndpointName(model)) throw new Error(`Image endpoint name is not valid: ${JSON.stringify(String(model)).slice(0, 80)}`)
  const info = modelById(model)
  const userContent: Record<string, unknown>[] = [{ type: 'text', text: prompt || '' }]
  for (const b of baseImages) {
    if (typeof b === 'string' && b.startsWith('data:image/')) {
      userContent.push({ type: 'image_url', image_url: { url: b } })
    }
  }
  const body = {
    model,
    // when there are no base images, send the prompt as a plain string — the
    // simplest shape these endpoints accept; with base images we must use the
    // parts array to carry them.
    messages: [{ role: 'user', content: baseImages.length ? userContent : (prompt || '') }],
    max_tokens: info.modality === 'image' ? info.maxOut : IMAGE_MAX_OUT,
  }
  const res = await fetch(chatUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withUsageContext(body)),
    // the turn's signal: a cancelled turn generates (and stores) no image
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const error: ImageCallError = new Error(`Image endpoint ${model} returned ${res.status}: ${text.slice(0, 300)}`)
    error.status = res.status
    error.code = endpointErrorCode(text)
    throw error
  }
  const json = await res.json()
  // billed even when the model then declines to return an image
  reportUsage('image', model, json.usage, undefined, span)
  const dataUrls = extractImageUrls(json.choices?.[0]?.message?.content)
  if (!dataUrls.length) {
    // The model may refuse or return only text (e.g. a safety decline) — pass
    // that text up so the caller can relay the actual reason, not a blank fail.
    const text = extractContent(json.choices?.[0]?.message?.content)
    throw new Error(text ? `Model returned no image: ${text.slice(0, 200)}` : 'Model returned no image.')
  }
  return { dataUrls, usage: json.usage || null }
}

// Header that picks the UC Model Provider Service on a native AI Gateway call.
export const MODEL_PROVIDER_SERVICE_HEADER = 'Databricks-Model-Provider-Service'

/**
 * The native Gemini request (`v1beta generateContent`) for the target `model` of the Model Provider
 * Service `provider`. Base images (base64 data URLs) go in as `inlineData` parts after the text, for
 * edit/img2img. The body is the provider's own and takes no `usage_context`: on the Unity Gateway
 * routes the cost tags travel in the Databricks-Ai-Gateway-Request-Tags header (the same tags the
 * serving endpoints take as usage_context), which lands in system.ai_gateway.usage.request_tags.
 */
export function buildProviderImageRequest(
  token: string,
  { provider, model }: { provider: string; model: string },
  { prompt, baseImages = [] }: { prompt?: string; baseImages?: unknown[] } = {}
): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  const parts: Record<string, unknown>[] = [{ text: prompt || '' }]
  for (const b of baseImages) {
    const m = typeof b === 'string' ? /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(b) : null
    if (m) parts.push({ inlineData: { mimeType: m[1]!.toLowerCase(), data: m[2] } })
  }
  return {
    url: `${host()}/ai-gateway/gemini/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        [MODEL_PROVIDER_SERVICE_HEADER]: provider,
        [AI_GATEWAY_REQUEST_TAGS_HEADER]: aiGatewayRequestTags(currentUsageTags()),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      }),
    },
  }
}

/**
 * Image and text of a `generateContent` response. The last image that is not a "thought" counts
 * (`thought: true` marks reasoning drafts, which the Pro model returns next to the final image); the
 * text joins the text parts that are not thoughts.
 */
export function parseProviderImageResponse(json: Payload): { dataUrls: string[]; text: string } {
  let image: string | null = null
  let text = ''
  for (const candidate of json?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part?.thought) continue
      const inline = part?.inlineData
      if (inline && typeof inline.data === 'string' && inline.data && /^image\//i.test(inline.mimeType || '')) {
        image = `data:${inline.mimeType};base64,${inline.data}`
      } else if (typeof part?.text === 'string') {
        text += part.text
      }
    }
  }
  return { dataUrls: image ? [image] : [], text }
}

/**
 * Gemini's `usageMetadata` in the usage shape of the image models (prompt_tokens, completion_tokens,
 * image_output_tokens, total_tokens): output tokens of the IMAGE modality become image_output_tokens;
 * the rest of the output and the thinking become completion_tokens.
 */
export function providerImageUsage(meta: Payload): Payload | null {
  if (!meta || typeof meta !== 'object') return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const image = ((meta.candidatesTokensDetails as Payload[]) || [])
    .filter((d) => String(d?.modality || '').toUpperCase() === 'IMAGE')
    .reduce((sum: number, d) => sum + n(d.tokenCount), 0)
  const output = n(meta.candidatesTokenCount)
  return {
    prompt_tokens: n(meta.promptTokenCount),
    completion_tokens: Math.max(0, output - image) + n(meta.thoughtsTokenCount),
    image_output_tokens: image,
    total_tokens: n(meta.totalTokenCount),
  }
}

// error_code of a gateway error or the `error.status` of a Gemini one
function providerErrorCode(text: string): string | undefined {
  try {
    const body = JSON.parse(text)
    const code = body?.error_code || body?.error?.status
    if (typeof code === 'string' && code) return code
  } catch {
    // not JSON
  }
  return endpointErrorCode(text)
}

// Generates (or edits) an image on a UC Model Provider Service target, with the user's OBO token. An
// HTTP error leaves with `status`, `code` and `provider`; a 404 with no known code becomes NOT_FOUND
// (the provider or the target does not exist).
async function generateProviderImage(
  token: string,
  ref: { provider: string; model: string },
  { prompt, baseImages = [], signal }: ImageInput,
  span: Span
): Promise<{ dataUrls: string[]; usage: Payload | null }> {
  const { url, init } = buildProviderImageRequest(token, ref, { prompt, baseImages })
  // the turn's signal: a cancelled turn generates (and stores) no image
  const res = await fetch(url, signal ? { ...init, signal } : init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const error: ImageCallError = new Error(`Image model ${ref.model} (${ref.provider}) returned ${res.status}: ${text.slice(0, 300)}`)
    error.status = res.status
    error.code = providerErrorCode(text) || (res.status === 404 ? 'NOT_FOUND' : undefined)
    error.provider = ref.provider
    throw error
  }
  const json = await res.json()
  const usage = providerImageUsage(json.usageMetadata)
  // billed even when the model then declines to return an image
  reportUsage('image', providerImageModelId(ref.provider, ref.model), usage, undefined, span)
  const { dataUrls, text } = parseProviderImageResponse(json)
  if (!dataUrls.length) {
    const reason = text || json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || ''
    throw new Error(reason ? `Model returned no image: ${String(reason).slice(0, 200)}` : 'Model returned no image.')
  }
  return { dataUrls, usage }
}

/**
 * The model that labels the assets of a template import: the one picked in the chat when it is in the
 * enabled catalog and takes images, else the first model of `enabled` (catalog order) that does, else
 * null (no labels). A stale selection (disabled or removed since) is never used.
 */
export function pickVisionModel(selected: string | null | undefined, enabled: { id: string; vision?: boolean }[] = []): string | null {
  if (selected && enabled.some((m) => m.id === selected) && modelById(selected).vision) return selected
  return enabled.find((m) => modelById(m.id).vision)?.id || null
}

/**
 * Semantic labeling of mined design-system assets (gap-analysis "next step"):
 * a mined icon arrives as "Gráfico 37"/"" — useless for the model to decide
 * whether it fits a card. This sends the (already thumbnail-sized) images to
 * the vision-capable `model` the caller picked (see pickVisionModel) and returns
 * { [assetId]: "rótulo curto" }. Labels only steer asset CHOICE (iconRef/imageRef
 * in server/blocks.js), they never enter slide content. Diagrams have no raster —
 * their box texts are sent instead. Best-effort: on any failure the caller keeps
 * the original labels.
 */
export async function labelDesignAssets(token: string, model: string, assets: Payload[] = [], diagrams: Payload[] = []): Promise<Record<string, string>> {
  const content: Record<string, unknown>[] = [
    {
      type: 'text',
      text:
        'Você rotula assets de um design system corporativo para uso por outro modelo. ' +
        'Para cada item abaixo, gere um rótulo curto (2 a 6 palavras, pt-BR, sem ponto final) que descreva ' +
        'O QUE a imagem representa conceitualmente (ex.: "cadeado — segurança", "gráfico de barras crescente", ' +
        '"logo da empresa", "foto de datacenter"). Responda SOMENTE com JSON válido no formato ' +
        '{"labels":{"<id>":"<rótulo>", ...}} cobrindo todos os ids.',
    },
  ]
  for (const a of assets.slice(0, 40)) {
    content.push({ type: 'text', text: `id: ${a.id} (${a.kind || 'icon'})` })
    content.push({ type: 'image_url', image_url: { url: a.dataUrl } })
  }
  for (const d of diagrams.slice(0, 8)) {
    content.push({
      type: 'text',
      text: `id: ${d.id} (diagrama vetorial; textos das formas: ${(d.texts || []).slice(0, 20).join(' | ').slice(0, 500)})`,
    })
  }
  const out = await complete(token, model, [{ role: 'user', content }], {
    maxTokens: auxMaxTokens(model, 1500),
    temperature: 0.2,
    reasoningEffort: AUX_REASONING,
    usageKind: 'asset_label',
  })
  const match = out.match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const parsed = JSON.parse(match[0])
    const labels: Record<string, string> = {}
    for (const [id, label] of Object.entries(parsed.labels || {})) {
      if (typeof label === 'string' && label.trim()) labels[id] = label.trim().slice(0, 80)
    }
    return labels
  } catch {
    return {}
  }
}

/**
 * Generate a short session title: exactly one emoji + a few words, in the
 * user's own language, with the conversation's own `model` (resolveAuxModel) at
 * the lowest reasoning level. Falls back to a trimmed prompt if the model misbehaves.
 */
// `signal` (the turn's): a client that leaves during the tail aborts the request;
// the fallback title is then returned and the caller writes nothing.
export async function generateTitle(token: string, firstUserMessage: string, assistantAnswer = '', { signal, model }: { signal?: AbortSignal; model?: string | null } = {}): Promise<string> {
  const titleModel = resolveAuxModel(model)
  const snippet = (firstUserMessage || '').slice(0, 1500)
  const answerSnippet = (assistantAnswer || '').slice(0, 800)
  try {
    const out = await complete(
      token,
      titleModel,
      [
        {
          role: 'system',
          content:
            'You title chat conversations for a sidebar list. ' +
            'Reply with EXACTLY one emoji, a space, and a specific 3 to 6 word title. ' +
            'Name the concrete subject — products, datasets, metrics, technologies, people, places — ' +
            'so this conversation is distinguishable from others on a similar theme. ' +
            'Never use generic filler like "Ajuda com", "Dúvida sobre", "Pergunta", "Conversa sobre". ' +
            "Write the title in the same language as the user's message. " +
            'No quotes, no trailing punctuation, no extra words.',
        },
        {
          role: 'user',
          content: answerSnippet
            ? `Mensagem do usuário:\n${snippet}\n\nInício da resposta do assistente:\n${answerSnippet}`
            : snippet,
        },
      ],
      { maxTokens: auxMaxTokens(titleModel, 40), temperature: 0.6, reasoningEffort: AUX_REASONING, usageKind: 'title', signal }
    )
    const clean = out.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\n.*$/s, '').slice(0, 60)
    if (clean) return clean
  } catch {
    // fall through to heuristic
  }
  const fallback = snippet.replace(/\s+/g, ' ').trim().slice(0, 40)
  return `💬 ${fallback || 'Nova conversa'}`
}

/**
 * First balanced `{...}` in a model reply that parses as JSON, ignoring any prose or code fence
 * around it. Returns the parsed object or null.
 */
export function firstJsonObject(text: unknown): Record<string, unknown> | null {
  const s = String(text || '')
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < s.length; i++) {
      const ch = s[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try {
          const parsed = JSON.parse(s.slice(start, i + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch {
          // not JSON — try the next '{'
        }
        break
      }
    }
  }
  return null
}

/**
 * Per-turn INTENT CLASSIFIER. The regex router (detectCapabilities in
 * blocks.js) is fast and free but bag-of-words: it can't tell a deck briefing
 * that NARRATES "geração de slides, planilhas, documentos" (all product
 * features — one artifact: a deck) from a genuine multi-artifact request, and
 * it fired Genie One on a deck that never touched data. That's a SEMANTIC call,
 * so it runs on the turn's own `model` (resolveAuxModel) at the lowest reasoning
 * level and its (tiny) cost folds into the turn's estimate. The caller decides
 * WHEN to spend this (see the hybrid gating in turn.ts — trivial chat and
 * obvious tweaks skip it); this function just answers "what does the user
 * actually want produced THIS turn?".
 *
 * Returns { intents: {deck,spreadsheet,image,document,data} booleans, model, usage } or
 * null on any failure/timeout, or when the reply carries no boolean flag, so the
 * caller falls back to the regex result.
 */
interface ClassifyOpts {
  timeoutMs?: number
  signal?: AbortSignal
  model?: string | null
}
interface IntentResult {
  intents: { deck: boolean; spreadsheet: boolean; image: boolean; document: boolean; data: boolean }
  /** the model that answered (the conversation's), for the cost line */
  model: string
  usage: Payload | null
}
export async function classifyIntent(token: string, userText: string, { timeoutMs = 4000, signal, model }: ClassifyOpts = {}): Promise<IntentResult | null> {
  const text = String(userText || '').slice(0, 6000)
  if (!text.trim()) return null
  const intentModel = resolveAuxModel(model)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are an intent router for a multimodel AI workspace. Decide what the user wants ' +
          'PRODUCED in THIS message, and whether answering needs their OWN company data.\n' +
          'Return ONLY the JSON object and NOTHING before or after it (no prose, no code fence): ' +
          '{"deck":bool,"spreadsheet":bool,"image":bool,"document":bool,"data":bool}.\n' +
          '- deck: a slide deck / presentation / pitch.\n' +
          '- spreadsheet: an .xlsx / sheet / financial model / budget.\n' +
          '- image: a generated picture / illustration / logo / icon as an image.\n' +
          '- document: a written text doc (report, article, letter, contract, memo).\n' +
          '- data: the request needs the user\'s OWN workspace/company data — querying their tables, ' +
          'metrics, revenue, customers, etc. via a data tool. TRUE only when the answer requires ' +
          'pulling/analyzing their real internal data, NOT when business terms merely appear as ' +
          'narrative or as the SUBJECT of a deck/document.\n' +
          'CRITICAL: set a flag TRUE only for what the user asks to CREATE now. If they ask for a deck ' +
          'and the deck\'s CONTENT happens to describe spreadsheets, documents, images or business ' +
          'metrics, those are NOT separate requests — only "deck" is true. Multiple flags are true ' +
          'ONLY when the user explicitly asks for multiple artifacts.',
      },
      { role: 'user', content: text },
    ]
    // postChat drops a temperature the model rejects and retries; the reply is read for its first JSON
    // object (a reasoning model may wrap it in prose), so no `stop` sequence is sent
    const { text: out, usage } = await completeWithUsage(token, intentModel, messages, {
      maxTokens: auxMaxTokens(intentModel, 60),
      temperature: 0,
      reasoningEffort: AUX_REASONING,
      usageKind: 'intent',
      // its own timeout, or the turn's signal (the client left)
      signal: signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal,
    })
    const parsed = firstJsonObject(out)
    const keys = ['deck', 'spreadsheet', 'image', 'document', 'data'] as const
    if (!parsed || !keys.some((k) => typeof parsed[k] === 'boolean')) return null
    const b = (v: unknown): boolean => v === true
    return {
      intents: { deck: b(parsed.deck), spreadsheet: b(parsed.spreadsheet), image: b(parsed.image), document: b(parsed.document), data: b(parsed.data) },
      model: intentModel,
      usage: usage || null,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
