// W3-7: per-turn reasoning effort in server/llm.js.
//   AC1 no effort → the gateway body is byte-identical to the pre-W3-7 body (fixture
//       captured from origin/main@c657646 for every chat model in the catalog)
//   AC2 with effort, the provider field exists only for models with the catalog flag
//   AC6 (server half) catalog blurbs stay pt-BR literals: the client localizes by id
//
//   node --test server/llm.reasoning.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DATABRICKS_HOST = 'https://gateway.invalid'
const llm = await import('./llm.js')
const { MODELS, streamChat, reasoningParams, parseReasoningEffort, REASONING_LEVELS } = llm
const baseline = JSON.parse(readFileSync(new URL('./__fixtures__/llm-default-bodies.json', import.meta.url), 'utf8'))

const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
const tools = [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }]

/** Runs one streamChat against a stubbed fetch and returns the JSON body it sent. */
async function sentBody(model, opts = {}) {
  const real = globalThis.fetch
  let body
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    for await (const _ of streamChat('tok', model, msgs, { tools, temperature: 0.7, ...opts }));
  } finally {
    globalThis.fetch = real
  }
  return body
}

const chatModels = MODELS.filter((m) => (m.modality || 'chat') === 'chat')

test('AC1: with no effort every catalog model sends the pre-W3-7 body', async () => {
  assert.equal(chatModels.length, Object.keys(baseline).length)
  for (const m of chatModels) {
    assert.deepEqual(await sentBody(m.id), baseline[m.id], m.id)
    // 'default' / empty / undefined are the same as untouched
    assert.deepEqual(await sentBody(m.id, { reasoningEffort: 'default' }), baseline[m.id], `${m.id} default`)
  }
})

test('AC1/AC2: while no model carries the flag, an effort changes nothing anywhere', async () => {
  for (const m of chatModels) {
    assert.equal(m.reasoning, undefined, `${m.id} has no probe evidence yet`)
    assert.deepEqual(await sentBody(m.id, { reasoningEffort: 'high' }), baseline[m.id], m.id)
  }
})

test('parseReasoningEffort: absent/default are fine, only low|medium|high are levels, the rest is invalid', () => {
  assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high'])
  for (const v of [undefined, null, '', 'default']) assert.deepEqual(parseReasoningEffort(v), { ok: true, value: null }, String(v))
  for (const v of REASONING_LEVELS) assert.deepEqual(parseReasoningEffort(v), { ok: true, value: v })
  for (const v of ['max', 'HIGH', 3, true, {}, [], 'low ']) assert.equal(parseReasoningEffort(v).ok, false, JSON.stringify(v))
})

test('AC2: reasoningParams maps the flag shape per provider and is {} without the flag', () => {
  const withFlag = (param, id = 'x') => {
    const m = { id, reasoning: { param, levels: ['low', 'medium', 'high'] }, maxOut: 32768 }
    MODELS.push(m)
    return () => MODELS.splice(MODELS.indexOf(m), 1)
  }
  let undo = withFlag('openai', 'fx-openai')
  assert.deepEqual(reasoningParams('fx-openai', 'high'), { reasoning_effort: 'high' })
  assert.deepEqual(reasoningParams('fx-openai', 'low'), { reasoning_effort: 'low' })
  assert.deepEqual(reasoningParams('fx-openai', undefined), {})
  assert.deepEqual(reasoningParams('fx-openai', 'default'), {})
  undo()
  undo = withFlag('anthropic', 'fx-anthropic')
  const a = reasoningParams('fx-anthropic', 'medium')
  assert.equal(a.thinking.type, 'enabled')
  assert.ok(a.thinking.budget_tokens >= 1024 && a.thinking.budget_tokens < 32768)
  assert.ok(reasoningParams('fx-anthropic', 'high').thinking.budget_tokens > reasoningParams('fx-anthropic', 'low').thinking.budget_tokens)
  undo()
  undo = withFlag('gemini', 'fx-gemini')
  assert.deepEqual(Object.keys(reasoningParams('fx-gemini', 'low')), ['thinking_config'])
  undo()
  // not in the flag's levels → nothing
  MODELS.push({ id: 'fx-narrow', reasoning: { param: 'openai', levels: ['low', 'high'] } })
  assert.deepEqual(reasoningParams('fx-narrow', 'medium'), {})
  assert.deepEqual(reasoningParams('fx-narrow', 'high'), { reasoning_effort: 'high' })
  MODELS.pop()
  // unknown (admin-added) ids and every catalog model today
  assert.deepEqual(reasoningParams('databricks-brand-new', 'high'), {})
  for (const m of chatModels) assert.deepEqual(reasoningParams(m.id, 'high'), {}, m.id)
})

test('AC2: a flagged model gets the field in the streamed body; its neighbours do not', async () => {
  const flagged = { id: 'fx-flagged', label: 'fx', provider: 'OpenAI', streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: { param: 'openai', levels: ['low', 'medium', 'high'] } }
  const plain = { ...flagged, id: 'fx-plain', reasoning: undefined }
  MODELS.push(flagged, plain)
  try {
    const none = await sentBody('fx-flagged')
    assert.equal('reasoning_effort' in none, false)
    const withEffort = await sentBody('fx-flagged', { reasoningEffort: 'high' })
    assert.equal(withEffort.reasoning_effort, 'high')
    assert.deepEqual({ ...withEffort, reasoning_effort: undefined }, { ...none, reasoning_effort: undefined })
    assert.equal('reasoning_effort' in (await sentBody('fx-plain', { reasoningEffort: 'high' })), false)
  } finally {
    MODELS.splice(MODELS.indexOf(flagged), 1)
    MODELS.splice(MODELS.indexOf(plain), 1)
  }
})

test('AC2: the other gateway calls never carry reasoning params (complete / classifyIntent)', async () => {
  const real = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: '{"intent":"chat"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  MODELS.push({ id: 'fx-c', reasoning: { param: 'openai', levels: ['low', 'medium', 'high'] }, maxOut: 1000 })
  try {
    await llm.complete('tok', 'fx-c', msgs, { reasoningEffort: 'high' })
    await llm.completeWithUsage('tok', 'fx-c', msgs, { reasoningEffort: 'high' })
    await llm.classifyIntent('tok', 'olá', { reasoningEffort: 'high' }).catch(() => {})
  } finally {
    globalThis.fetch = real
    MODELS.pop()
  }
  assert.ok(bodies.length >= 2)
  for (const b of bodies) assert.equal(JSON.stringify(b).includes('reasoning_effort') || 'thinking' in b, false)
})
