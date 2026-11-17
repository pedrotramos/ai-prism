#!/usr/bin/env node
// Re-records tests/fixtures/gateway-shapes.live.json from a REAL Databricks AI
// Gateway. The file holds ONLY sets of "<JSON path>:<JSON type>" strings, one
// set per response or chunk kind: no values at all (no dates, model names,
// content types, finish reasons, sizes, task names, ids, tokens or text).
// tests/fakeGateway.test.mjs proves the fake's parity from these sets.
//
// Makes 6 small calls to cheap models. Not part of CI (it needs a workspace).
//
//   DATABRICKS_HOST=https://<workspace> \
//   DATABRICKS_TOKEN="$(databricks auth token -p <PROFILE> -o json | jq -r .access_token)" \
//   node tests/live/record-gateway-shapes.mjs
//
// The token is read from the environment and never printed. Model choices are
// overridable (SHAPES_CHAT_MODEL, SHAPES_REASONING_MODEL, SHAPES_EMBED_MODEL);
// they are not written to the fixture.
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
const union = (objs) => {
  const s = new Set()
  for (const o of objs) skeleton(o, '$', s)
  return s
}

async function post(path, body) {
  const res = await fetch(`${HOST}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res
}

async function streamChunks(body) {
  const res = await post('/serving-endpoints/chat/completions', { ...body, stream: true })
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((l) => l !== '[DONE]')
    .map((l) => JSON.parse(l))
}

const ask = [{ role: 'user', content: 'Reply with the single word OK.' }]
const tools = [{ type: 'function', function: { name: 'lookup_rows', description: 'Look up rows', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } }]

const plain = await streamChunks({ model: CHAT, max_tokens: 20, messages: ask, stream_options: { include_usage: true } })
const tool = await streamChunks({ model: CHAT, max_tokens: 200, tools, tool_choice: 'required', messages: [{ role: 'user', content: 'Use the lookup_rows tool with question "fake".' }], stream_options: { include_usage: true } })
const reasoning = await streamChunks({ model: REASONING, max_tokens: 300, messages: [{ role: 'user', content: 'What is 17*23? Think briefly, then reply with the number only.' }] })
const nonStream = await (await post('/serving-endpoints/chat/completions', { model: CHAT, max_tokens: 20, messages: ask })).json()
const emb = await (await post('/serving-endpoints/embeddings', { model: EMBED, input: ['alpha', 'beta'] })).json()
const listing = await (await fetch(`${HOST}/api/2.0/serving-endpoints`, { headers: H })).json()

const usageChunk = [...plain, ...tool].filter((c) => c.usage?.completion_tokens != null).at(-1)
const toolDeltas = tool.map((c) => c.choices?.[0]?.delta?.tool_calls?.[0]).filter(Boolean)
if (!usageChunk || toolDeltas.length < 2) throw new Error('the gateway did not stream a usage chunk and >= 2 tool-call deltas; try another SHAPES_CHAT_MODEL')

const sorted = (set) => ({ paths: [...set].sort() })
const out = {
  chatStream: sorted(union([...plain, ...tool])),
  chatStreamUsageChunk: sorted(skeleton(usageChunk)),
  chatStreamToolCallFirstDelta: sorted(skeleton(toolDeltas[0])),
  chatStreamToolCallNextDelta: sorted(union(toolDeltas.slice(1))),
  chatStreamReasoning: sorted(union(reasoning)),
  chatNonStream: sorted(skeleton(nonStream)),
  // one embedding element is enough to type the vector
  embeddings: sorted(skeleton({ ...emb, data: (emb.data || []).map((d) => ({ ...d, embedding: d.embedding.slice(0, 1) })) })),
  // endpoint fields one level deep: deeper levels hold workspace-specific maps
  servingEndpointsList: sorted(new Set([...skeleton(listing)].filter((p) => !/^\$\.endpoints\[\]\.[^.:]+\./.test(p)))),
}
const text = JSON.stringify(out, null, 2) + '\n'
for (const v of Object.values(out)) {
  for (const p of v.paths) if (!/^\$[\w.[\]]*:(object|array|string|number|boolean|null)$/.test(p)) throw new Error(`refusing to write: not a path:type entry: ${p}`)
}
if (text.includes(HOST) || text.includes(TOKEN)) throw new Error('refusing to write: output contains the host or the token')
writeFileSync(new URL('../fixtures/gateway-shapes.live.json', import.meta.url), text)
process.stdout.write('wrote tests/fixtures/gateway-shapes.live.json\n')
