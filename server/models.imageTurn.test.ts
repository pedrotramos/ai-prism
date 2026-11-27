// The image model of a turn (server/models.ts resolveImageModelForTurn): the generate_image tool is offered
// only when an ENABLED, ready model resolves. Availability and the catalog are stubbed (no DB, no network).
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABRICKS_HOST = 'https://ws.invalid'
const { createImageAvailability } = await import('./imageAvailability.ts')
const { resolveImageModelForTurn, resolveImageModelForTurnBounded, imageModelsFor } = await import('./models.ts')
type Deps = NonNullable<Parameters<typeof imageModelsFor>[2]>

const DEFAULT_ENDPOINT = 'databricks-gemini-3-1-flash-image'
const PROVIDER = 'main.ext.gemini'
const P_FLASH = `${PROVIDER}/gemini-3.1-flash-image`
const req = { email: 'u@x.test', token: 'user-token' }
const ov = (id: string, enabled: boolean, sortOrder = 0) => ({ endpointId: id, enabled, sortOrder, priceIn: null, priceOut: null })

type Route = { status: number; body?: unknown }
// availability monitor over a fetch stub; the deps mirror refreshImageAvailabilityFor (track, probe, user recheck)
function world(routes: Record<string, Route>, overrides: Record<string, unknown>, saved: string | null = null) {
  const fetchImpl = async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k))
    const r = key ? routes[key]! : { status: 404 }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  }
  // the file/default endpoint is what the boot probe knows about
  const a = createImageAvailability({ endpoints: [DEFAULT_ENDPOINT], getToken: async () => 'sp-token', fetchImpl, timeoutSignal: () => new AbortController().signal })
  const deps: Deps = {
    listOverrides: async () => overrides as never,
    getSelected: async () => saved,
    refreshFor: async (ids, userToken) => {
      if (a.track(ids)) await a.refresh()
      await a.checkWithUserToken(userToken).catch(() => false)
      return a.isAvailable()
    },
    isReady: (id) => a.readyIds().includes(id),
  }
  return { a, deps }
}

const SERVING_READY: Route = { status: 200, body: { state: { ready: 'READY' } } }
const PROVIDER_HAS_FLASH: Route = { status: 200, body: { config: { targets: [{ model: 'gemini-3.1-flash-image' }] } } }

test('a disabled default that is ready, with an unavailable replacement: no model resolves (the tool is not offered)', async () => {
  const { a, deps } = world(
    { 'serving-endpoints': SERVING_READY, 'model-provider-services': { status: 404 } },
    { [DEFAULT_ENDPOINT]: ov(DEFAULT_ENDPOINT, false), [P_FLASH]: ov(P_FLASH, true) }
  )
  await a.refresh() // the boot probe: the default endpoint is up
  assert.equal(a.isAvailable(), true, 'precondition: before the catalog is known the default counts')
  assert.equal(await resolveImageModelForTurn(req, null, deps), undefined)
  assert.equal(a.isAvailable(), false, 'once the enabled catalog is registered the disabled default stops counting')
  assert.deepEqual((await imageModelsFor(req, {}, deps)).models, [])
})

test('a model enabled a moment ago resolves on the first turn, with no picker request before', async () => {
  const { deps } = world(
    { 'serving-endpoints': SERVING_READY, 'model-provider-services': PROVIDER_HAS_FLASH },
    { [DEFAULT_ENDPOINT]: ov(DEFAULT_ENDPOINT, false), [P_FLASH]: ov(P_FLASH, true) }
  )
  assert.equal(await resolveImageModelForTurn(req, null, deps), P_FLASH)
})

test('the per-turn or saved choice is used while enabled and ready; a disabled one never is', async () => {
  const overrides = { [DEFAULT_ENDPOINT]: ov(DEFAULT_ENDPOINT, false), [P_FLASH]: ov(P_FLASH, true) }
  const routes = { 'serving-endpoints': SERVING_READY, 'model-provider-services': PROVIDER_HAS_FLASH }
  assert.equal(await resolveImageModelForTurn(req, P_FLASH, world(routes, overrides).deps), P_FLASH)
  assert.equal(await resolveImageModelForTurn(req, DEFAULT_ENDPOINT, world(routes, overrides).deps), P_FLASH, 'a client choice outside the enabled list falls to the default')
  assert.equal(await resolveImageModelForTurn(req, null, world(routes, overrides, DEFAULT_ENDPOINT).deps), P_FLASH, 'so does a stale saved choice')
})

test('with the curated default enabled and ready it is the answer (no overrides: nothing changes for a fresh install)', async () => {
  const { deps } = world({ 'serving-endpoints': SERVING_READY }, {})
  assert.equal(await resolveImageModelForTurn(req, null, deps), DEFAULT_ENDPOINT)
})

test('bounded admission: a slow probe never stalls tool building; the last known model is used, none the first time', async () => {
  const routes = { 'serving-endpoints': SERVING_READY, 'model-provider-services': PROVIDER_HAS_FLASH }
  const overrides = { [DEFAULT_ENDPOINT]: ov(DEFAULT_ENDPOINT, false), [P_FLASH]: ov(P_FLASH, true) }
  const user = { email: 'slow@x.test', token: 't' }
  const { deps } = world(routes, overrides)
  let slow = false
  const gated: Deps = { ...deps, refreshFor: (ids, tok) => (slow ? new Promise(() => {}) : deps.refreshFor(ids, tok)) }
  // the first turn is slow and nothing is known yet: no tool, and it did not wait for the probe
  slow = true
  const t0 = Date.now()
  assert.equal(await resolveImageModelForTurnBounded(user, null, gated, 30), undefined)
  assert.ok(Date.now() - t0 < 1000)
  // a normal turn resolves and remembers the model
  slow = false
  assert.equal(await resolveImageModelForTurnBounded(user, null, gated, 1500), P_FLASH)
  // a later slow turn falls back to it instead of dropping the tool
  slow = true
  assert.equal(await resolveImageModelForTurnBounded(user, null, gated, 30), P_FLASH)
})
