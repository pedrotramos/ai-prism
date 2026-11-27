// Image generation through a Unity Catalog Model Provider Service (Gemini native route on the AI
// Gateway), next to the serving-endpoint path: the request (URL, headers, request tags header, inline
// images), the response and usage parsing, the error shape, and the id grammar.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABRICKS_HOST = 'https://gateway.invalid'
process.env.AI_PRISM_RESOURCE_TAGS = JSON.stringify({ cost_center: '1234', area: 'Finanças', ai_prism_app: 'ai-prism' })
const llm = await import('./llm.ts')
const { aiGatewayRequestTags, AI_GATEWAY_REQUEST_TAGS_HEADER, resetResourceTagsCache } = await import('./resourceTags.ts')
const { withUsageTags } = await import('./usageTags.ts')
resetResourceTagsCache()

const PROVIDER = 'main.external_models.gemini_models'
const ref = { provider: PROVIDER, model: 'gemini-3.1-flash-image' }
const PNG = 'data:image/png;base64,iVBORw0KGgo='

test('id grammar: serving endpoint names, provider names, targets and the derived id', () => {
  assert.ok(llm.isServingEndpointName('databricks-gemini-3-1-flash-image'))
  assert.ok(!llm.isServingEndpointName('a/b') && !llm.isServingEndpointName('-x') && !llm.isServingEndpointName('a.b'))
  assert.ok(llm.isModelProviderServiceName(PROVIDER))
  assert.ok(!llm.isModelProviderServiceName('two.parts') && !llm.isModelProviderServiceName('a.b.c.d') && !llm.isModelProviderServiceName('a.b-c.d'))
  assert.ok(llm.isProviderTargetName('gemini-3.1-flash-image'))
  assert.ok(!llm.isProviderTargetName('a..b') && !llm.isProviderTargetName('../x') && !llm.isProviderTargetName('.a'))
  const id = llm.providerImageModelId(PROVIDER, 'gemini-3.1-flash-image')
  assert.equal(id, `${PROVIDER}/gemini-3.1-flash-image`)
  assert.deepEqual(llm.parseProviderImageModelId(id), ref)
  assert.equal(llm.parseProviderImageModelId('databricks-gemini-3-1-flash-image'), null)
  assert.equal(llm.parseProviderImageModelId(`${id}/extra`), null)
  assert.ok(llm.isImageModelId(id) && llm.isImageModelId('ep-1') && !llm.isImageModelId('a b'))
})

test('buildProviderImageRequest: native Gemini route, provider header, tags header, inline base images', () => {
  const { url, init } = llm.buildProviderImageRequest('tok', ref, { prompt: 'a red cube', baseImages: [PNG, 'not an image', 'data:image/JPEG;base64,/9j/4A=='] })
  assert.equal(url, 'https://gateway.invalid/ai-gateway/gemini/v1beta/models/gemini-3.1-flash-image:generateContent')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.headers[llm.MODEL_PROVIDER_SERVICE_HEADER], PROVIDER)
  const body = JSON.parse(init.body)
  assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE', 'TEXT'] })
  assert.deepEqual(body.contents[0].parts, [
    { text: 'a red cube' },
    { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
    { inlineData: { mimeType: 'image/jpeg', data: '/9j/4A==' } },
  ])
  assert.equal('usage_context' in body, false, 'the provider body takes no usage_context')
  // the target never escapes the path
  assert.match(llm.buildProviderImageRequest('t', { provider: PROVIDER, model: 'a.b' }, {}).url, /models\/a\.b:generateContent$/)
})

test('request tags header: the usage_context tags as ASCII JSON, application last, the run tags added', () => {
  const header = llm.buildProviderImageRequest('tok', ref, { prompt: 'x' }).init.headers[AI_GATEWAY_REQUEST_TAGS_HEADER]!
  assert.equal(AI_GATEWAY_REQUEST_TAGS_HEADER, 'Databricks-Ai-Gateway-Request-Tags')
  assert.match(header, /^[\x20-\x7e]*$/, 'ASCII only: a Latin-1 letter would make fetch throw')
  const tags = JSON.parse(header)
  assert.equal(tags.application, 'ai-prism')
  assert.equal(tags.cost_center, '1234')
  assert.equal(tags.area, 'Finanças', 'the \\u escape decodes back to the letter')
  assert.equal(tags.ai_prism_app, 'ai-prism')
  for (const v of Object.values(tags)) assert.equal(typeof v, 'string')
  // an unattended run adds its own tags to the header, like it does to usage_context
  const run = withUsageTags({ ai_prism_run_kind: 'agent', ai_prism_agent_id: '7' }, () => llm.buildProviderImageRequest('tok', ref, {}).init.headers[AI_GATEWAY_REQUEST_TAGS_HEADER]!)
  assert.deepEqual(JSON.parse(run), { ...tags, ai_prism_run_kind: 'agent', ai_prism_agent_id: '7' })
  assert.deepEqual(JSON.parse(aiGatewayRequestTags()), tags)
  assert.equal(JSON.parse(aiGatewayRequestTags({ x: 'é€' })).x, 'é€')
})

test('parseProviderImageResponse: the last non-thought image and the text', () => {
  const r = llm.parseProviderImageResponse({
    candidates: [{ content: { parts: [
      { text: 'draft', thought: true },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' }, thought: true },
      { text: 'Here you go. ' },
      { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
      { inlineData: { mimeType: 'audio/wav', data: 'CCCC' } },
    ] } }],
  })
  assert.deepEqual(r, { dataUrls: ['data:image/png;base64,BBBB'], text: 'Here you go. ' })
  assert.deepEqual(llm.parseProviderImageResponse({}), { dataUrls: [], text: '' })
})

test('providerImageUsage: IMAGE tokens split from the text output, thinking counted as completion', () => {
  assert.equal(llm.providerImageUsage(null), null)
  assert.deepEqual(
    llm.providerImageUsage({ promptTokenCount: 12, candidatesTokenCount: 1300, thoughtsTokenCount: 40, totalTokenCount: 1352, candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 20 }, { modality: 'image', tokenCount: 1280 }] }),
    { prompt_tokens: 12, completion_tokens: 60, image_output_tokens: 1280, total_tokens: 1352 }
  )
  assert.deepEqual(llm.providerImageUsage({ promptTokenCount: 'x' }), { prompt_tokens: 0, completion_tokens: 0, image_output_tokens: 0, total_tokens: 0 })
})

async function withFetch<T>(impl: (url: string, init: RequestInit) => Response | Promise<Response>, fn: (calls: { url: string; init: RequestInit }[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return impl(String(url), init)
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = real
  }
}

test('generateImage on a provider id: native call, image + usage back, spend ledgered under the provider id', async () => {
  const ledger: unknown[][] = []
  llm.setUsageSink((kind, model, usage) => void ledger.push([kind, model, usage]))
  try {
    const id = llm.providerImageModelId(PROVIDER, 'gemini-3.1-flash-image')
    const out = await withFetch(
      () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1290, totalTokenCount: 1295, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }] } }),
      async (calls) => {
        const r = await llm.generateImage('user-token', id, { prompt: 'a cube', baseImages: [PNG] })
        assert.equal(calls.length, 1)
        assert.match(calls[0]!.url, /\/ai-gateway\/gemini\/v1beta\/models\/gemini-3\.1-flash-image:generateContent$/)
        assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer user-token')
        return r
      }
    )
    assert.deepEqual(out.dataUrls, ['data:image/png;base64,QUJD'])
    assert.equal(out.usage.image_output_tokens, 1290)
    assert.deepEqual(ledger.map((l) => [l[0], l[1]]), [['image', id]])
  } finally {
    llm.setUsageSink(null)
  }
})

test('generateImage on a provider id: an HTTP error carries status, code and provider; a bare 404 is NOT_FOUND', async () => {
  const id = llm.providerImageModelId(PROVIDER, 'gemini-3.1-flash-image')
  const fail = (status: number, body: string) => withFetch(() => new Response(body, { status }), () => llm.generateImage('t', id, { prompt: 'x' }).then(() => null, (e) => e))
  const denied = await fail(403, JSON.stringify({ error_code: 'PERMISSION_DENIED', message: 'no EXECUTE' }))
  assert.equal(denied.status, 403)
  assert.equal(denied.code, 'PERMISSION_DENIED')
  assert.equal(denied.provider, PROVIDER)
  assert.match(denied.message, /returned 403/)
  assert.equal((await fail(404, 'nope')).code, 'NOT_FOUND')
  assert.equal((await fail(400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }))).code, 'INVALID_ARGUMENT')
  // a refusal with text and no image
  const refused = await withFetch(() => Response.json({ candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] } }] }), () => llm.generateImage('t', id, {}).then(() => null, (e) => e))
  assert.match(refused.message, /Model returned no image: I cannot draw that\./)
  const blocked = await withFetch(() => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), () => llm.generateImage('t', id, {}).then(() => null, (e) => e))
  assert.match(blocked.message, /SAFETY/)
})

test('generateImage on a serving endpoint: chat/completions with usage_context; a 404 carries the endpoint code; a bad name never reaches the network', async () => {
  const ok = await withFetch(
    () => Response.json({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: PNG } }] } }], usage: { prompt_tokens: 3 } }),
    async (calls) => {
      const r = await llm.generateImage('t', 'databricks-gemini-3-1-flash-image', { prompt: 'x' })
      assert.equal(calls[0]!.url, 'https://gateway.invalid/serving-endpoints/chat/completions')
      assert.equal(JSON.parse(String(calls[0]!.init.body)).usage_context.application, 'ai-prism')
      return r
    }
  )
  assert.deepEqual(ok.dataUrls, [PNG])
  const missing = await withFetch(() => new Response(JSON.stringify({ error_code: 'ENDPOINT_NOT_FOUND' }), { status: 404 }), () => llm.generateImage('t', 'ghost-endpoint', {}).then(() => null, (e) => e))
  assert.equal(missing.status, 404)
  assert.equal(missing.code, 'ENDPOINT_NOT_FOUND')
  await withFetch(() => Response.json({}), async (calls) => {
    await assert.rejects(llm.generateImage('t', '../../etc/passwd', {}), /not valid/)
    assert.equal(calls.length, 0)
  })
})

test('configured image ids are image models; a provider id prices and flags like its curated twin', () => {
  const id = llm.providerImageModelId(PROVIDER, 'gemini-3.1-flash-image')
  assert.equal(llm.isImageModel(id), false, 'unknown until models.json registers it')
  llm.setConfiguredImageModels([{ id, label: 'NB2', blurb: '', provider: PROVIDER, model: 'gemini-3.1-flash-image' }])
  try {
    assert.equal(llm.isImageModel(id), true)
    const info = llm.modelById(id)
    assert.equal(info.modality, 'image')
    assert.equal(info.maxOut, 8192)
    assert.equal(info.in, 0.5, 'the price of databricks-gemini-3-1-flash-image')
    assert.equal(info.out, 60)
    assert.equal(llm.curatedImageTwin(`${PROVIDER}/not-curated-image`), undefined)
    assert.equal(llm.getConfiguredImageModels()?.length, 1)
  } finally {
    llm.setConfiguredImageModels(null)
  }
  assert.equal(llm.isImageModel(id), false)
})
