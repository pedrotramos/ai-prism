// OpenJev intent router (router-design.md). Contract per piece:
//   - resolveRoutes is pure; fed the recorded live probabilities it reproduces the design's 19/21
//   - classifyIntentOpenJev never throws: any failure is null; one batched System One request per turn
//   - routeIntent: haiku = unchanged, shadow = never awaits OpenJev, race = OpenJev when confident
//   - an enabled tool or web search is never removed; the router only emits hints
//   - ledger kind intent_openjev (0.042 / 0 per 1M), never in the picker; telemetry without message text
// Perf-style assertions count operations (requests, aborts), never wall-clock ratios.
//
//   node --test server/intentRouter.test.ts
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

type Loose = any
process.env.DATABRICKS_HOST = 'https://gateway.invalid'
const router = await import('./intentRouter.ts')
const { resolveRoutes, resetIntentRouterForTests } = router
const routeIntent: (...a: Loose[]) => Promise<Loose> = router.routeIntent
const classifyIntentOpenJev: (...a: Loose[]) => Promise<Loose> = router.classifyIntentOpenJev
const llm = await import('./llm.ts')
const { setLogWriter } = await import('./log.ts')
const { resolvePrice } = await import('./serving.ts')

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))

const fx = (name: string) => new URL(`./__fixtures__/intentRouter/${name}`, import.meta.url)
const lines = (name: string) => readFileSync(fx(name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const items: Loose[] = lines('eval-set.jsonl')
const rx = new Map<number, Loose>(JSON.parse(readFileSync(fx('regex-baseline.json'), 'utf8')).map((r: Loose) => [r.id, r]))
const probs = new Map<number, Record<string, number>>(lines('results.jsonl').filter((r) => r.mode === 'openjev').map((r) => [r.id, r.answers]))

const ART = ['deck', 'document', 'spreadsheet', 'image']
const LEG = [...ART, 'data']
const regexOf = (id: number) => {
  const r = new Set<string>(rx.get(id)!.routes)
  return { deck: r.has('deck'), document: r.has('document'), spreadsheet: r.has('spreadsheet'), image: r.has('image'), data: r.has('data') }
}
const resolveItem = (it: Loose) => resolveRoutes({ probs: probs.get(it.id)!, regex: regexOf(it.id), previousArtifact: it.context || null })
const trueKeys = (o: object) => Object.entries(o).filter(([, v]) => v).map(([k]) => k).sort()
const legacyOk = (pred: string[], it: Loose) => {
  const req = new Set<string>(it.required.filter((x: string) => LEG.includes(x)))
  const acc = new Set<string>(it.acceptable.filter((x: string) => LEG.includes(x)))
  const p = new Set(pred)
  return [...req].every((x) => p.has(x)) && [...p].every((x) => req.has(x) || acc.has(x))
}

// ----------------------------------------------------------------------------- resolveRoutes

test('resolveRoutes reproduces the design on the recorded live probabilities: 19/21 gated items, 10/11 on the Haiku sample', () => {
  const gated = items.filter((it) => rx.get(it.id)!.gate)
  assert.equal(gated.length, 21)
  const good = gated.filter((it) => legacyOk(trueKeys(resolveItem(it).intents), it))
  assert.equal(good.length, 19)
  const missed = gated.filter((it) => !good.includes(it)).map((it) => it.id)
  assert.deepEqual(missed, [12, 22])
  const sample = gated.filter((it) => it.haiku)
  assert.equal(sample.length, 11)
  assert.equal(sample.filter((it) => legacyOk(trueKeys(resolveItem(it).intents), it)).length, 10)
})

test('resolveRoutes: exactly the design uncertainty band escalates (10 of 21), and it catches both misses', () => {
  const gated = items.filter((it) => rx.get(it.id)!.gate)
  const unsure = gated.filter((it) => !resolveItem(it).confident).map((it) => it.id)
  assert.deepEqual(unsure, [1, 2, 5, 12, 15, 22, 25, 29, 30, 38])
  for (const id of [12, 22]) assert.ok(unsure.includes(id), `miss #${id} is escalated`)
})

test('resolveRoutes rules, one by one', () => {
  const base = { deck: 0, document: 0, spreadsheet: 0, image: 0, web: 0, data: 0 }
  const none = { deck: false, document: false, spreadsheet: false, image: false, data: false }
  const run = (p: Record<string, number>, regex = {}) => resolveRoutes({ probs: { ...base, ...p }, regex: { ...none, ...regex }, previousArtifact: null })
  // top artifact at >= 0.5; a second one needs >= 0.85, or >= 0.5 with the regex agreeing
  assert.deepEqual(trueKeys(run({ deck: 0.5 }).intents), ['deck'])
  assert.deepEqual(trueKeys(run({ deck: 0.49 }).intents), [])
  assert.deepEqual(trueKeys(run({ deck: 0.9, spreadsheet: 0.6 }).intents), ['deck'])
  assert.deepEqual(trueKeys(run({ deck: 0.9, spreadsheet: 0.85 }).intents), ['deck', 'spreadsheet'])
  assert.deepEqual(trueKeys(run({ deck: 0.9, spreadsheet: 0.6 }, { spreadsheet: true }).intents), ['deck', 'spreadsheet'])
  // regex rescue: an artifact the regex flagged survives down to 0.2
  assert.deepEqual(trueKeys(run({ deck: 0.2 }, { deck: true }).intents), ['deck'])
  assert.deepEqual(trueKeys(run({ deck: 0.19 }, { deck: true }).intents), [])
  // data at >= 0.5 only
  assert.equal(run({ data: 0.5 }).intents.data, true)
  assert.equal(run({ data: 0.49 }).intents.data, false)
  // confidence: false inside [0.35, 0.65) for any artifact or data, or when regex and rules differ
  assert.equal(run({ deck: 0.95 }, { deck: true }).confident, true)
  assert.equal(run({ deck: 0.64 }, { deck: true }).confident, false)
  assert.equal(run({ deck: 0.35 }).confident, false)
  assert.equal(run({ deck: 0.34 }).confident, true)
  assert.equal(run({ data: 0.5 }).confident, false)
  assert.equal(run({ deck: 0.95 }, { document: true }).confident, false)
  // web is a hint at >= 0.85, tools a hint at >= 0.5 (ids without the tool_ prefix); never a gate
  assert.equal(run({ web: 0.85 }).webHint, true)
  assert.equal(run({ web: 0.84 }).webHint, false)
  assert.deepEqual(run({ tool_jira: 0.5, tool_slack: 0.49 } as Loose).toolHints, ['jira'])
})

test('resolveRoutes is pure: same input, same output, input untouched', () => {
  const input = { probs: { ...probs.get(22)! }, regex: regexOf(22), previousArtifact: null }
  const frozen = JSON.stringify(input)
  assert.deepEqual(resolveRoutes(input), resolveRoutes(input))
  assert.equal(JSON.stringify(input), frozen)
})

// ----------------------------------------------------------------------------- classifyIntentOpenJev

const QUIET = { deck: 0.02, document: 0.02, spreadsheet: 0.02, image: 0.02, web: 0.02, data: 0.02 }
const sysOne = (p: Record<string, number>, extra: Loose = {}) =>
  new Response(JSON.stringify({ model: 'databricks-openjev-qwen35-4b', answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { noul: v }])), usage: { input_tokens: 1050, output_tokens: 0 }, ...extra }), { status: 200 })
const haikuReply = (json: string) => new Response(JSON.stringify({ choices: [{ message: { content: json } }], usage: { prompt_tokens: 40, completion_tokens: 9 } }), { status: 200 })
const HAIKU_DOC = '{"deck":false,"spreadsheet":false,"image":false,"document":true,"data":false'

interface Call { url: string; body: Loose; signal?: AbortSignal | null }
/** Stubs fetch for the test: route(url, call) answers each request; every request is recorded. */
function stubFetch(route: (kind: 'openjev' | 'haiku', call: Call) => Response | Promise<Response>) {
  const real = globalThis.fetch
  const calls: { openjev: Loose[]; haiku: Loose[] } = { openjev: [], haiku: [] }
  globalThis.fetch = (async (url: Loose, init: Loose) => {
    const kind = String(url).includes('/ai-gateway/typesafe/v1/systemone') ? 'openjev' : 'haiku'
    const call = { url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal }
    calls[kind].push(call)
    return route(kind, call)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}
/** A response that never arrives until the request's signal aborts (then rejects, like fetch). */
const hang = (call: Call) =>
  new Promise<Response>((_, reject) => call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))

beforeEach(() => {
  resetIntentRouterForTests()
  exporter.reset()
  delete process.env.INTENT_ROUTER
  delete process.env.INTENT_OPENJEV_ENDPOINT
})

test('classifyIntentOpenJev: one batched System One request, one noul per route and per enabled tool', async () => {
  const gw = stubFetch(() => sysOne({ ...QUIET, tool_jira: 0.9, tool_fx_rates: 0.1 }))
  try {
    const out = await classifyIntentOpenJev('tok', 'abra um ticket', {
      previousArtifact: 'deck',
      enabledTools: [
        { id: 'jira', name: 'Jira', description: 'search and create issues' },
        { id: 'FX-Rates', name: 'Câmbio', description: 'converts currencies\nat today rate' },
      ],
    })
    assert.equal(gw.calls.openjev.length, 1)
    const { url, body } = gw.calls.openjev[0]
    assert.equal(url, 'https://gateway.invalid/ai-gateway/typesafe/v1/systemone')
    assert.equal(body.model, 'system.ai.openjev-qwen35-4b')
    assert.deepEqual(body.state, { message: 'abra um ticket', previous_artifact: 'deck' })
    assert.deepEqual(Object.keys(body.questions), ['deck', 'document', 'spreadsheet', 'image', 'web', 'data', 'tool_jira', 'tool_fx_rates'])
    for (const q of Object.values<Loose>(body.questions)) {
      assert.equal(q.type, 'noul')
      assert.ok(q.instructions && q.criteria.true && q.criteria.false)
    }
    assert.match(body.questions.tool_fx_rates.instructions, /Tool: Câmbio: converts currencies at today rate/)
    assert.equal(/usage_context/.test(JSON.stringify(body)), false, 'System One is not sent usage_context (not confirmed to accept it)')
    assert.equal(out!.probs.tool_jira, 0.9)
    assert.deepEqual(out!.usage, { input_tokens: 1050, output_tokens: 0 })
    assert.equal(out!.model, 'databricks-openjev-qwen35-4b')
  } finally {
    gw.restore()
  }
})

test('classifyIntentOpenJev: the message is cut at 6000 chars and previous_artifact defaults to none', async () => {
  const gw = stubFetch(() => sysOne(QUIET))
  try {
    await classifyIntentOpenJev('tok', 'x'.repeat(7000))
    assert.equal(gw.calls.openjev[0].body.state.message.length, 6000)
    assert.equal(gw.calls.openjev[0].body.state.previous_artifact, 'none')
  } finally {
    gw.restore()
  }
})

test('classifyIntentOpenJev: INTENT_OPENJEV_ENDPOINT picks the model', async () => {
  process.env.INTENT_OPENJEV_ENDPOINT = 'main.custom.openjev'
  const gw = stubFetch(() => sysOne(QUIET))
  try {
    await classifyIntentOpenJev('tok', 'oi')
    assert.equal(gw.calls.openjev[0].body.model, 'main.custom.openjev')
  } finally {
    gw.restore()
  }
})

test('classifyIntentOpenJev never throws: 422, 5xx, invalid JSON, no answers, a fetch error and a timeout are all null', async () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['422', () => new Response('{"error_code":"INVALID_PARAMETER_VALUE"}', { status: 422 })],
    ['503', () => new Response('{}', { status: 503 })],
    ['invalid json', () => new Response('<html>', { status: 200 })],
    ['no answers', () => new Response('{"usage":{}}', { status: 200 })],
    ['answers without noul', () => new Response('{"answers":{"deck":{}}}', { status: 200 })],
    ['fetch rejects', () => Promise.reject(new TypeError('socket hang up'))],
  ]
  for (const [name, reply] of cases) {
    const gw = stubFetch(reply)
    try {
      assert.equal(await classifyIntentOpenJev('tok', 'faça um deck'), null, name)
    } finally {
      gw.restore()
    }
  }
  const gw = stubFetch((_k, call) => hang(call))
  try {
    assert.equal(await classifyIntentOpenJev('tok', 'faça um deck', { timeoutMs: 20 }), null, 'timeout')
    const ac = new AbortController()
    const run = classifyIntentOpenJev('tok', 'faça um deck', { signal: ac.signal })
    ac.abort()
    assert.equal(await run, null, 'the turn signal cancels it')
  } finally {
    gw.restore()
  }
})

test('classifyIntentOpenJev reports the ledger kind intent_openjev (input only) and prices it 0.042 / 0 per 1M', async () => {
  const rows: Loose[] = []
  llm.setUsageSink((kind: string, model: string, usage: Loose) => { rows.push({ kind, model, usage }); return 0 })
  const gw = stubFetch(() => sysOne(QUIET))
  try {
    await classifyIntentOpenJev('tok', 'oi')
  } finally {
    gw.restore()
    llm.setUsageSink(null)
  }
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'intent_openjev')
  assert.equal(rows[0].model, 'system.ai.openjev-qwen35-4b')
  assert.deepEqual([rows[0].usage.prompt_tokens, rows[0].usage.completion_tokens], [1050, 0])
  assert.deepEqual(resolvePrice('system.ai.openjev-qwen35-4b'), { in: 0.042, out: 0 })
  assert.deepEqual(resolvePrice('databricks-openjev-qwen35-4b'), { in: 0.042, out: 0 })
})

test('the OpenJev endpoints are never in the model picker (not a chat task)', () => {
  assert.equal(llm.MODELS.some((m: Loose) => /openjev/i.test(m.id)), false)
})

// ----------------------------------------------------------------------------- routeIntent

const REQ = { token: 'tok', email: 'u@example.com' }
const DOC_TEXT = 'Escreva um relatório sobre a expansão de 2027'
const history: Loose[] = []
const keysOf = (r: Loose) => trueKeys(r.intents)

test('INTENT_ROUTER=haiku is the opt-out: Haiku alone, OpenJev never called', async () => {
  process.env.INTENT_ROUTER = 'haiku'
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : sysOne(QUIET)))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.deepEqual(keysOf(out), ['document'])
    assert.equal(gw.calls.openjev.length, 0)
    assert.equal(gw.calls.haiku.length, 1)
    assert.ok(out.usage, 'the Haiku usage is kept for the cost disclosure')
  } finally {
    gw.restore()
  }
})

test('the default (nothing set) is race with the standard endpoint: OpenJev confident decides and Haiku is aborted', async () => {
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? hang(call) : sysOne({ ...QUIET, document: 0.96 })))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.equal(out.source, 'openjev')
    assert.equal(gw.calls.openjev.length, 1)
    assert.equal(gw.calls.openjev[0].body.model, 'system.ai.openjev-qwen35-4b')
    assert.equal(gw.calls.haiku[0].signal?.aborted, true)
  } finally {
    gw.restore()
  }
})

test('the default with the endpoint missing from the workspace (404): Haiku, one log line, then no more OpenJev calls', async () => {
  const logged: string[] = []
  const prev = setLogWriter((l: string) => logged.push(l))
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : new Response('{"error_code":"RESOURCE_DOES_NOT_EXIST"}', { status: 404 })))
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(keysOf(await routeIntent(REQ, DOC_TEXT, history, {}, undefined)), ['document'])
    assert.equal(gw.calls.openjev.length, 1)
    assert.equal(logged.filter((l) => /openjev/i.test(l)).length, 1)
  } finally {
    gw.restore()
    setLogWriter(prev)
  }
})

test('routeIntent: an unknown INTENT_ROUTER value is haiku', async () => {
  process.env.INTENT_ROUTER = 'openjev-only'
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : sysOne(QUIET)))
  try {
    await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.equal(gw.calls.openjev.length, 0)
  } finally {
    gw.restore()
  }
})

test('shadow: resolves with the Haiku verdict while OpenJev is still pending (no await on its path), then logs the event', async () => {
  process.env.INTENT_ROUTER = 'shadow'
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : hang(call)))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.deepEqual(keysOf(out), ['document'])
    assert.equal(gw.calls.openjev.length, 1, 'OpenJev was started in parallel')
    assert.equal(gw.calls.openjev[0].signal?.aborted, false, 'and is still running when the turn goes on')
    assert.equal(exporter.getFinishedSpans().filter((s) => s.name === 'intent_router').length, 0, 'the event waits for OpenJev')
  } finally {
    // let the 1.5 s OpenJev timeout fire so nothing leaks out of the test
    await new Promise((r) => setTimeout(r, 1700))
    gw.restore()
  }
  const ev: Loose[] = exporter.getFinishedSpans().filter((s) => s.name === 'intent_router')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].attributes.mode, 'shadow')
  assert.equal(ev[0].attributes.chosen_source, 'haiku')
})

test('shadow: the verdict is the Haiku one even when OpenJev disagrees and is confident', async () => {
  process.env.INTENT_ROUTER = 'shadow'
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : sysOne({ ...QUIET, deck: 0.97 })))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.deepEqual(keysOf(out), ['document'])
  } finally {
    gw.restore()
  }
})

test('race, OpenJev confident: decides from the rules, aborts Haiku, no Haiku wait', async () => {
  process.env.INTENT_ROUTER = 'race'
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? hang(call) : sysOne({ ...QUIET, document: 0.96 })))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.deepEqual(keysOf(out), ['document'])
    assert.equal(gw.calls.openjev.length, 1)
    assert.equal(gw.calls.haiku.length, 1, 'both were started at t0')
    assert.equal(gw.calls.haiku[0].signal?.aborted, true, 'the Haiku request was aborted')
    assert.equal(out.usage, null, 'OpenJev spend is in the ledger (intent_openjev), not in the Haiku disclosure')
    assert.equal(out.source, 'openjev')
  } finally {
    gw.restore()
  }
})

test('race, OpenJev unsure: the Haiku verdict wins (and Haiku is not aborted)', async () => {
  process.env.INTENT_ROUTER = 'race'
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply('{"deck":true,"spreadsheet":false,"image":false,"document":false,"data":false') : sysOne({ ...QUIET, deck: 0.5, document: 0.5 })))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.deepEqual(keysOf(out), ['deck'])
    assert.equal(gw.calls.haiku[0].signal?.aborted, false)
    assert.equal(out.source, 'haiku')
  } finally {
    gw.restore()
  }
})

test('race, OpenJev fails (422): Haiku decides; both fail: null so the regexes decide', async () => {
  process.env.INTENT_ROUTER = 'race'
  let gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : new Response('{}', { status: 422 })))
  try {
    assert.deepEqual(keysOf(await routeIntent(REQ, DOC_TEXT, history, {}, undefined)), ['document'])
  } finally {
    gw.restore()
  }
  gw = stubFetch((kind) => (kind === 'haiku' ? new Response('{}', { status: 503 }) : new Response('{}', { status: 503 })))
  try {
    assert.equal(await routeIntent(REQ, DOC_TEXT, history, {}, undefined), null)
  } finally {
    gw.restore()
  }
})

test('OpenJev failures log one structured warn per kind (no message text), rate-limited, and the turn still gets the Haiku verdict', async () => {
  process.env.INTENT_ROUTER = 'race'
  const logged: string[] = []
  const prev = setLogWriter((l: string) => logged.push(l))
  const secret = 'SEGREDO-QWE-987'
  const text = `Escreva um relatório ${secret}`
  const lines = () => logged.filter((l) => /intent router/i.test(l))
  let gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : new Response('{}', { status: 503 })))
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(keysOf(await routeIntent(REQ, text, history, {}, undefined)), ['document'])
    assert.equal(lines().length, 1, 'HTTP 503: once, not per turn')
    assert.match(lines()[0]!, /503/)
    assert.equal(logged.join('\n').includes('SEGREDO'), false, 'no message text in the log')
    gw.restore()
    // another kind logs on its own
    gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : new Response('<html>', { status: 200 })))
    await routeIntent(REQ, text, history, {}, undefined)
    assert.equal(lines().length, 2, 'invalid response is its own kind')
    gw.restore()
    gw = stubFetch((_k, call) => hang(call))
    assert.equal(await classifyIntentOpenJev('tok', text, { timeoutMs: 20 }), null)
    assert.equal(lines().length, 3, 'timeout is its own kind')
    assert.match(lines()[2]!, /timeout/i)
    gw.restore()
    gw = stubFetch(() => Promise.reject(new TypeError('socket hang up')))
    assert.equal(await classifyIntentOpenJev('tok', text), null)
    assert.equal(lines().length, 4, 'network error is its own kind')
    gw.restore()
    // a client cancel is not an OpenJev failure
    gw = stubFetch((_k, call) => hang(call))
    const ac = new AbortController()
    const run = classifyIntentOpenJev('tok', text, { signal: ac.signal })
    ac.abort()
    await run
    assert.equal(lines().length, 4, 'a cancelled turn logs nothing')
  } finally {
    gw.restore()
    setLogWriter(prev)
  }
})

test('race, Haiku first with a verdict: returns it without waiting for OpenJev', async () => {
  process.env.INTENT_ROUTER = 'race'
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : hang(call)))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, {}, undefined)
    assert.deepEqual(keysOf(out), ['document'])
    assert.equal(out.source, 'haiku')
  } finally {
    await new Promise((r) => setTimeout(r, 1700))
    gw.restore()
  }
})

test('race: the turn signal cancels both requests', async () => {
  process.env.INTENT_ROUTER = 'race'
  const gw = stubFetch((_k, call) => hang(call))
  try {
    const ac = new AbortController()
    const run = routeIntent(REQ, DOC_TEXT, history, {}, ac.signal)
    ac.abort()
    assert.equal(await run, null)
    assert.equal(gw.calls.openjev[0].signal?.aborted, true)
    assert.equal(gw.calls.haiku[0].signal?.aborted, true)
  } finally {
    gw.restore()
  }
})

test('tools and web search are never removed: the verdict has no tool/web gate, only hints', async () => {
  process.env.INTENT_ROUTER = 'race'
  const refs = [{ kind: 'mcp-external', connectionName: 'jira', comment: 'Jira issues' }, { kind: 'mcp-external', connectionName: 'slack', comment: 'Slack channels' }]
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? hang(call) : sysOne({ ...QUIET, document: 0.96, tool_jira: 0, tool_slack: 0 })))
  try {
    const out = await routeIntent(REQ, DOC_TEXT, history, { enabledToolRefs: refs }, undefined)
    assert.deepEqual(Object.keys(out.intents).sort(), ['data', 'deck', 'document', 'image', 'spreadsheet'])
    assert.deepEqual(out.hints.toolHints, [])
    assert.equal(out.hints.webHint, false)
    for (const k of Object.keys(out)) assert.ok(['intents', 'usage', 'source', 'hints'].includes(k), `unexpected key ${k}`)
    // one question per enabled tool went out
    assert.ok('tool_jira' in gw.calls.openjev[0].body.questions && 'tool_slack' in gw.calls.openjev[0].body.questions)
  } finally {
    gw.restore()
  }
})

test('tool hints map back to the original tool ids', async () => {
  process.env.INTENT_ROUTER = 'race'
  const refs = [{ kind: 'mcp-external', connectionName: 'Jira-Prod', comment: 'Jira issues' }]
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? hang(call) : sysOne({ ...QUIET, tool_jira_prod: 0.97, web: 0.9 })))
  try {
    const out = await routeIntent(REQ, 'abra um ticket no Jira-Prod e busque o câmbio de hoje', history, { enabledToolRefs: refs }, undefined)
    assert.deepEqual(out.hints.toolHints, ['Jira-Prod'])
    assert.equal(out.hints.webHint, true)
  } finally {
    gw.restore()
  }
})

test('INTENT_ROUTER=race with the endpoint disabled (empty INTENT_OPENJEV_ENDPOINT): haiku, one log line, no OpenJev calls', async () => {
  process.env.INTENT_ROUTER = 'race'
  process.env.INTENT_OPENJEV_ENDPOINT = ''
  const logged: string[] = []
  const prev = setLogWriter((l: string) => logged.push(l))
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : sysOne(QUIET)))
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(keysOf(await routeIntent(REQ, DOC_TEXT, history, {}, undefined)), ['document'])
    assert.equal(gw.calls.openjev.length, 0)
    assert.equal(gw.calls.haiku.length, 3)
    assert.equal(logged.filter((l) => /openjev/i.test(l)).length, 1, 'logged once')
  } finally {
    gw.restore()
    setLogWriter(prev)
  }
})

test('an endpoint that does not exist in the workspace (404) falls back to haiku, logs once and stops calling it', async () => {
  process.env.INTENT_ROUTER = 'race'
  const logged: string[] = []
  const prev = setLogWriter((l: string) => logged.push(l))
  const gw = stubFetch((kind) => (kind === 'haiku' ? haikuReply(HAIKU_DOC) : new Response('{"error_code":"RESOURCE_DOES_NOT_EXIST"}', { status: 404 })))
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(keysOf(await routeIntent(REQ, DOC_TEXT, history, {}, undefined)), ['document'])
    assert.equal(gw.calls.openjev.length, 1, 'only the first turn probed it')
    assert.equal(logged.filter((l) => /openjev/i.test(l)).length, 1, 'logged once')
  } finally {
    gw.restore()
    setLogWriter(prev)
  }
})

test('telemetry: one intent_router event with decisions and probabilities, never the message text', async () => {
  process.env.INTENT_ROUTER = 'race'
  const secret = 'SEGREDO-ZYX-12345 relatório'
  const gw = stubFetch((kind, call) => (kind === 'haiku' ? hang(call) : sysOne({ ...QUIET, document: 0.96 })))
  try {
    await routeIntent(REQ, `Escreva um ${secret}`, history, {}, undefined)
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    gw.restore()
  }
  const ev: Loose[] = exporter.getFinishedSpans().filter((s) => s.name === 'intent_router')
  assert.equal(ev.length, 1)
  const a = ev[0]!.attributes
  assert.equal(a.mode, 'race')
  assert.equal(a.gate, true)
  assert.equal(a.chosen_source, 'openjev')
  assert.equal(a.confident, true)
  assert.ok(typeof a.ms_openjev === 'number')
  assert.equal(JSON.parse(String(a!.openjev_probs)).document, 0.96)
  assert.deepEqual(JSON.parse(String(a.resolved)), { deck: false, spreadsheet: false, image: false, document: true, data: false })
  for (const k of ['regex', 'haiku']) assert.ok(k in a, k)
  assert.equal(JSON.stringify(ev[0].attributes).includes('SEGREDO'), false)
})
