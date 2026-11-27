// W3-7: per-turn reasoning effort in server/llm.js.
//   AC1 no effort → the gateway body is byte-identical to the pre-W3-7 body (fixture
//       captured from origin/main@c657646 for every chat model in the catalog)
//   AC2 with effort, the provider field exists only for models with the catalog flag
//   AC6 (server half) catalog blurbs stay pt-BR literals: the client localizes by id
//
//   node --test server/llm.reasoning.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.DATABRICKS_HOST = 'https://gateway.invalid'
const llm = await import('./llm.ts')
const { MODELS, streamChat, reasoningParams, parseReasoningEffort, REASONING_LEVELS } = llm
const baseline = JSON.parse(readFileSync(new URL('./__fixtures__/llm-default-bodies.json', import.meta.url), 'utf8'))

// the catalog's entry type (module-private in llm.ts); tests push partial fixtures
type Model = (typeof MODELS)[number]
const asModel = (m: object): Model => m as unknown as Model
const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
const tools = [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }]

/** Runs one streamChat against a stubbed fetch and returns the JSON body it sent. */
async function sentBody(model: string, opts: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const real = globalThis.fetch
  let body: Record<string, unknown> = {}
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body))
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

// The models the probe (docs/…, evidence in the PR) showed accept the control and validate it.
const FLAGGED: Record<string, string[]> = {
  anthropic: ['databricks-claude-sonnet-5-5', 'databricks-claude-opus-5-5', 'databricks-claude-haiku-5-5', 'databricks-claude-sonnet-5', 'databricks-claude-opus-5'],
  openai: [
    'databricks-gpt-6-1-sol', 'databricks-gpt-6-1-terra', 'databricks-gpt-6-luna', 'databricks-gpt-6-astra',
    'databricks-gpt-5-6-luna', 'databricks-gpt-5-6-terra', 'databricks-gpt-5-6-sol',
    'databricks-kimi-k3', 'databricks-glm-5-3', 'databricks-glm-5-3-flash', 'databricks-gemini-3-8-flash',
  ],
}
const flaggedIds = new Set(Object.values(FLAGGED).flat())

test('AC2: with an effort, the provider field appears exactly on the probed models and nowhere else', async () => {
  assert.deepEqual(new Set(chatModels.filter((m) => m.reasoning).map((m) => m.id)), flaggedIds)
  for (const [param, ids] of Object.entries(FLAGGED)) for (const id of ids) assert.equal(MODELS.find((m) => m.id === id)?.reasoning?.param, param, id)
  for (const m of chatModels) {
    const body = await sentBody(m.id, { reasoningEffort: 'high' })
    if (flaggedIds.has(m.id)) {
      const added = Object.keys(body).filter((k) => !(k in (baseline[m.id] as object)))
      const expected = m.reasoning?.param === 'anthropic' ? ['thinking', 'output_config'] : ['reasoning_effort']
      assert.deepEqual(added.sort(), expected.sort(), m.id)
      const { thinking, output_config, reasoning_effort, ...rest } = body
      assert.deepEqual(rest, baseline[m.id], `${m.id}: nothing else changes`)
    } else {
      assert.deepEqual(body, baseline[m.id], `${m.id}: unflagged models are untouched`)
    }
  }
})

test('parseReasoningEffort: absent/default are fine, only low|medium|high are levels, the rest is invalid', () => {
  assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high'])
  for (const v of [undefined, null, '', 'default']) assert.deepEqual(parseReasoningEffort(v), { ok: true, value: null }, String(v))
  for (const v of REASONING_LEVELS) assert.deepEqual(parseReasoningEffort(v), { ok: true, value: v })
  for (const v of ['max', 'HIGH', 3, true, {}, [], 'low ']) assert.equal(parseReasoningEffort(v).ok, false, JSON.stringify(v))
})

test('AC2: reasoningParams maps the flag shape per provider and is {} without the flag', () => {
  const withFlag = (param: string, id = 'x') => {
    const m = asModel({ id, reasoning: { param, levels: ['low', 'medium', 'high'] }, maxOut: 32768 })
    MODELS.push(m)
    return () => MODELS.splice(MODELS.indexOf(m), 1)
  }
  let undo = withFlag('openai', 'fx-openai')
  assert.deepEqual(reasoningParams('fx-openai', 'high'), { reasoning_effort: 'high' })
  assert.deepEqual(reasoningParams('fx-openai', 'low'), { reasoning_effort: 'low' })
  assert.deepEqual(reasoningParams('fx-openai', undefined as never), {})
  assert.deepEqual(reasoningParams('fx-openai', 'default'), {})
  undo()
  undo = withFlag('anthropic', 'fx-anthropic')
  assert.deepEqual(reasoningParams('fx-anthropic', 'medium'), { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } })
  undo()
  undo = withFlag('anthropic-budget', 'fx-anthropic-b')
  const a = reasoningParams('fx-anthropic-b', 'medium')
  type Thinking = { type: string; budget_tokens: number }
  const thinking = (o: Record<string, unknown>) => o.thinking as Thinking
  assert.equal(thinking(a).type, 'enabled')
  assert.ok(thinking(a).budget_tokens >= 1024 && thinking(a).budget_tokens < 32768)
  assert.ok(thinking(reasoningParams('fx-anthropic-b', 'high')).budget_tokens > thinking(reasoningParams('fx-anthropic-b', 'low')).budget_tokens)
  undo()
  undo = withFlag('gemini', 'fx-gemini')
  assert.deepEqual(Object.keys(reasoningParams('fx-gemini', 'low')), ['thinking_config'])
  undo()
  // not in the flag's levels → nothing
  MODELS.push(asModel({ id: 'fx-narrow', reasoning: { param: 'openai', levels: ['low', 'high'] } }))
  assert.deepEqual(reasoningParams('fx-narrow', 'medium'), {})
  assert.deepEqual(reasoningParams('fx-narrow', 'high'), { reasoning_effort: 'high' })
  MODELS.pop()
  // unknown (admin-added) ids and every catalog model today
  assert.deepEqual(reasoningParams('databricks-brand-new', 'high'), {})
  for (const m of chatModels.filter((x) => !flaggedIds.has(x.id))) assert.deepEqual(reasoningParams(m.id, 'high'), {}, m.id)
})

test('AC2: a flagged model gets the field in the streamed body; its neighbours do not', async () => {
  const flagged = asModel({ id: 'fx-flagged', label: 'fx', provider: 'OpenAI', streamUsage: true, noTemperature: true, tools: true, maxOut: 32768, reasoning: { param: 'openai', levels: ['low', 'medium', 'high'] } })
  const plain = asModel({ ...flagged, id: 'fx-plain', reasoning: undefined })
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

test('AC2: a plain gateway call carries no reasoning params; the auxiliary calls (title, intent) ask for the lowest level', async () => {
  const real = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: '{"deck":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  }
  MODELS.push(asModel({ id: 'fx-c', reasoning: { param: 'openai', levels: ['low', 'medium', 'high'] }, maxOut: 1000 }))
  try {
    await llm.complete('tok', 'fx-c', msgs)
    await llm.completeWithUsage('tok', 'fx-c', msgs)
    assert.equal(bodies.length, 2)
    for (const b of bodies) assert.equal(JSON.stringify(b).includes('reasoning_effort') || 'thinking' in b || 'output_config' in b, false)
    bodies.length = 0
    const intent = await llm.classifyIntent('tok', 'faça um deck', { model: 'fx-c' })
    assert.equal(intent?.model, 'fx-c')
    assert.equal(intent?.intents.deck, true)
    await llm.generateTitle('tok', 'faça um deck', 'ok', { model: 'fx-c' })
    assert.equal(bodies.length, 2)
    for (const b of bodies) {
      assert.equal(b.model, 'fx-c', 'the conversation model, not a fixed one')
      assert.equal(b.reasoning_effort, 'low')
      assert.ok((b.max_tokens as number) >= 512, 'headroom for the hidden thinking')
    }
  } finally {
    globalThis.fetch = real
    MODELS.pop()
  }
})
