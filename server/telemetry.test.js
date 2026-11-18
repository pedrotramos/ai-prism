// OTel core spans, asserted in memory: `llm.call` around every gateway call
// (server/llm.js) and `tool.call` around every tool invocation (server/tools.js),
// with exactly the attribute names of the design row. A test tracer provider
// with an InMemorySpanExporter stands in for the one AppKit registers when
// OTEL_EXPORTER_OTLP_ENDPOINT is set.
//
//   node --test server/telemetry.test.js
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))

process.env.DATABRICKS_HOST = 'https://gateway.test'
process.env.SQL_WAREHOUSE_ID = 'wh-test'

const { streamChat, completeWithUsage, setUsageSink } = await import('./llm.js')
const { invokeTool, buildToolDefs } = await import('./tools.js')

const LLM_ATTRS = ['cost_usd', 'gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'status']
const TOOL_ATTRS = ['duration_ms', 'status', 'tool.kind', 'tool.name']

const realFetch = globalThis.fetch
let fetchImpl
beforeEach(() => {
  exporter.reset()
  setUsageSink(() => 0.0042)
  globalThis.fetch = (url, init) => fetchImpl(String(url), init)
})
afterEach(() => {
  globalThis.fetch = realFetch
  setUsageSink(null)
})

function sse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const spans = (name) => exporter.getFinishedSpans().filter((s) => s.name === name)

test('llm.call: streamed chat carries model, usage, cost and status', async () => {
  fetchImpl = async () =>
    sse([
      { choices: [{ delta: { content: 'Olá' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ])
  let text = ''
  for await (const ch of streamChat('tok', 'm-test', [{ role: 'user', content: 'a confidential prompt' }])) text += ch.delta || ''
  assert.equal(text, 'Olá')
  const [s] = spans('llm.call')
  assert.ok(s, 'an llm.call span was recorded')
  assert.deepEqual(Object.keys(s.attributes).sort(), LLM_ATTRS)
  assert.equal(s.attributes['gen_ai.request.model'], 'm-test')
  assert.equal(s.attributes['gen_ai.usage.input_tokens'], 12)
  assert.equal(s.attributes['gen_ai.usage.output_tokens'], 5)
  assert.equal(s.attributes.cost_usd, 0.0042)
  assert.equal(s.attributes.status, 'ok')
  assert.ok(!JSON.stringify(s.attributes).includes('confidential'), 'no prompt text in the span')
})

test('llm.call: output tokens follow the ledger rule (reasoning outside completion)', async () => {
  fetchImpl = async () => sse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 136 } }])
  for await (const _ of streamChat('tok', 'm-test', [{ role: 'user', content: 'q' }])) void _
  assert.equal(spans('llm.call')[0].attributes['gen_ai.usage.output_tokens'], 126)
})

test('llm.call: a gateway error ends the span with status error and rethrows', async () => {
  fetchImpl = async () => new Response('boom', { status: 500 })
  await assert.rejects(async () => {
    for await (const _ of streamChat('tok', 'm-test', [{ role: 'user', content: 'q' }])) void _
  }, /returned 500/)
  const [s] = spans('llm.call')
  assert.equal(s.attributes.status, 'error')
  assert.equal(s.attributes['gen_ai.request.model'], 'm-test')
  assert.equal(s.status.code, 2) // SpanStatusCode.ERROR
})

test('llm.call: a consumer that stops early still ends the span', async () => {
  fetchImpl = async () => sse([{ choices: [{ delta: { content: 'a' } }] }, { choices: [{ delta: { content: 'b' } }] }])
  for await (const _ of streamChat('tok', 'm-test', [{ role: 'user', content: 'q' }])) break
  assert.equal(spans('llm.call').length, 1)
})

test('llm.call: non-streaming completion is traced too', async () => {
  fetchImpl = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'title' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }), { status: 200 })
  const { text } = await completeWithUsage('tok', 'm-fast', [{ role: 'user', content: 'q' }])
  assert.equal(text, 'title')
  const [s] = spans('llm.call')
  assert.deepEqual(Object.keys(s.attributes).sort(), LLM_ATTRS)
  assert.equal(s.attributes['gen_ai.request.model'], 'm-fast')
  assert.equal(s.attributes['gen_ai.usage.input_tokens'], 7)
  assert.equal(s.attributes['gen_ai.usage.output_tokens'], 2)
  assert.equal(s.attributes.status, 'ok')
})

test('tool.call: name, kind, duration and status of a successful call', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ status: { state: 'SUCCEEDED' }, result: { data_array: [['42']] } }), { status: 200 })
  const { resolvers } = await buildToolDefs([], 'tok', 'ana@example.com', { includePython: true, includeWebSearch: false })
  const resolver = resolvers.get('execute_python')
  const out = await invokeTool('tok', resolver, { code: 'print(secret_value)' }, {})
  assert.equal(out.resultText, '42')
  const [s] = spans('tool.call')
  assert.ok(s, 'a tool.call span was recorded')
  assert.deepEqual(Object.keys(s.attributes).sort(), TOOL_ATTRS)
  assert.equal(s.attributes['tool.name'], 'execute_python')
  assert.equal(s.attributes['tool.kind'], 'python')
  assert.equal(typeof s.attributes.duration_ms, 'number')
  assert.ok(s.attributes.duration_ms >= 0)
  assert.equal(s.attributes.status, 'ok')
  assert.ok(!JSON.stringify(s.attributes).includes('secret_value'), 'no tool arguments in the span')
})

test('tool.call: a failing tool ends with status error and rethrows', async () => {
  fetchImpl = async () => new Response(JSON.stringify({ status: { state: 'FAILED', error: { message: 'bad' } } }), { status: 200 })
  await assert.rejects(() => invokeTool('tok', { kind: 'python', toolName: 'execute_python' }, { code: '1/0' }, {}), /bad/)
  const [s] = spans('tool.call')
  assert.equal(s.attributes.status, 'error')
  assert.equal(s.attributes['tool.kind'], 'python')
  assert.equal(s.status.code, 2)
})

test('tool.call: an MCP connection that failed to load is an error span', async () => {
  const out = await invokeTool('tok', { kind: 'mcp-external-error', toolName: 'mcp_x__search', error: 'unreachable' }, {}, {})
  assert.match(out.resultText, /^ERROR:/)
  const [s] = spans('tool.call')
  assert.equal(s.attributes['tool.name'], 'mcp_x__search')
  assert.equal(s.attributes.status, 'error')
})
