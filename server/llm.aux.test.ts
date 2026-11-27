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
  const [b] = await capture('Receita Q3', () => generateTitle('tok', 'qual a receita do Q3?'))
  assertAuxBody(b, 'title')
})

test('title prompt asks for a professional emoji-free title (sentence case, 3 to 6 words)', async () => {
  const [b] = await capture('Receita do Q3', () => generateTitle('tok', 'qual a receita do Q3?'))
  const sys = String(((b as Json).messages as { content: string }[])[0]!.content)
  assert.doesNotMatch(sys, /EXACTLY one emoji/i)
  assert.match(sys, /no emoji/i)
  assert.match(sys, /sentence case/i)
  assert.match(sys, /3 to 6 word/)
  assert.match(sys, /no quotes/i)
  assert.match(sys, /trailing (punctuation|period)/i)
})

const titleCases: [string, string, string][] = [
  ['leading emoji', '📊 Receita do Q3 por região', 'Receita do Q3 por região'],
  ['emoji with variation selector / ZWJ', '👩‍💻 Revisão de código Python', 'Revisão de código Python'],
  ['several leading emoji', '📈✨ Métricas de churn', 'Métricas de churn'],
  ['emoji inside the text', 'Receita 📊 do Q3', 'Receita do Q3'],
  ['wrapping quotes', '"Plano de migração Lakebase"', 'Plano de migração Lakebase'],
  ['curly quotes', '“Plano de migração”', 'Plano de migração'],
  ['trailing period', 'Plano de migração.', 'Plano de migração'],
  ['emoji + quotes + period', '🚀 "Plano de migração".', 'Plano de migração'],
  ['extra whitespace', '  Plano   de\tmigração  ', 'Plano de migração'],
  ['second line dropped', 'Plano de migração\nExplicação extra', 'Plano de migração'],
]
for (const [label, reply, want] of titleCases) {
  test(`title sanitizer: ${label}`, async () => {
    let got = ''
    await capture(reply, async () => {
      got = await generateTitle('tok', 'qual o plano de migração?')
    })
    assert.equal(got, want)
  })
}

test('title sanitizer: emoji-only reply falls back to the trimmed prompt, no emoji', async () => {
  let got = ''
  await capture('📊✨', async () => {
    got = await generateTitle('tok', 'qual a receita   do Q3?')
  })
  assert.equal(got, 'qual a receita do Q3?')
})

test('title sanitizer: keycap emoji-only reply falls back to a usable prompt title', async () => {
  let got = ''
  await capture('1\uFE0F\u20E3', async () => {
    got = await generateTitle('tok', 'Compare 2025 Q4 revenue')
  })
  assert.equal(got, 'Compare 2025 Q4 revenue')
})

test('title sanitizer: a reply with no letter (digits/symbols only) falls back to the prompt', async () => {
  let got = ''
  await capture('2025 - 2026', async () => {
    got = await generateTitle('tok', 'Compare revenue by year')
  })
  assert.equal(got, 'Compare revenue by year')
})

test('title sanitizer: a numeric prompt still yields a title via the fallback', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('boom', { status: 500 })
  try {
    assert.equal(await generateTitle('tok', '2025'), '2025')
  } finally {
    globalThis.fetch = real
  }
})

const quoteCases: [string, string, string][] = [
  ['Japanese corner quotes', '「売上分析」', '売上分析'],
  ['white corner quotes', '『売上分析』', '売上分析'],
  ['guillemets', '«Plano de migração»', 'Plano de migração'],
  ['low-9 / curly pair', '„Plan der Migration“', 'Plan der Migration'],
  ['single guillemets', '‹Plano de migração›', 'Plano de migração'],
  ['ideographic full stop after corner quote', '「売上分析」。', '売上分析'],
  ['keycap inside text', 'Top 3\uFE0F\u20E3 clientes', 'Top clientes'],
  ['flag emoji', '🇧🇷 Vendas no Brasil', 'Vendas no Brasil'],
  ['skin tone emoji', '👋🏽 Boas-vindas ao time', 'Boas-vindas ao time'],
  ['VS16 heart', '❤\uFE0F Campanha de retenção', 'Campanha de retenção'],
]
for (const [label, reply, want] of quoteCases) {
  test(`title sanitizer: ${label}`, async () => {
    let got = ''
    await capture(reply, async () => {
      got = await generateTitle('tok', 'qual o plano?')
    })
    assert.equal(got, want)
  })
}

test('title fallback: empty prompt gives a plain "Nova conversa"', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('boom', { status: 500 })
  try {
    assert.equal(await generateTitle('tok', '   '), 'Nova conversa')
  } finally {
    globalThis.fetch = real
  }
})

test('intent request: haiku-5-5, no temperature, low effort', async () => {
  const [b] = await capture('{"deck":true,"spreadsheet":false,"image":false,"document":false,"data":false', () => classifyIntent('tok', 'faça um deck'))
  assertAuxBody(b, 'intent')
})

test('intent request budget: max_tokens 150 (hidden reasoning ate 60); the title budget is unchanged at 40', async () => {
  const [b] = await capture('{"deck":true,"spreadsheet":false,"image":false,"document":false,"data":false', () => classifyIntent('tok', 'faça um deck'))
  assert.equal(b?.max_tokens, 150)
  const [t] = await capture('Receita Q3', () => generateTitle('tok', 'qual a receita do Q3?'))
  assert.equal(t?.max_tokens, 40)
})

test('intent: finish_reason length with empty content falls back cleanly (null, no throw)', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 400, completion_tokens: 150 } }), { status: 200 })
  try {
    assert.equal(await classifyIntent('tok', 'faça um deck'), null)
  } finally {
    globalThis.fetch = real
  }
})

test('intent: finish_reason length with partial JSON falls back cleanly (null), even when it looks valid', async () => {
  const real = globalThis.fetch
  try {
    for (const content of ['{"deck":true,"spreadsheet":false', '{"deck":true,"spreadsheet":false,"image":false,"document":false,"data":false']) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'length' }], usage: { prompt_tokens: 400, completion_tokens: 150 } }), { status: 200 })
      assert.equal(await classifyIntent('tok', 'faça um deck'), null, content)
    }
    // a normal stop (the gateway strips the "}" stop sequence) is still parsed
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"deck":true,"spreadsheet":false,"image":false,"document":false,"data":false' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    assert.equal((await classifyIntent('tok', 'faça um deck'))?.intents.deck, true)
  } finally {
    globalThis.fetch = real
  }
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
    assert.equal(await generateTitle('tok', 'qual a receita   do Q3?'), 'qual a receita do Q3?')
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
      assert.equal(await generateTitle('tok', 'Crie uma apresentação de vendas'), 'Crie uma apresentação de vendas')
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
