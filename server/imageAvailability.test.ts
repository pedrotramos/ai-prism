// Which image models can be called (server/imageAvailability.ts): serving endpoint and Model Provider
// Service probes, the unknown-never-hides rule, the 404 latch, the user-token recheck, and the
// /api/image-models body.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABRICKS_HOST = 'https://ws.invalid'
const av = await import('./imageAvailability.ts')
const { createImageAvailability, providerTargetStatus, servingStatus, imageModelsResponse, resolveImageModelChoice } = av

const PROVIDER = 'main.ext.gemini'
const P_FLASH = `${PROVIDER}/gemini-3.1-flash-image`
const P_PRO = `${PROVIDER}/gemini-3-pro-image`
const SERVING = 'databricks-gemini-3-1-flash-image'

type Route = { status: number; body?: unknown } | 'throw'
// a fetch stub keyed by URL substring; records the URLs and tokens it was asked
function stub(routes: Record<string, Route>) {
  const calls: { url: string; token: string }[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, token: String((init?.headers as Record<string, string>).authorization) })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const r = key ? routes[key]! : { status: 404 }
    if (r === 'throw') throw new Error('network')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  }
  return { fetchImpl, calls }
}
const make = (routes: Record<string, Route>, extra: Record<string, unknown> = {}) => {
  const s = stub(routes)
  let t = 1_000
  const clock = { advance: (ms: number) => void (t += ms) }
  const a = createImageAvailability({ endpoints: [SERVING, P_FLASH, P_PRO], getToken: async () => 'sp-token', fetchImpl: s.fetchImpl, timeoutSignal: () => new AbortController().signal, now: () => t, intervalMs: 10_000, ...extra })
  return { a, ...s, clock }
}

test('providerTargetStatus and servingStatus: 404 missing, 200 decides, anything else unknown', () => {
  assert.equal(providerTargetStatus(404, null, 'm'), 'missing')
  assert.equal(providerTargetStatus(403, null, 'm'), 'unknown')
  assert.equal(providerTargetStatus(0, null, 'm'), 'unknown')
  assert.equal(providerTargetStatus(200, { config: { targets: [{ model: 'm' }] } }, 'm'), 'ready')
  assert.equal(providerTargetStatus(200, { targets: [{ model: 'm' }] }, 'm'), 'ready', 'the flat shape of an older CLI')
  assert.equal(providerTargetStatus(200, { config: { targets: [{ model: 'x' }] } }, 'm'), 'missing')
  assert.equal(providerTargetStatus(200, { config: { allow_all_targets: true } }, 'm'), 'ready')
  assert.equal(servingStatus(200, { state: { ready: 'READY' } }), 'ready')
  assert.equal(servingStatus(200, { state: { ready: 'NOT_READY' } }), 'missing')
  assert.equal(servingStatus(404, null), 'missing')
  assert.equal(servingStatus(500, null), 'unknown')
})

test('before the first probe nothing is hidden; after it only the ready models stay', async () => {
  const { a, calls } = make({
    [`serving-endpoints/${SERVING}`]: { status: 200, body: { state: { ready: 'READY' } } },
    'model-provider-services': { status: 200, body: { config: { targets: [{ model: 'gemini-3.1-flash-image' }] } } },
  })
  assert.deepEqual(a.readyIds(), [SERVING, P_FLASH, P_PRO], 'cold start: all counted')
  assert.equal(await a.refresh(), true)
  assert.deepEqual(a.readyIds(), [SERVING, P_FLASH])
  assert.equal(a.isReady(P_PRO), false)
  assert.equal(a.isAvailable(), true)
  // one provider read for both of its targets, with the SP token
  assert.equal(calls.filter((c) => c.url.includes('model-provider-services')).length, 1)
  assert.ok(calls.every((c) => c.token === 'Bearer sp-token'))
  assert.match(calls.find((c) => c.url.includes('model-provider-services'))!.url, /model-provider-services\/main\.ext\.gemini$/)
})

test('an unreadable probe (403, 5xx, network, no token) never hides a model', async () => {
  const { a } = make({ 'serving-endpoints': { status: 403 }, 'model-provider-services': 'throw' })
  await a.refresh()
  assert.deepEqual(a.readyIds(), [SERVING, P_FLASH, P_PRO])
  const none = make({}, { getToken: async () => null })
  await none.a.refresh()
  assert.equal(none.a.readyIds().length, 3)
})

test('a serving endpoint that is 404 or not READY is hidden', async () => {
  const gone = make({ 'serving-endpoints': { status: 404 }, 'model-provider-services': { status: 200, body: { config: { allow_all_targets: true } } } })
  await gone.a.refresh()
  assert.deepEqual(gone.a.readyIds(), [P_FLASH, P_PRO])
  const starting = make({ 'serving-endpoints': { status: 200, body: { state: { ready: 'NOT_READY' } } }, 'model-provider-services': { status: 404 } })
  await starting.a.refresh()
  assert.deepEqual(starting.a.readyIds(), [])
  assert.equal(starting.a.isAvailable(), false)
})

test('a 404 on a real generation latches the model out until restart (serving: only the missing-endpoint codes)', async () => {
  const { a } = make({ 'serving-endpoints': { status: 200, body: { state: { ready: 'READY' } } }, 'model-provider-services': { status: 200, body: { config: { allow_all_targets: true } } } })
  await a.refresh()
  assert.equal(a.markUnavailable({ status: 403, code: 'PERMISSION_DENIED' }, P_FLASH), false)
  assert.equal(a.markUnavailable({ status: 500 }, SERVING), false)
  assert.equal(a.markUnavailable({ status: 404, code: 'SOMETHING_ELSE' }, SERVING), false, 'a serving 404 needs an endpoint code')
  assert.equal(a.markUnavailable({ status: 404, code: 'ENDPOINT_NOT_FOUND' }, SERVING), true)
  assert.equal(a.markUnavailable({ status: 404 }, P_FLASH), true, 'any 404 of a provider target')
  assert.equal(a.markUnavailable({ status: 404 }, null), false)
  assert.deepEqual(a.readyIds(), [P_PRO])
  await a.refresh()
  assert.deepEqual(a.readyIds(), [P_PRO], 'the periodic refresh does not bring them back')
})

test('a provider the SP cannot read is rechecked with the user token (cached); only a 200 without the target hides it', async () => {
  const routes: Record<string, Route> = { 'serving-endpoints': { status: 200, body: { state: { ready: 'READY' } } }, 'model-provider-services': { status: 403 } }
  const { a, calls, clock } = make(routes)
  await a.refresh()
  assert.equal(a.readyIds().length, 3)
  // the user's token reads the provider: the flash target is there, the pro one is not
  routes['model-provider-services'] = { status: 200, body: { config: { targets: [{ model: 'gemini-3.1-flash-image' }] } } }
  assert.equal(await a.checkWithUserToken('user-token'), true)
  assert.deepEqual(a.readyIds(), [SERVING, P_FLASH])
  assert.ok(calls.some((c) => c.token === 'Bearer user-token'))
  // cached: no second read inside the interval
  const before = calls.length
  assert.equal(await a.checkWithUserToken('user-token'), false)
  assert.equal(calls.length, before)
  // after it the read is repeated, and a user 403 hides nothing
  clock.advance(11_000)
  routes['model-provider-services'] = { status: 403 }
  assert.equal(await a.checkWithUserToken('user-token'), true)
  assert.equal(a.readyIds().length, 3)
  assert.equal(await a.checkWithUserToken(null), false)
})

test('disabled (IMAGE_GENERATION=off or imageModels: []) → nothing ready, no probe', async () => {
  const { a, calls } = make({}, { enabled: false })
  assert.equal(await a.refresh(), false)
  assert.deepEqual(a.readyIds(), [])
  assert.equal(a.isAvailable(), false)
  assert.equal(calls.length, 0)
  assert.equal(av.imageGenerationEnabled('off'), false)
  assert.equal(av.imageGenerationEnabled(' OFF '), false)
  assert.equal(av.imageGenerationEnabled(''), true)
})

test('track(): an enabled model never probed asks for a refresh; one that left the list stops counting', async () => {
  const { a } = make({ 'serving-endpoints': { status: 200, body: { state: { ready: 'READY' } } } }, { endpoints: [SERVING] })
  await a.refresh()
  assert.equal(a.track([SERVING]), false)
  assert.equal(a.track([SERVING, 'extra-image-endpoint']), true)
  assert.equal(a.isReady('extra-image-endpoint'), false, 'tracked but not probed after the first probe: not ready')
  await a.refresh()
  assert.equal(a.track([SERVING, 'extra-image-endpoint']), false)
  // an id that cannot reach a URL is never tracked
  assert.equal(a.track(['../bad', 'a b']), false)
})

test('imageModelsResponse: enabled ∩ ready in catalog order, the default, the saved choice', () => {
  const models = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]
  const r = imageModelsResponse({ models, ready: ['b', 'c'], saved: 'c' })
  assert.deepEqual(r.models.map((m) => m.id), ['b', 'c'])
  assert.deepEqual([r.defaultId, r.selected, r.available], ['b', 'c', true])
  // a saved model that is no longer listed falls back to the default
  assert.equal(imageModelsResponse({ models, ready: ['b', 'c'], saved: 'a' }).selected, 'b')
  // the curated default stays preferred when listed (no models.json key)
  assert.equal(imageModelsResponse({ models, ready: ['a', 'b'], preferredId: 'b' }).defaultId, 'b')
  assert.equal(imageModelsResponse({ models, ready: ['a', 'b'], preferredId: 'zzz' }).defaultId, 'a')
  const none = imageModelsResponse({ models, ready: [] })
  assert.deepEqual([none.models, none.defaultId, none.selected, none.available], [[], null, null, false])
  assert.equal(resolveImageModelChoice(models, 'b'), 'b')
  assert.equal(resolveImageModelChoice(models, 'nope'), 'a')
  assert.equal(resolveImageModelChoice(models, 7, null), null)
})
