// Contract tests for scripts/fake-gateway.mjs. The fake is driven by the REAL
// AI Gateway client (server/llm.js) and block parser (server/blocks.js), so a
// shape the app no longer understands fails here instead of in CI's smoke.
//   node --test tests/fakeGateway.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGateway, EMBEDDING_DIM, FAKE_TOOL_ARGS } from '../scripts/fake-gateway.mjs'

let gw
let llm
let blocks

before(async () => {
  gw = await startFakeGateway({ port: 0 })
  process.env.DATABRICKS_HOST = gw.url
  llm = await import('../server/llm.ts')
  blocks = await import('../server/blocks.ts')
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

test('named tool scenario: [fake:tool:<name>] calls that tool (not the first) with its canned arguments', async () => {
  const fn = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } })
  const tools = [fn('lookup_rows'), fn('create_deck')]
  const r = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'Make slides [fake:tool:create_deck]' }], { tools }))
  assert.equal(r.final.finishReason, 'tool_calls')
  assert.equal(r.final.toolCalls[0].function.name, 'create_deck')
  assert.deepEqual(JSON.parse(r.final.toolCalls[0].function.arguments), FAKE_TOOL_ARGS.create_deck)
})

test('named tool scenario: [fake:args:<base64url>] overrides the arguments; an unoffered tool is a text answer', async () => {
  const tools = [{ type: 'function', function: { name: 'update_document', parameters: { type: 'object', properties: {} } } }]
  const args = { document_id: '7', markdown: '# x' }
  const enc = Buffer.from(JSON.stringify(args)).toString('base64url')
  const r = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: `edit [fake:tool:update_document] [fake:args:${enc}]` }], { tools }))
  assert.deepEqual(JSON.parse(r.final.toolCalls[0].function.arguments), args)
  const none = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'edit [fake:tool:create_deck]' }], { tools }))
  assert.equal(none.final.toolCalls, null)
  assert.equal(none.text, 'fake: tool create_deck not offered')
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
//
// The recording holds ONLY sets of "<JSON path>:<JSON type>" strings (no values:
// no dates, models, content types, finish reasons, sizes or task names), one
// set per response or chunk kind. Parity is proven from those sets alone.

import { readFileSync } from 'node:fs'
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/gateway-shapes.live.json', import.meta.url), 'utf8'))
const livePaths = (kind) => new Set(LIVE[kind].paths)

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
const subset = (a, b) => [...a].filter((x) => !b.has(x))
const usageNumberKeys = (paths) => [...paths].map((p) => /^\$\.usage\.([^.]+):number$/.exec(p)?.[1]).filter(Boolean).sort()

const sse = async (res) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())

async function post(path, body) {
  return fetch(`${gw.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
const TOOLS = [{ type: 'function', function: { name: 'lookup_rows', parameters: { type: 'object', properties: {} } } }]
async function fakeChunks(body) {
  const lines = await sse(await post('/serving-endpoints/chat/completions', { model: MODEL, stream: true, ...body }))
  assert.equal(lines.at(-1), '[DONE]') // the protocol terminator llm.js skips
  return lines.slice(0, -1).map((l) => JSON.parse(l))
}

test('live shapes: the recording holds path:type strings only', () => {
  for (const [kind, v] of Object.entries(LIVE)) {
    assert.deepEqual(Object.keys(v), ['paths'], `${kind} has only a paths list`)
    for (const p of v.paths) assert.match(p, /^\$[\w.[\]]*:(object|array|string|number|boolean|null)$/, `${kind}: ${p}`)
  }
})

test('live shapes: every streamed path the fake emits was seen on the real gateway', async () => {
  const live = new Set([...livePaths('chatStream'), ...livePaths('chatStreamReasoning')])
  for (const body of [{ messages: [{ role: 'user', content: 'OK?' }] }, { tools: TOOLS, messages: [{ role: 'user', content: 'go [fake:tool]' }] }]) {
    const paths = new Set()
    for (const c of await fakeChunks(body)) skeleton(c, '$', paths)
    assert.deepEqual(subset(paths, live), [], 'fake emits paths the real gateway never sent')
  }
})

test('live shapes: reasoning travels as a string delta.reasoning_content, as on the real gateway', async () => {
  assert.ok(livePaths('chatStreamReasoning').has('$.choices[].delta.reasoning_content:string'))
  const paths = new Set()
  for (const c of await fakeChunks({ messages: [{ role: 'user', content: 'OK?' }] })) skeleton(c, '$', paths)
  assert.ok(paths.has('$.choices[].delta.reasoning_content:string'))
})

test('live shapes: the usage-bearing chunk has the real keys (cache counters included) and still carries choices', async () => {
  const live = livePaths('chatStreamUsageChunk')
  const chunks = await fakeChunks({ messages: [{ role: 'user', content: 'OK?' }] })
  const final = skeleton(chunks.filter((c) => c.usage?.completion_tokens != null).at(-1))
  assert.deepEqual(subset(final, live), [])
  assert.deepEqual(usageNumberKeys(final), usageNumberKeys(live))
  assert.ok(live.has('$.choices[]:object') && final.has('$.choices[]:object'))
  const ns = await post('/serving-endpoints/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual(usageNumberKeys(skeleton(await ns.json())), usageNumberKeys(livePaths('chatNonStream')))
})

test('live shapes: tool-call deltas follow the real pattern (id/type/name first, then arguments only)', async () => {
  const deltas = (await fakeChunks({ tools: TOOLS, messages: [{ role: 'user', content: 'go [fake:tool]' }] }))
    .map((c) => c.choices?.[0]?.delta?.tool_calls?.[0])
    .filter(Boolean)
  assert.ok(deltas.length >= 2)
  assert.deepEqual([...skeleton(deltas[0])].sort(), LIVE.chatStreamToolCallFirstDelta.paths)
  for (const d of deltas.slice(1)) assert.deepEqual([...skeleton(d)].sort(), LIVE.chatStreamToolCallNextDelta.paths)
})

test('live shapes: non-streaming and embeddings bodies have exactly the real paths', async () => {
  const ns = await post('/serving-endpoints/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'x' }] })
  assert.deepEqual([...skeleton(await ns.json())].sort(), LIVE.chatNonStream.paths)
  const body = await (await post('/serving-endpoints/embeddings', { model: 'm', input: ['a', 'b'] })).json()
  assert.deepEqual([...skeleton(body)].sort(), LIVE.embeddings.paths)
})

test('live shapes: the endpoint listing uses fields the real listing has', async () => {
  const body = await (await fetch(`${gw.url}/api/2.0/serving-endpoints`)).json()
  // endpoint fields one level deep (deeper levels hold workspace-specific maps)
  const top = [...skeleton(body)].filter((p) => !/^\$\.endpoints\[\]\.[^.:]+\./.test(p))
  assert.deepEqual(subset(new Set(top), livePaths('servingEndpointsList')), [])
  assert.ok(livePaths('servingEndpointsList').has('$.endpoints[].task:string'))
})

test('title generation: the real generateTitle gets the fake title (emoji stripped)', async () => {
  const title = await llm.generateTitle('t', 'Compare Q3 revenue by region')
  assert.equal(title, 'Fake conversation')
  const req = gw.requests.at(-1)
  assert.equal(req.body.stream, undefined)
  assert.match(req.body.messages[0].content, /title chat conversations/)
})

test('deck scenario: [fake:deck] yields a deck-outline the real parser extracts, slides get a <section>', async () => {
  const r = await drain(llm.streamChat('t', MODEL, [{ role: 'user', content: 'Crie uma apresentação [fake:deck]' }]))
  const found = blocks.extractDeckOutline(r.text)
  assert.ok(found, 'deck-outline extracted')
  assert.equal(found.outline.slides.length, 3)
  const { text } = await llm.completeWithUsage('t', MODEL, [
    { role: 'system', content: 'slide policy' },
    { role: 'user', content: 'plano\n\n---\nMaterialize o slide 2\n\n<section> do slide 2:' },
  ])
  assert.match(text, /^<section class="slide">.*Fake slide 2.*<\/section>$/)
  const cls = await llm.classifyIntent('t', 'Crie uma apresentação sobre vendas')
  assert.equal(cls?.intents?.deck, true)
})

test('hold: a held request waits for release; a caller that leaves is recorded in aborted', async () => {
  const hold = gw.hold((r) => r.path === '/serving-endpoints/embeddings' && r.body?.input?.[0] === 'held')
  const ac = new AbortController()
  const p = fetch(`${gw.url}/serving-endpoints/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', input: ['held'] }),
    signal: ac.signal,
  }).catch((e) => e)
  const entered = await hold.entered
  assert.equal(entered.path, '/serving-endpoints/embeddings')
  ac.abort()
  await p
  const seen = await hold.aborted
  assert.equal(seen.path, '/serving-endpoints/embeddings')
  assert.ok(gw.aborted.some((a) => a.at === seen.at))
  hold.release()

  const hold2 = gw.hold((r) => r.path === '/serving-endpoints/embeddings' && r.body?.input?.[0] === 'held2')
  const p2 = fetch(`${gw.url}/serving-endpoints/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', input: ['held2'] }),
  })
  await hold2.entered
  hold2.release()
  assert.equal((await p2).status, 200)
})
