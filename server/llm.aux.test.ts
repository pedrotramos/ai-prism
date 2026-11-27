// Auxiliary fast-model calls (chat title, intent classifier, asset labels) run on
// Claude Haiku 5.5 (Haiku 4.5 is being retired). Contract per call:
//   - model is the single AUX_FAST_MODEL constant (haiku-5-5)
//   - no `temperature` (the catalog flags the model noTemperature)
//   - lowest reasoning effort the catalog supports, so tiny outputs are not eaten
//   - failures degrade: title -> trimmed-prompt fallback, intent -> null (regex)
//
//   node --test server/llm.aux.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABRICKS_HOST = 'https://gateway.invalid'
const llm = await import('./llm.ts')
const { detectCapabilities } = await import('./blocks.ts')
const { AUX_FAST_MODEL, INTENT_TIMEOUT_MS, generateTitle, classifyIntent, labelDesignAssets, MODELS } = llm

type Json = Record<string, unknown>

/** Runs `fn` against a stubbed fetch; returns the JSON bodies it sent. */
async function capture(reply: string, fn: () => Promise<unknown>): Promise<Json[]> {
  const real = globalThis.fetch
  const bodies: Json[] = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await fn()
  } finally {
    globalThis.fetch = real
  }
  return bodies
}

function assertAuxBody(body: Json | undefined, label: string) {
  assert.ok(body, `${label}: a request was sent`)
  assert.equal(body.model, 'databricks-claude-haiku-5-5', `${label}: model`)
  assert.equal('temperature' in body, false, `${label}: no temperature`)
  assert.deepEqual(body.output_config, { effort: 'low' }, `${label}: lowest effort`)
  assert.ok(Number(body.max_tokens) <= 1500, `${label}: small max_tokens`)
}

test('AUX_FAST_MODEL is Haiku 5.5, flagged noTemperature with an effort control', () => {
  assert.equal(AUX_FAST_MODEL, 'databricks-claude-haiku-5-5')
  const m = MODELS.find((x) => x.id === AUX_FAST_MODEL)
  assert.ok(m?.noTemperature && m.reasoning)
})

test('Haiku 4.5 stays in the catalog but is not default-on', () => {
  const m = MODELS.find((x) => x.id === 'databricks-claude-haiku-4-5')
  assert.ok(m, 'kept for users who already selected it')
  assert.equal(m.defaultOn, false)
})

test('title request: haiku-5-5, no temperature, low effort', async () => {
  const [b] = await capture('📊 Receita Q3', () => generateTitle('tok', 'qual a receita do Q3?'))
  assertAuxBody(b, 'title')
})

test('intent request: haiku-5-5, no temperature, low effort', async () => {
  const [b] = await capture('{"deck":true,"spreadsheet":false,"image":false,"document":false,"data":false', () => classifyIntent('tok', 'faça um deck'))
  assertAuxBody(b, 'intent')
})

test('asset label request: haiku-5-5, no temperature, low effort', async () => {
  const [b] = await capture('{"labels":{"a1":"cadeado"}}', () => labelDesignAssets('tok', [{ id: 'a1', kind: 'icon', dataUrl: 'data:image/png;base64,AAAA' }]))
  assertAuxBody(b, 'asset_label')
})

test('INTENT_MODEL (memory + ledger label) follows the aux model', () => {
  assert.equal(llm.INTENT_MODEL, AUX_FAST_MODEL)
})

test('classifier: default timeout is 4 s (first-token budget) and a hung gateway yields null (regex fallback)', async () => {
  assert.equal(INTENT_TIMEOUT_MS, 4000)
  const real = globalThis.fetch
  globalThis.fetch = (_url, init) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
  try {
    assert.equal(await classifyIntent('tok', 'faça um deck', { timeoutMs: 30 }), null)
  } finally {
    globalThis.fetch = real
  }
})

test('title fallback still works when the model errors', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('boom', { status: 500 })
  try {
    assert.equal(await generateTitle('tok', 'qual a receita   do Q3?'), '💬 qual a receita do Q3?')
  } finally {
    globalThis.fetch = real
  }
})

// Reasoning-only / empty content: the model spent the whole max_tokens on hidden
// thinking, so the visible content is '' (or only a thinking part).
const emptyReplies: [string, unknown][] = [
  ['empty string', ''],
  ['reasoning-only parts', [{ type: 'reasoning', text: 'pensando...' }]],
]
for (const [label, content] of emptyReplies) {
  test(`empty aux reply (${label}): title falls back, classifier returns null, regex still routes`, async () => {
    const real = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 40 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    try {
      assert.equal(await generateTitle('tok', 'Crie uma apresentação de vendas'), '💬 Crie uma apresentação de vendas')
      const intent = await classifyIntent('tok', 'Crie uma apresentação de vendas')
      assert.equal(intent, null)
      // the caller's fallback: the regex result, with no classifier
      const caps = detectCapabilities('Crie uma apresentação de vendas', [], { classifier: intent })
      assert.equal(caps.deck, true)
    } finally {
      globalThis.fetch = real
    }
  })
}
