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
//   - "[fake:error]" → HTTP 503 with a gateway-style error body
//   - otherwise → "OK" (after a tool result: "The tool returned: <result>")
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

function documentAnswer(prompt) {
  const title = (/(?:t[íi]tulo|title)\s*["“']([^"”']+)["”']/i.exec(prompt) || [])[1] || 'Fake document'
  const block = { type: 'document', title, markdown: `# ${title}\n\nThis is a one-sentence paragraph written by the fake gateway.` }
  return `Here is the document.\n\n\`\`\`prism-block\n${JSON.stringify(block)}\n\`\`\`\n`
}

/** What the "model" does for a chat request: { text } or { toolCall }. */
export function planReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const prompt = lastUserText(messages)
  const lastUserIdx = messages.map((m) => m?.role).lastIndexOf('user')
  const toolResult = messages.slice(lastUserIdx + 1).filter((m) => m?.role === 'tool').at(-1)
  if (/\[fake:error\]/.test(prompt)) return { error: true }
  if (toolResult) return { text: `The tool returned: ${textOf(toolResult.content)}` }
  const tool = Array.isArray(body?.tools) ? body.tools[0]?.function?.name : null
  if (/\[fake:tool\]/.test(prompt) && tool) return { toolCall: { name: tool, arguments: '{"question":"fake"}' } }
  if (DOC_RE.test(prompt)) return { text: documentAnswer(prompt) }
  return { text: 'OK' }
}

function nonStreamingText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = messages.filter((m) => m?.role === 'system').map((m) => textOf(m.content)).join('\n')
  const prompt = lastUserText(messages)
  if (/intent router/i.test(system)) {
    const doc = DOC_RE.test(prompt)
    // the client sends stop:["}"], which the real gateway strips from the output
    return `{"deck":false,"spreadsheet":false,"image":false,"document":${doc},"data":false`
  }
  if (/title chat conversations/i.test(system)) return '🧪 Fake conversation'
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
  const state = { requests: [], lastStreamChunks: [] }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake')
    const body = req.method === 'POST' ? await readBody(req) : null
    state.requests.push({ method: req.method, path: url.pathname, body })
    if (log) process.stdout.write(`${req.method} ${url.pathname}\n`)

    if (req.method === 'POST' && url.pathname === '/serving-endpoints/chat/completions') {
      const plan = planReply(body)
      if (plan.error) return sendJson(res, 503, { error_code: 'TEMPORARILY_UNAVAILABLE', message: 'fake gateway: upstream model temporarily unavailable' })
      if (body?.stream) {
        const chunks = streamChunks(body, plan)
        state.lastStreamChunks = chunks
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
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
    close: () => new Promise((r) => server.close(() => r())),
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
