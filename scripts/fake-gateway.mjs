#!/usr/bin/env node
// Fake Databricks AI Gateway for tests, CI smoke and local runs without a
// workspace. It speaks the OpenAI-compatible shapes server/llm.js reads
// (contract-tested in tests/fakeGateway.test.mjs):
//
//   POST /serving-endpoints/chat/completions
//     stream:true  → SSE `data: {chunk}` lines: delta.role, `reasoning_content`
//                    (DeepSeek-style), delta.content pieces, or indexed
//                    delta.tool_calls with fragmented `function.arguments` and
//                    finish_reason "tool_calls"; `usage` (with the prompt-cache
//                    counters) on the first and on the finish_reason chunk;
//                    `data: [DONE]`. Shapes pinned to a real gateway recording:
//                    tests/fixtures/gateway-shapes.live.json.
//     stream:false → { choices[0].message.content, usage } (titles, intent
//                    classifier, studio tweaks).
//   POST /serving-endpoints/embeddings → { data[].embedding (1024 floats), usage }
//   POST /ai-gateway/typesafe/v1/systemone → System One (OpenJev): { model, answers: { <question>: { noul } }, usage }
//                    deck/document/spreadsheet answer 0.97 when the message matches the same
//                    keywords as the Haiku intent router above, every other question 0.02;
//                    "[fake:openjev:error]" in the message → HTTP 422
//   GET  /api/2.0/serving-endpoints     → chat endpoints (model discovery)
//   GET  /api/2.0/preview/scim/v2/Me    → a user without groups
//   anything else                       → 404 { error_code: "ENDPOINT_NOT_FOUND" }
//
// Behaviour is chosen from the LAST user message, so a test or the smoke can
// ask for a scenario through the prompt it already sends:
//   - asks for a document ("documento"/"document"/"relatório"/"report")
//       → one sentence + a valid ```prism-block``` of type "document"
//       (title taken from `título "X"` / `title "X"` when present)
//   - "[fake:tool]" with `tools` in the request and no tool result yet
//       → a tool call to the first tool, arguments {"question":"fake"}
//   - "[fake:tool:<name>]" with a tool of that name in the request and no tool
//       result yet → a call to THAT tool; its arguments are "[fake:args:<base64url
//       JSON>]" when the prompt carries one, else a canned set per artifact tool
//       (create_deck / create_spreadsheet / create_document), else {}. A tool the
//       request does not offer → the text "fake: tool <name> not offered"
//   - "[fake:error]" → HTTP 503 with a gateway-style error body
//   - the memory extractor (server/memory.js, non-streaming) answers the JSON
//       of "[fake:memory:<base64url JSON>]" when the message carries one, else
//       {"memories":[]}
//   - "[fake:deck]" → a ```prism-block``` of type "deck-outline" (3 slides);
//       the per-slide materialization calls then get one <section> each, and
//       the intent router reports deck:true for presentation-like prompts
//       (and spreadsheet:true for "planilha"/"spreadsheet"/"excel"/"xlsx")
//   - otherwise → "OK" (after a tool result: "The tool returned: <result>")
//
// Tests can also HOLD a request: gw.hold(match) parks every request for which
// match({ method, path, body }) is true (a streaming chat request after its
// first chunks, so it is in flight mid-stream; anything else before answering)
// until release(). A caller that gives up meanwhile is recorded in gw.aborted
// ({ method, path, body, at }), which is how the abort tests observe that the
// app cancelled its gateway call.
//
//   node scripts/fake-gateway.mjs [--port 8787]     # prints the base URL
//   DATABRICKS_HOST=http://127.0.0.1:8787 node server/index.js
//
// Never use it as DATABRICKS_HOST for a deployed app: it answers every caller.
import http from 'node:http'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EMBEDDING_DIM = 1024 // chat_messages.embedding is vector(1024)

export const FAKE_ENDPOINTS = [
  'databricks-claude-sonnet-5-5',
  'databricks-claude-haiku-5-5',
  'databricks-claude-haiku-4-5',
  'databricks-gpt-6-luna',
  'databricks-gemini-3-8-flash',
]

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
  return ''
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return textOf(messages[i].content)
  return ''
}

const DOC_RE = /\b(documento|document|relat[óo]rio|report)\b/i
const DECK_RE = /\b(apresenta[çc][ãa]o|deck|slides?)\b/i
const SHEET_RE = /\b(planilha|spreadsheet|excel|xlsx)\b/i
// the user turn of a per-slide materialization call (server/deckHtmlGenerate.js)
const SLIDE_RE = /<section> do slide (\d+):\s*$/
const roughTokens = (s) => Math.max(1, Math.ceil(String(s).length / 4))

/** Deterministic unit vector for an input string (same text → same vector). */
export function fakeEmbedding(text) {
  const out = new Array(EMBEDDING_DIM)
  let seed = createHash('sha256').update(String(text)).digest()
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    if (i % 32 === 0 && i) seed = createHash('sha256').update(seed).digest()
    out[i] = seed[i % 32] / 127.5 - 1
  }
  const norm = Math.sqrt(out.reduce((a, x) => a + x * x, 0)) || 1
  return out.map((x) => x / norm)
}

function deckOutlineAnswer() {
  const outline = {
    type: 'deck-outline',
    title: 'Fake deck',
    slides: [
      { kind: 'cover', headline: 'Fake deck' },
      { kind: 'content', headline: 'Second slide', content: 'One point.' },
      { kind: 'closing', headline: 'Thanks' },
    ],
  }
  return `Here is the plan.\n\n\`\`\`prism-block\n${JSON.stringify(outline)}\n\`\`\`\n`
}

function documentAnswer(prompt) {
  const title = (/(?:t[íi]tulo|title)\s*["“']([^"”']+)["”']/i.exec(prompt) || [])[1] || 'Fake document'
  const block = { type: 'document', title, markdown: `# ${title}\n\nThis is a one-sentence paragraph written by the fake gateway.` }
  return `Here is the document.\n\n\`\`\`prism-block\n${JSON.stringify(block)}\n\`\`\`\n`
}

// Canned arguments for the artifact tools (server/artifactTools.js), so a test can
// drive a tool-created artifact with a short prompt.
export const FAKE_TOOL_ARGS = {
  create_deck: {
    title: 'Fake tool deck',
    slides: [
      { kind: 'cover', headline: 'Fake tool deck' },
      { kind: 'content', headline: 'Second slide', content: 'One point.' },
      { kind: 'closing', headline: 'Thanks' },
    ],
  },
  create_spreadsheet: {
    title: 'Fake tool sheet',
    sheets: [{ name: 'Data', blocks: [{ kind: 'table', columns: [{ header: 'Item' }, { header: 'Qty', format: 'integer' }], rows: [['a', 1], ['b', 2]] }] }],
  },
  create_document: { title: 'Fake tool document', markdown: '# Fake tool document\n\nOne sentence from the fake gateway.' },
}

function namedToolCall(prompt, body) {
  const m = /\[fake:tool:([A-Za-z0-9_-]+)\]/.exec(prompt)
  if (!m) return null
  const name = m[1]
  const offered = Array.isArray(body?.tools) && body.tools.some((t) => t?.function?.name === name)
  if (!offered) return { text: `fake: tool ${name} not offered` }
  const enc = /\[fake:args:([A-Za-z0-9_-]+={0,2})\]/.exec(prompt)
  const args = enc ? Buffer.from(enc[1], 'base64url').toString('utf8') : JSON.stringify(FAKE_TOOL_ARGS[name] || {})
  return { toolCall: { name, arguments: args } }
}

/** What the "model" does for a chat request: { text } or { toolCall }. */
export function planReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const prompt = lastUserText(messages)
  const lastUserIdx = messages.map((m) => m?.role).lastIndexOf('user')
  const toolResult = messages.slice(lastUserIdx + 1).filter((m) => m?.role === 'tool').at(-1)
  if (/\[fake:error\]/.test(prompt)) return { error: true }
  if (toolResult) return { text: `The tool returned: ${textOf(toolResult.content)}` }
  const named = namedToolCall(prompt, body)
  if (named) return named
  const tool = Array.isArray(body?.tools) ? body.tools[0]?.function?.name : null
  if (/\[fake:tool\]/.test(prompt) && tool) return { toolCall: { name: tool, arguments: '{"question":"fake"}' } }
  const slide = SLIDE_RE.exec(prompt)
  if (slide) return { text: `<section class="slide"><h2>Fake slide ${slide[1]}</h2></section>` }
  if (/\[fake:deck\]/.test(prompt)) return { text: deckOutlineAnswer() }
  if (DOC_RE.test(prompt)) return { text: documentAnswer(prompt) }
  return { text: 'OK' }
}

function nonStreamingText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = messages.filter((m) => m?.role === 'system').map((m) => textOf(m.content)).join('\n')
  const prompt = lastUserText(messages)
  if (/intent router/i.test(system)) {
    const doc = DOC_RE.test(prompt)
    const deck = DECK_RE.test(prompt)
    const sheet = SHEET_RE.test(prompt)
    // the client sends stop:["}"], which the real gateway strips from the output
    return `{"deck":${deck},"spreadsheet":${sheet},"image":false,"document":${doc},"data":false`
  }
  if (/title chat conversations/i.test(system)) return '🧪 Fake conversation'
  if (/memory extractor/i.test(system)) {
    // "[fake:memory:<base64url JSON>]" in the user's message → that JSON verbatim;
    // otherwise nothing worth remembering
    const m = /\[fake:memory:([A-Za-z0-9_-]+)\]/.exec(prompt)
    return m ? Buffer.from(m[1], 'base64url').toString('utf8') : '{"memories":[]}'
  }
  const plan = planReply(body)
  if (plan.text && plan.text !== 'OK') return plan.text
  return 'Fake conversation'
}

function usageFor(body, completionText) {
  const prompt = roughTokens(JSON.stringify(body?.messages || []))
  const completion = roughTokens(completionText || '')
  // same keys as the real gateway (Claude endpoints add the prompt-cache counters)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

function chunk(base, delta, finishReason = null, usage) {
  const c = { ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] }
  if (usage) c.usage = usage
  return c
}

/** The SSE chunk list for a streaming request (exposed for assertions). */
export function streamChunks(body, plan = planReply(body)) {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body?.model || 'fake' }
  // Like the real gateway (recorded in tests/fixtures/gateway-shapes.live.json):
  // the first chunk carries a partial usage (completion/total still null) and
  // the final usage rides on the finish_reason chunk, not on a choices:[] chunk.
  const final = (completion) => usageFor(body, completion)
  const partial = { ...final(''), completion_tokens: null, total_tokens: null }
  const out = [chunk(base, { role: 'assistant', content: '' }, null, partial)]
  out.push(chunk(base, { reasoning_content: 'Reading the request. ' }))
  out.push(chunk(base, { reasoning_content: 'Answering briefly.' }))
  let completion
  if (plan.toolCall) {
    const a = plan.toolCall.arguments
    const cut = Math.ceil(a.length / 2)
    out.push(chunk(base, { tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: plan.toolCall.name, arguments: '' } }] }))
    out.push(chunk(base, { tool_calls: [{ index: 0, function: { arguments: a.slice(0, cut) } }] }))
    out.push(chunk(base, { tool_calls: [{ index: 0, function: { arguments: a.slice(cut) } }] }))
    completion = plan.toolCall.name + a
    out.push(chunk(base, {}, 'tool_calls', final(completion)))
  } else {
    const text = plan.text || ''
    for (let i = 0; i < text.length; i += 24) out.push(chunk(base, { content: text.slice(i, i + 24) }))
    completion = text
    out.push(chunk(base, {}, 'stop', final(completion)))
  }
  return out
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

async function readBody(req) {
  let raw = ''
  for await (const c of req) raw += c
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

/**
 * Starts the fake on 127.0.0.1. Returns { url, port, requests, lastStreamChunks, close }.
 * `requests` records { method, path, body } for every call (newest last).
 */
export async function startFakeGateway({ port = 0, host = '127.0.0.1', log = false } = {}) {
  const state = { requests: [], lastStreamChunks: [], holds: [], aborted: [] }

  // Parks the request while a matching hold is closed. Resolves true when the
  // hold opens, false when the caller went away first (recorded in `aborted`).
  function parkIfHeld(rec, res) {
    const h = state.holds.find((x) => !x.opened && x.match(rec))
    if (!h) return Promise.resolve(true)
    h.enter(rec)
    return new Promise((resolve) => {
      const onClose = () => {
        if (res.writableFinished) return
        const at = Date.now()
        state.aborted.push({ ...rec, at })
        h.abort({ ...rec, at })
        resolve(false)
      }
      res.once('close', onClose)
      h.waiters.push(() => {
        res.off('close', onClose)
        resolve(true)
      })
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake')
    const body = req.method === 'POST' ? await readBody(req) : null
    const rec = { method: req.method, path: url.pathname, body }
    state.requests.push(rec)
    if (log) process.stdout.write(`${req.method} ${url.pathname}\n`)

    const streaming = req.method === 'POST' && url.pathname === '/serving-endpoints/chat/completions' && body?.stream
    // a held streaming request is parked mid-stream, below; anything else here
    if (!streaming && !(await parkIfHeld(rec, res))) return

    if (req.method === 'POST' && url.pathname === '/serving-endpoints/chat/completions') {
      const plan = planReply(body)
      if (plan.error) return sendJson(res, 503, { error_code: 'TEMPORARILY_UNAVAILABLE', message: 'fake gateway: upstream model temporarily unavailable' })
      if (body?.stream) {
        const chunks = streamChunks(body, plan)
        state.lastStreamChunks = chunks
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        // the role and first reasoning chunk go out before a hold parks the stream
        const head = 2
        for (const c of chunks.slice(0, head)) res.write(`data: ${JSON.stringify(c)}\n\n`)
        if (!(await parkIfHeld(rec, res))) return
        for (const c of chunks.slice(head)) res.write(`data: ${JSON.stringify(c)}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      const text = nonStreamingText(body)
      return sendJson(res, 200, {
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model || 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: usageFor(body, text),
      })
    }
    if (req.method === 'POST' && url.pathname === '/serving-endpoints/embeddings') {
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? '']
      const tokens = inputs.reduce((a, s) => a + roughTokens(s), 0)
      return sendJson(res, 200, {
        id: 'embd-fake',
        object: 'list',
        model: body?.model || 'fake-embedding',
        data: inputs.map((s, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(s) })),
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      })
    }
    if (req.method === 'POST' && url.pathname === '/ai-gateway/typesafe/v1/systemone') {
      const message = String(body?.state?.message || '')
      if (/\[fake:openjev:error\]/.test(message)) return sendJson(res, 422, { error_code: 'INVALID_PARAMETER_VALUE', message: 'fake gateway: invalid questions' })
      const hit = { deck: DECK_RE.test(message), document: DOC_RE.test(message), spreadsheet: SHEET_RE.test(message) }
      const answers = Object.fromEntries(Object.keys(body?.questions || {}).map((k) => [k, { noul: hit[k] ? 0.97 : 0.02 }]))
      return sendJson(res, 200, { model: 'databricks-openjev-qwen35-4b', answers, usage: { input_tokens: roughTokens(JSON.stringify(body)), output_tokens: 0 } })
    }
    if (req.method === 'GET' && url.pathname === '/api/2.0/serving-endpoints') {
      return sendJson(res, 200, { endpoints: FAKE_ENDPOINTS.map((name) => ({ name, task: 'llm/v1/chat', state: { ready: 'READY' } })) })
    }
    if (req.method === 'GET' && url.pathname === '/api/2.0/preview/scim/v2/Me') {
      return sendJson(res, 200, { id: 'fake-user', userName: 'local-dev@example.com', groups: [] })
    }
    sendJson(res, 404, { error_code: 'ENDPOINT_NOT_FOUND', message: `fake gateway: no handler for ${req.method} ${url.pathname}` })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    get requests() {
      return state.requests
    },
    get lastStreamChunks() {
      return state.lastStreamChunks
    },
    /** Callers that went away while their request was held (newest last). */
    get aborted() {
      return state.aborted
    },
    /**
     * Holds matching requests until release(). Returns { entered, aborted,
     * release } — `entered` resolves with the first held request, `aborted`
     * with the first held request whose caller went away ({ ...request, at }).
     */
    hold(match) {
      let enter
      let abort
      const h = {
        match,
        opened: false,
        waiters: [],
        entered: new Promise((r) => (enter = r)),
        aborted: new Promise((r) => (abort = r)),
      }
      h.enter = enter
      h.abort = abort
      state.holds.push(h)
      return {
        entered: h.entered,
        aborted: h.aborted,
        release() {
          h.opened = true
          state.holds.splice(state.holds.indexOf(h), 1)
          for (const w of h.waiters.splice(0)) w()
        },
      }
    },
    close: () => new Promise((r) => {
      for (const h of state.holds.splice(0)) for (const w of h.waiters.splice(0)) w()
      server.closeAllConnections?.()
      server.close(() => r())
    }),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/fake-gateway.mjs [--port <n>] [--quiet]\n')
    process.exit(0)
  }
  const i = argv.indexOf('--port')
  const port = i >= 0 ? Number(argv[i + 1]) : Number(process.env.FAKE_GATEWAY_PORT || 8787)
  const gw = await startFakeGateway({ port, log: !argv.includes('--quiet') })
  process.stdout.write(`fake AI Gateway listening on ${gw.url}\n`)
  const stop = () => gw.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
