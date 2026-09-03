// Catalog of AI Gateway models surfaced in the UI. `in`/`out` are approximate
// public list prices (USD per 1M tokens) used only for the cost-estimate flourish.
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
export const MODELS = [
  { id: 'databricks-claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic', blurb: 'Equilibrado e rápido — ótimo padrão para agentes', in: 2, out: 10, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true },
  { id: 'databricks-claude-opus-5', label: 'Claude Opus 5', provider: 'Anthropic', blurb: 'Máxima capacidade para agentes, código e análise longa', in: 5, out: 25, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true },
  { id: 'databricks-claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic', blurb: 'Família Claude 5, geração criativa e ágil', in: 10, out: 50, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, promptCache: true },
  { id: 'databricks-claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic', blurb: 'Rápido e econômico', in: 1, out: 5, vision: true, streamUsage: true, tools: true, maxOut: 32768, promptCache: true },
  // GPT-5.6 family — three tiers of the same generation (sondado ao vivo: os três
  // rejeitam temperature custom → noTemperature; aceitam max_tokens ≥32768).
  // Preços aproximados por tier (flourish de estimativa; gasto real vem das
  // system tables). Blurbs intencionais para diferenciar os três na UI.
  { id: 'databricks-gpt-5-6-luna', label: 'GPT-5.6 Luna', provider: 'OpenAI', blurb: 'O mais rápido e econômico da família 5.6', in: 1, out: 6, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gpt-5-6-terra', label: 'GPT-5.6 Terra', provider: 'OpenAI', blurb: 'Equilíbrio de custo e capacidade para o dia a dia', in: 2.5, out: 15, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gpt-5-6-sol', label: 'GPT-5.6 Sol', provider: 'OpenAI', blurb: 'O topo da família: agentes, código e raciocínio longo', in: 5, out: 30, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gemini-3-6-flash', label: 'Gemini 3.6 Flash', provider: 'Google', blurb: 'Multimodal, rápido e eficiente para alto volume', in: 1.875, out: 9.375, vision: true, streamUsage: false, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-kimi-k3', label: 'Kimi K3', provider: 'Moonshot AI', blurb: 'Contexto longo, multimodal e forte em trabalho agentivo', in: 0.5, out: 2.5, vision: true, streamUsage: false, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-llama-4-maverick', label: 'Llama 4 Maverick', provider: 'Meta', blurb: 'Pesos abertos, modelo geral robusto', in: 0.5, out: 1.5, vision: false, streamUsage: false, tools: true, maxOut: 8192 },
  { id: 'databricks-glm-5-2', label: 'GLM-5.2', provider: 'Zhipu AI', blurb: 'Aberto, forte em raciocínio e código', in: 1.4, out: 4.4, vision: false, streamUsage: true, tools: true, maxOut: 32768 },
  { id: 'databricks-qwen35-122b-a10b', label: 'Qwen3.5 122B', provider: 'Alibaba', blurb: 'Aberto e eficiente, raciocínio MoE', in: 0.22, out: 2.2, vision: false, streamUsage: true, tools: true, maxOut: 8192 },
  // Image-generation endpoints. Sondado ao vivo (jul/2026, e2-demo-field-eng):
  // servem por `task=llm/v1/chat` — NÃO há API de imagem separada. A resposta
  // traz `choices[0].message.content` como um array [{type:"image_url",
  // image_url:{url:"data:image/png;base64,..."}}] e `usage.image_output_tokens`.
  // Aceitam imagem no input (edição/img2img) e `usage_context` (custos). São
  // chamados por generateImage(), nunca pelo streamChat do chat comum — por isso
  // `modality:'image'` os mantém FORA do picker de chat (ver buildUserModels).
  // noTemperature: conservador (nunca causa 400); vision: aceitam image_url no input.
  { id: 'databricks-gemini-3-1-flash-image', label: 'Nano Banana 2', provider: 'Google', blurb: 'Gemini 3.1 Flash — geração de imagem rápida', modality: 'image', vision: true, noTemperature: true, tools: false, maxOut: 8192 },
]

// Modality helpers: an endpoint without `modality` is a chat model (the
// overwhelming default). Only image-generation endpoints carry modality:'image'.
export function isImageModel(id) {
  return modelById(id)?.modality === 'image'
}
export function imageModels() {
  return MODELS.filter((m) => m.modality === 'image')
}
// Default image model when the user hasn't chosen one (mirrors MODELS[0] for chat).
export const DEFAULT_IMAGE_MODEL = 'databricks-gemini-3-1-flash-image'

// A fast, non-reasoning model: reasoning models can burn the whole token
// budget on hidden thinking and return empty content for tiny outputs.
const FAST_TITLE_MODEL = 'databricks-claude-haiku-4-5'
// Same class of model for the per-turn intent classifier (see classifyIntent).
const FAST_INTENT_MODEL = 'databricks-claude-haiku-4-5'
export const INTENT_MODEL = FAST_INTENT_MODEL

// Multilingual embedding model — far better Portuguese discrimination than the
// English-tuned gte/bge endpoints.
const EMBED_MODEL = 'databricks-qwen3-embedding-0-6b'

// Conservative flags for an endpoint that isn't in the curated MODELS list
// (e.g. an admin enabled a newly-discovered gateway endpoint). These never
// cause a 400: no custom temperature, no stream_options, modest max_tokens.
// Suboptimal at worst — the cure is to curate the endpoint, one line above.
function conservativeModel(id) {
  return { id, label: id, provider: 'Outros', vision: false, streamUsage: false, noTemperature: true, tools: true, maxOut: 8192, promptCache: false }
}

export function modelById(id) {
  const found = MODELS.find((m) => m.id === id)
  if (found) return found
  // A non-empty id that isn't curated is treated as a valid-but-unknown
  // endpoint with safe defaults; only a missing id falls back to the default.
  return id ? conservativeModel(id) : MODELS[0]
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
const learnedNoTemperature = new Set()

// Whether to send a custom temperature for this model right now.
function sendsTemperature(model, info) {
  return !info.noTemperature && !learnedNoTemperature.has(model)
}

// A 400 whose body blames `temperature` — the cue to drop it and retry.
function isTemperatureRejection(status, text) {
  return status === 400 && /temperature/i.test(text || '')
}

// POSTs to chat/completions, retrying once WITHOUT temperature if the endpoint
// rejects it (see learnedNoTemperature). `buildBody(includeTemperature)` returns
// the request body honoring the flag. Returns the raw Response — the caller
// reads it as a stream (streamChat) or JSON (completeWithUsage).
async function postChat(token, model, buildBody) {
  const send = (withTemp) =>
    fetch(chatUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(withUsageContext(buildBody(withTemp))),
    })
  const withTemp = sendsTemperature(model, modelById(model))
  let res = await send(withTemp)
  if (!res.ok && withTemp) {
    // read the error off a clone so the original body stays intact for the
    // caller in the (common) case this isn't a temperature rejection
    const text = await res.clone().text().catch(() => '')
    if (isTemperatureRejection(res.status, text)) {
      learnedNoTemperature.add(model)
      res = await send(false)
    }
  }
  return res
}

// Stamp every gateway call so its row in system.serving.endpoint_usage carries
// usage_context['application'] = 'ai-prism'. This is what lets the admin cost
// dashboard scope spend to AI Prism (vs. the same users' other serving traffic
// in a shared workspace). Verified live: usage_context lands in
// system.serving.endpoint_usage.usage_context (a MAP) — NOT in
// system.ai_gateway.usage.request_tags. The tag is additive and safe on every
// endpoint (the dashboard query in dashboards/ai-costs.lvdash.json reads it).
const USAGE_CONTEXT = { application: 'ai-prism' }
function withUsageContext(body) {
  return { ...body, usage_context: USAGE_CONTEXT }
}

/** Embed one or more strings via the AI Gateway embeddings endpoint. */
export async function embed(token, inputs) {
  const arr = Array.isArray(inputs) ? inputs : [inputs]
  const res = await fetch(`${host()}/serving-endpoints/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withUsageContext({ model: EMBED_MODEL, input: arr })),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Embeddings ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  return (json.data || []).map((d) => d.embedding)
}

// Content can be a plain string or, for harmony-format models (gpt-oss), an
// array of parts (reasoning summaries + text). Extract just the answer text.
function extractContent(content) {
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
function extractReasoning(delta) {
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

export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Merges one streamed tool_calls delta fragment into the accumulator array,
// keyed by the provider's `index` — `arguments` arrives as incremental JSON
// string fragments that must be concatenated, not replaced.
function mergeToolCallDelta(acc, deltas) {
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
function withCacheControl(msg) {
  const cc = { type: 'ephemeral' }
  if (typeof msg.content === 'string' && msg.content.length) {
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: cc }] }
  }
  if (Array.isArray(msg.content) && msg.content.length) {
    const content = msg.content.map((b, i) =>
      i === msg.content.length - 1 ? { ...b, cache_control: cc } : b
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
function applyCacheControl(messages) {
  if (!messages.length) return messages
  let lastSystemIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') { lastSystemIdx = i; break }
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
function systemBlockText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('')
  return ''
}
function mergeSystemMessages(messages) {
  const systems = []
  const rest = []
  for (const m of messages) {
    if (m.role === 'system') systems.push(systemBlockText(m.content))
    else rest.push(m)
  }
  if (systems.length <= 1) return messages // already compliant — untouched
  const merged = { role: 'system', content: systems.filter(Boolean).join('\n\n') }
  return [merged, ...rest]
}

export async function* streamChat(token, model, messages, opts = {}) {
  const info = modelById(model)
  const normalized = mergeSystemMessages(messages)
  // Prompt caching: mark the stable prefix so tool rounds within a turn reuse
  // it (big latency win on the synthesis round) — zero change to what the model
  // reads. Only for endpoints sondados as honoring cache_control. Computed once
  // (applyCacheControl mutates markers) and reused across a possible retry.
  const outMessages = info.promptCache ? applyCacheControl(normalized) : normalized
  const buildBody = (includeTemperature) => {
    const body = {
      model,
      messages: outMessages,
      max_tokens: opts.maxTokens || info.maxOut || 8192,
      stream: true,
    }
    // temperature is sent only for models that accept it (see postChat, which
    // also drops it and retries if an endpoint rejects it at runtime).
    if (includeTemperature) body.temperature = opts.temperature ?? 0.7
    // Only endpoints flagged streamUsage accept stream_options; others (Gemini,
    // open-weights) 400 on it. Many still return usage in the final chunk.
    if (info.streamUsage) body.stream_options = { include_usage: true }
    if (opts.tools?.length) body.tools = opts.tools
    return body
  }

  const res = await postChat(token, model, buildBody)

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Endpoint ${model} returned ${res.status}: ${text.slice(0, 500)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  let toolCalls = []
  let finishReason = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let json
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      if (json.usage) usage = json.usage
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
      if (delta) yield { delta }
    }
  }
  yield { usage: usage || null, toolCalls: toolCalls.length ? toolCalls : null, finishReason }
}

/** Non-streaming completion (used for title generation). */
// Non-streaming completion returning BOTH the text and the token usage the
// endpoint reported ({ prompt_tokens, completion_tokens } or null). Auxiliary
// LLM actions (studio tweaks) use this so the UI can show their cost, mirroring
// the chat's per-message estimate. `complete()` is the text-only wrapper kept for
// callers that don't care about usage (titles, asset labels).
export async function completeWithUsage(token, model, messages, opts = {}) {
  const buildBody = (includeTemperature) => {
    const body = {
      model,
      messages,
      max_tokens: opts.maxTokens || 256,
    }
    // sent only for models that accept it; postChat drops it and retries on a
    // runtime rejection so any model (e.g. Gemini) still completes.
    if (includeTemperature) body.temperature = opts.temperature ?? 0.5
    return body
  }
  const res = await postChat(token, model, buildBody)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Endpoint ${model} returned ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  return {
    text: extractContent(json.choices?.[0]?.message?.content),
    usage: json.usage || null,
  }
}

export async function complete(token, model, messages, opts = {}) {
  const { text } = await completeWithUsage(token, model, messages, opts)
  return text
}

// Pulls every generated image out of a chat/completions message `content`.
// Image endpoints (gemini-*-image) return content as an array of parts, with
// the image as {type:"image_url", image_url:{url:"data:image/png;base64,..."}}
// — the exact shape sondado ao vivo. `extractContent` above deliberately skips
// these (it wants the answer TEXT); this is the complementary reader for the
// image path. Returns an array of data-URL strings (usually one).
function extractImageUrls(content) {
  if (!Array.isArray(content)) return []
  const urls = []
  for (const part of content) {
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
export async function generateImage(token, model, { prompt, baseImages = [] } = {}) {
  const info = modelById(model)
  const userContent = [{ type: 'text', text: prompt || '' }]
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
    max_tokens: info.maxOut || 8192,
  }
  const res = await fetch(chatUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withUsageContext(body)),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Image endpoint ${model} returned ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  const dataUrls = extractImageUrls(json.choices?.[0]?.message?.content)
  if (!dataUrls.length) {
    // The model may refuse or return only text (e.g. a safety decline) — pass
    // that text up so the caller can relay the actual reason, not a blank fail.
    const text = extractContent(json.choices?.[0]?.message?.content)
    throw new Error(text ? `Model returned no image: ${text.slice(0, 200)}` : 'Model returned no image.')
  }
  return { dataUrls, usage: json.usage || null }
}

// Vision model used to label mined design-system assets at import time —
// fast/cheap and vision-capable; labels only steer asset CHOICE (iconRef/
// imageRef in server/blocks.js), they never enter slide content.
const ASSET_LABEL_MODEL = 'databricks-claude-haiku-4-5'

/**
 * Semantic labeling of mined design-system assets (gap-analysis "next step"):
 * a mined icon arrives as "Gráfico 37"/"" — useless for the model to decide
 * whether it fits a card. This sends the (already thumbnail-sized) images to
 * a vision model and returns { [assetId]: "rótulo curto" }. Diagrams have no
 * raster — their box texts are sent instead. Best-effort: on any failure the
 * caller keeps the original labels.
 */
export async function labelDesignAssets(token, assets = [], diagrams = []) {
  const content = [
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
  const out = await complete(token, ASSET_LABEL_MODEL, [{ role: 'user', content }], { maxTokens: 1500, temperature: 0.2 })
  const match = out.match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const parsed = JSON.parse(match[0])
    const labels = {}
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
 * user's own language. Falls back to a trimmed prompt if the model misbehaves.
 */
export async function generateTitle(token, firstUserMessage, assistantAnswer = '') {
  const snippet = (firstUserMessage || '').slice(0, 1500)
  const answerSnippet = (assistantAnswer || '').slice(0, 800)
  try {
    const out = await complete(
      token,
      FAST_TITLE_MODEL,
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
      { maxTokens: 40, temperature: 0.6 }
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
 * Per-turn INTENT CLASSIFIER. The regex router (detectCapabilities in
 * blocks.js) is fast and free but bag-of-words: it can't tell a deck briefing
 * that NARRATES "geração de slides, planilhas, documentos" (all product
 * features — one artifact: a deck) from a genuine multi-artifact request, and
 * it fired Genie One on a deck that never touched data. That's a SEMANTIC call,
 * so we make it with a cheap, fast model and fold its (tiny) cost into the
 * turn's estimate. The caller decides WHEN to spend this (see the hybrid gating
 * in index.js — trivial chat and obvious tweaks skip it); this function just
 * answers "what does the user actually want produced THIS turn?".
 *
 * Returns { intents: {deck,spreadsheet,image,document,data} booleans, usage } or
 * null on any failure/timeout so the caller falls back to the regex result.
 */
export async function classifyIntent(token, userText, { timeoutMs = 4000 } = {}) {
  const text = String(userText || '').slice(0, 6000)
  if (!text.trim()) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const body = {
      model: FAST_INTENT_MODEL,
      max_tokens: 60,
      temperature: 0,
      // stop as soon as the JSON object closes — without this the model emits
      // the JSON and then keeps going (answering the question, burning tokens
      // and hitting the length cap). The closing brace is the JSON's last char.
      stop: ['}'],
      messages: [
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
      ],
    }
    const res = await fetch(chatUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(withUsageContext(body)),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = await res.json()
    let out = extractContent(json.choices?.[0]?.message?.content) || ''
    // the `stop: ['}']` sequence is stripped from the output, so re-add the
    // closing brace(s) the model didn't get to emit. Grab from the first '{'.
    const open = out.indexOf('{')
    if (open === -1) return null
    out = out.slice(open)
    if (!out.trimEnd().endsWith('}')) out = out + '}'
    const parsed = JSON.parse(out)
    const b = (v) => v === true
    return {
      intents: {
        deck: b(parsed.deck),
        spreadsheet: b(parsed.spreadsheet),
        image: b(parsed.image),
        document: b(parsed.document),
        data: b(parsed.data),
      },
      usage: json.usage || null,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
