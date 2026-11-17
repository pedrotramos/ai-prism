// Contract tests for scripts/fake-gateway.mjs. The fake is driven by the REAL
// AI Gateway client (server/llm.js) and block parser (server/blocks.js), so a
// shape the app no longer understands fails here instead of in CI's smoke.
//   node --test tests/fakeGateway.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGateway, EMBEDDING_DIM } from '../scripts/fake-gateway.mjs'

let gw
let llm
let blocks

before(async () => {
  gw = await startFakeGateway({ port: 0 })
  process.env.DATABRICKS_HOST = gw.url
  llm = await import('../server/llm.js')
  blocks = await import('../server/blocks.js')
})

after(async () => {
  await gw?.close()
})

async function drain(gen) {
  const out = { text: '', reasoning: '', final: null }
  for await (const chunk of gen) {
    if (chunk.delta) out.text += chunk.delta
    else if (chunk.reasoning) out.reasoning += chunk.reasoning
    else out.final = chunk
  }
  return out
}

const MODEL = 'databricks-claude-sonnet-5-5'

test('streaming chat: reasoning_content, delta.content, final usage and [DONE]', async () => {
  const r = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'Responda apenas com a palavra OK.' }]))
  assert.equal(r.text, 'OK')
  assert.ok(r.reasoning.length > 0, 'reasoning was streamed as its own chunk')
  assert.equal(r.final.finishReason, 'stop')
  assert.equal(r.final.toolCalls, null)
  assert.equal(r.final.usage.prompt_tokens > 0, true)
  assert.equal(r.final.usage.completion_tokens > 0, true)
  const req = gw.requests.at(-1)
  assert.equal(req.path, '/serving-endpoints/chat/completions')
  assert.equal(req.body.stream, true)
  assert.equal(req.body.model, MODEL)
})

test('streaming chat: indexed delta.tool_calls are fragmented and finish with tool_calls', async () => {
  const tools = [{ type: 'function', function: { name: 'lookup_rows', description: 'x', parameters: { type: 'object', properties: {} } } }]
  const r = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'Count the rows [fake:tool]' }], { tools }))
  assert.equal(r.final.finishReason, 'tool_calls')
  assert.deepEqual(r.final.toolCalls, [
    { id: 'call_fake_1', type: 'function', function: { name: 'lookup_rows', arguments: '{"question":"fake"}' } },
  ])
  // the arguments arrived split over several chunks (the client concatenates them)
  assert.ok(gw.lastStreamChunks.filter((c) => c.choices?.[0]?.delta?.tool_calls).length >= 3)
})

test('streaming chat: after a tool result the model answers instead of calling again', async () => {
  const tools = [{ type: 'function', function: { name: 'lookup_rows', parameters: { type: 'object', properties: {} } } }]
  const r = await drain(
    llm.streamChat(
      't',
      MODEL,
      [
        { role: 'user', content: 'Count the rows [fake:tool]' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_fake_1', type: 'function', function: { name: 'lookup_rows', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_fake_1', content: '42' },
      ],
      { tools }
    )
  )
  assert.equal(r.final.toolCalls, null)
  assert.equal(r.final.finishReason, 'stop')
  assert.match(r.text, /42/)
})

test('streaming chat: a document request yields a prism-block the real parser resolves', async () => {
  const r = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'Crie um documento curto com título "Smoke test".' }]))
  const { blocks: parsed } = blocks.extractPrismBlocks(r.text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].type, 'document')
  assert.equal(parsed[0].title, 'Smoke test')
  assert.match(parsed[0].markdown, /^# Smoke test/)
})

test('non-streaming completion returns message.content and usage', async () => {
  const { text, usage } = await llm.completeWithUsage('t', MODEL, [
    { role: 'system', content: 'Generate a short title for this conversation.' },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(text, 'Fake conversation')
  assert.equal(usage.prompt_tokens > 0, true)
})

test('intent classifier: JSON without the stop brace is parsed by the real client', async () => {
  const doc = await llm.classifyIntent('t', 'Crie um documento curto sobre o projeto')
  assert.equal(doc.intents.document, true)
  assert.equal(doc.intents.deck, false)
  const chat = await llm.classifyIntent('t', 'quanto é 2+2?')
  assert.equal(chat.intents.document, false)
})

test('embeddings: data[].embedding with the pgvector dimension, deterministic per input', async () => {
  const [a, b, a2] = await llm.embed('t', ['alpha', 'beta', 'alpha'])
  assert.equal(a.length, EMBEDDING_DIM)
  assert.equal(EMBEDDING_DIM, 1024)
  assert.deepEqual(a, a2)
  assert.notDeepEqual(a, b)
})

test('HTTP errors on demand and 404 for unknown paths', async () => {
  await assert.rejects(drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'hi [fake:error]' }])), /returned 503/)
  const res = await fetch(`${gw.url}/api/2.0/nothing-here`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error_code, 'ENDPOINT_NOT_FOUND')
})

test('serving-endpoints listing answers the discovery call with chat endpoints', async () => {
  const res = await fetch(`${gw.url}/api/2.0/serving-endpoints`)
  const { endpoints } = await res.json()
  assert.ok(endpoints.some((e) => e.name === MODEL && e.task === 'llm/v1/chat'))
})

// ---- shapes recorded from the real gateway (tests/fixtures/gateway-shapes.live.json)

import { readFileSync } from 'node:fs'
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/gateway-shapes.live.json', import.meta.url), 'utf8'))

function skeleton(v, p = '$', out = new Set()) {
  if (Array.isArray(v)) {
    out.add(`${p}:array`)
    v.forEach((x) => skeleton(x, `${p}[]`, out))
  } else if (v && typeof v === 'object') {
    out.add(`${p}:object`)
    for (const k of Object.keys(v)) skeleton(v[k], `${p}.${k}`, out)
  } else out.add(`${p}:${v === null ? 'null' : typeof v}`)
  return out
}

const sse = async (res) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())

async function post(path, body) {
  return fetch(`${gw.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

test('live shapes: every streamed path the fake emits was seen on the real gateway', async () => {
  const live = new Set(LIVE.streaming.paths)
  for (const k of LIVE.streaming.reasoningDeltaKeys) live.add(`$.choices[].delta.${k}:string`)
  const tools = [{ type: 'function', function: { name: 'lookup_rows', parameters: { type: 'object', properties: {} } } }]
  for (const body of [
    { model: MODEL, stream: true, messages: [{ role: 'user', content: 'OK?' }] },
    { model: MODEL, stream: true, tools, messages: [{ role: 'user', content: 'go [fake:tool]' }] },
  ]) {
    const res = await post('/serving-endpoints/chat/completions', body)
    assert.equal(res.headers.get('content-type'), LIVE.streaming.contentType)
    const lines = await sse(res)
    assert.equal(lines.at(-1), '[DONE]')
    const paths = new Set()
    for (const l of lines.slice(0, -1)) skeleton(JSON.parse(l), '$', paths)
    const unseen = [...paths].filter((p) => !live.has(p))
    assert.deepEqual(unseen, [], `fake emits paths the real gateway never sent: ${unseen.join(', ')}`)
  }
})

test('live shapes: usage carries the same keys as the real gateway (cache tokens included)', async () => {
  const res = await post('/serving-endpoints/chat/completions', { model: MODEL, stream: true, messages: [{ role: 'user', content: 'OK?' }] })
  const chunks = (await sse(res)).filter((l) => l !== '[DONE]').map((l) => JSON.parse(l))
  const final = chunks.filter((c) => c.usage?.completion_tokens != null).at(-1)
  assert.deepEqual(Object.keys(final.usage).sort(), LIVE.streaming.usageKeys)
  // like the real stream, usage rides on a chunk that still has choices
  assert.equal(final.choices.length, 1)
  const first = await post('/serving-endpoints/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual(Object.keys((await first.json()).usage).sort(), LIVE.streaming.usageKeys)
})

test('live shapes: tool-call deltas follow the real pattern (id/type/name first, then arguments only)', async () => {
  const tools = [{ type: 'function', function: { name: 'lookup_rows', parameters: { type: 'object', properties: {} } } }]
  const res = await post('/serving-endpoints/chat/completions', { model: MODEL, stream: true, tools, messages: [{ role: 'user', content: 'go [fake:tool]' }] })
  const deltas = (await sse(res))
    .filter((l) => l !== '[DONE]')
    .map((l) => JSON.parse(l).choices?.[0]?.delta?.tool_calls)
    .filter(Boolean)
    .map((tc) => tc.map((t) => Object.keys(t).sort().join(',') + (t.function ? ' fn:' + Object.keys(t.function).sort().join(',') : ''))[0])
  assert.equal(deltas[0], LIVE.streaming.toolCallDeltas[0])
  for (const d of deltas.slice(1)) assert.equal(d, LIVE.streaming.toolCallDeltas[1])
})

test('live shapes: non-streaming and embeddings bodies match the real key sets', async () => {
  const ns = await post('/serving-endpoints/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual([...skeleton(await ns.json())].sort(), LIVE.nonStreaming.paths)
  const em = await post('/serving-endpoints/embeddings', { model: 'm', input: ['a', 'b'] })
  const body = await em.json()
  assert.equal(body.data[0].embedding.length, LIVE.embeddings.dim)
  body.data = body.data.map((d) => ({ ...d, embedding: d.embedding.slice(0, 1) }))
  assert.deepEqual([...skeleton(body)].sort(), LIVE.embeddings.paths)
})

test('title generation: the real generateTitle gets the fake title (emoji + words)', async () => {
  const title = await llm.generateTitle('t', 'Compare Q3 revenue by region')
  assert.equal(title, '🧪 Fake conversation')
  const req = gw.requests.at(-1)
  assert.equal(req.body.stream, undefined)
  assert.match(req.body.messages[0].content, /title chat conversations/)
})
