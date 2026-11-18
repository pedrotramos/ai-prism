// Without OTEL_EXPORTER_OTLP_ENDPOINT no tracer provider is registered (AppKit
// registers one only when the endpoint is set; the legacy boot never does): the
// spans are no-ops, nothing is sent anywhere but the gateway, and nothing throws.
// Separate file from telemetry.test.js so no test provider is registered here.
//
//   node --test server/telemetry-noexport.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
process.env.DATABRICKS_HOST = 'https://gateway.test'

const { startSpan, withSpan } = await import('./telemetry.js')
const { streamChat } = await import('./llm.js')
const { invokeTool } = await import('./tools.js')

test('no endpoint: spans are not recording', () => {
  const span = startSpan('llm.call', { 'gen_ai.request.model': 'm' })
  assert.equal(span.isRecording(), false)
  span.end()
})

test('no endpoint: a traced gateway call and tool call work and only reach the gateway', async () => {
  const urls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
    return new Response(body, { status: 200 })
  }
  try {
    let text = ''
    for await (const ch of streamChat('tok', 'm', [{ role: 'user', content: 'q' }])) text += ch.delta || ''
    assert.equal(text, 'ok')
    const out = await invokeTool('tok', { kind: 'mcp-external-error', toolName: 't', error: 'x' }, {}, {})
    assert.match(out.resultText, /^ERROR:/)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(urls, ['https://gateway.test/serving-endpoints/chat/completions'])
})

test('no endpoint: withSpan returns the result and rethrows the error unchanged', async () => {
  assert.equal(await withSpan('tool.call', {}, async () => 7), 7)
  const err = new Error('original')
  await assert.rejects(() => withSpan('tool.call', {}, async () => { throw err }), (e) => e === err)
})
