#!/usr/bin/env node
// Re-records tests/fixtures/gateway-shapes.live.json from a REAL Databricks AI
// Gateway: key paths and JSON types only (no host, ids, tokens or content).
// Makes 6 small calls to cheap models. Not part of CI (it needs a workspace).
//
//   DATABRICKS_HOST=https://<workspace> \
//   DATABRICKS_TOKEN="$(databricks auth token -p <PROFILE> -o json | jq -r .access_token)" \
//   node tests/live/record-gateway-shapes.mjs
//
// The token is read from the environment and never printed.
import { writeFileSync } from 'node:fs'

const HOST = String(process.env.DATABRICKS_HOST || '').replace(/\/+$/, '')
const TOKEN = process.env.DATABRICKS_TOKEN
if (!HOST.startsWith('https://') || !TOKEN) {
  process.stderr.write('set DATABRICKS_HOST (https://…) and DATABRICKS_TOKEN\n')
  process.exit(2)
}
const CHAT = process.env.SHAPES_CHAT_MODEL || 'databricks-claude-haiku-4-5'
const REASONING = process.env.SHAPES_REASONING_MODEL || 'databricks-glm-5-3-flash'
const EMBED = process.env.SHAPES_EMBED_MODEL || 'databricks-qwen3-embedding-0-6b'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

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

async function post(path, body) {
  const res = await fetch(`${HOST}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} (${body.model}) → HTTP ${res.status}`)
  return res
}

async function stream(body) {
  const res = await post('/serving-endpoints/chat/completions', { ...body, stream: true })
  const lines = (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  const chunks = lines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l))
  const paths = new Set()
  chunks.forEach((c) => skeleton(c, '$', paths))
  return {
    contentType: res.headers.get('content-type'),
    endsWithDone: lines.at(-1) === '[DONE]',
    chunks,
    paths,
    finish: chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean),
    usage: chunks.filter((c) => c.usage?.completion_tokens != null).at(-1)?.usage,
  }
}

const ask = [{ role: 'user', content: 'Reply with the single word OK.' }]
const tools = [{ type: 'function', function: { name: 'lookup_rows', description: 'Look up rows', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } }]

const plain = await stream({ model: CHAT, max_tokens: 20, messages: ask, stream_options: { include_usage: true } })
const tool = await stream({ model: CHAT, max_tokens: 200, tools, tool_choice: 'required', messages: [{ role: 'user', content: 'Use the lookup_rows tool with question "fake".' }], stream_options: { include_usage: true } })
const reasoning = await stream({ model: REASONING, max_tokens: 300, messages: [{ role: 'user', content: 'What is 17*23? Think briefly, then reply with the number only.' }] })
const nonStream = await (await post('/serving-endpoints/chat/completions', { model: CHAT, max_tokens: 20, messages: ask })).json()
const emb = await (await post('/serving-endpoints/embeddings', { model: EMBED, input: ['alpha', 'beta'] })).json()
const listing = await (await fetch(`${HOST}/api/2.0/serving-endpoints`, { headers: H })).json()

const toolDeltas = tool.chunks
  .map((c) => c.choices?.[0]?.delta?.tool_calls?.[0])
  .filter(Boolean)
  .map((t) => Object.keys(t).sort().join(',') + (t.function ? ' fn:' + Object.keys(t.function).sort().join(',') : ''))
const reasoningKeys = new Set()
reasoning.chunks.forEach((c) => Object.keys(c.choices?.[0]?.delta || {}).forEach((k) => reasoningKeys.add(k)))
emb.data = emb.data.map((d) => ({ ...d, embedding: d.embedding.slice(0, 1) }))

const out = {
  _comment:
    'Response SHAPES recorded from a real Databricks AI Gateway (key paths with JSON types only; no host, ids, tokens or content). tests/fakeGateway.test.mjs checks the fake against them. Re-record with tests/live/record-gateway-shapes.mjs when the gateway changes.',
  recordedAt: new Date().toISOString().slice(0, 10),
  models: { chat: CHAT, reasoning: REASONING, embeddings: EMBED },
  streaming: {
    contentType: plain.contentType,
    endsWithDone: plain.endsWithDone && tool.endsWithDone,
    finishReasons: { plain: plain.finish, tool: tool.finish },
    usageKeys: Object.keys(plain.usage || {}).sort(),
    toolCallDeltas: [...new Set(toolDeltas)],
    paths: [...new Set([...plain.paths, ...tool.paths])].sort(),
    reasoningDeltaKeys: [...reasoningKeys].sort(),
  },
  nonStreaming: { paths: [...skeleton(nonStream)].sort() },
  embeddings: { dim: (await (await post('/serving-endpoints/embeddings', { model: EMBED, input: ['x'] })).json()).data[0].embedding.length, paths: [...skeleton(emb)].sort() },
  servingEndpoints: { taskValues: [...new Set((listing.endpoints || []).map((e) => e.task).filter(Boolean))].slice(0, 6) },
}
const text = JSON.stringify(out, null, 2) + '\n'
if (text.includes(HOST) || text.includes(TOKEN)) throw new Error('refusing to write: output contains the host or the token')
writeFileSync(new URL('../fixtures/gateway-shapes.live.json', import.meta.url), text)
process.stdout.write('wrote tests/fixtures/gateway-shapes.live.json\n')
