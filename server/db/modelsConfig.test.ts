// applyConfigOn (server/db/modelsConfig.ts) against a stand-in transaction client that models the two
// tables it touches: the first apply on an empty catalog, an unchanged file, a changed file (full
// apply: enable, rename, reorder, disable the rest), and the first apply on a catalog an admin already
// curated (additive only), each with its single admin_audit row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyConfigOn } from './modelsConfig.ts'
import type { DbClient } from './pool.ts'

type Row = { endpoint_id: string; enabled: boolean; display_name: string | null; blurb: string | null; sort_order: number | null; price_in: number | null; price_out: number | null; updated_by: string }

function fakeDb(initial: Row[] = [], hash: string | null = null) {
  const catalog = new Map(initial.map((r) => [r.endpoint_id, { ...r }]))
  const settings = new Map<string, unknown>(hash ? [['models_json_hash', hash]] : [])
  const audit: { action: string; target: unknown; details: Record<string, unknown> }[] = []
  const client: DbClient = {
    async query(sql: string, params: unknown[] = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim()
      if (q.startsWith('SELECT value FROM app_settings')) return { rows: settings.has(String(params[0])) ? [{ value: settings.get(String(params[0])) }] : [], rowCount: 0 }
      if (q.startsWith('SELECT endpoint_id, enabled FROM model_catalog_overrides')) return { rows: [...catalog.values()].map((r) => ({ endpoint_id: r.endpoint_id, enabled: r.enabled })), rowCount: 0 }
      if (q.startsWith('UPDATE model_catalog_overrides SET enabled = false')) {
        for (const id of params[0] as string[]) Object.assign(catalog.get(id)!, { enabled: false, updated_by: String(params[1]) })
        return { rows: [], rowCount: 0 }
      }
      if (q.startsWith('INSERT INTO model_catalog_overrides')) {
        const [id, name, blurb, order, pin, pout, by] = params as [string, string | null, string | null, number, number | null, number | null, string]
        const prev = catalog.get(id)
        const enabled = !q.includes('VALUES ($1, FALSE')
        const next: Row = { endpoint_id: id, enabled, display_name: name, blurb, sort_order: order, price_in: pin, price_out: pout, updated_by: by }
        if (!prev) catalog.set(id, next)
        else if (q.includes('DO UPDATE')) {
          // COALESCE(EXCLUDED.x, current.x): what the file omits (NULL) keeps the stored value
          catalog.set(id, { ...next, display_name: name ?? prev.display_name, blurb: blurb ?? prev.blurb, price_in: pin ?? prev.price_in, price_out: pout ?? prev.price_out })
        }
        return { rows: [], rowCount: 1 }
      }
      if (q.startsWith('INSERT INTO app_settings')) {
        settings.set(String(params[0]), JSON.parse(String(params[1])))
        return { rows: [], rowCount: 1 }
      }
      if (q.startsWith('INSERT INTO admin_audit')) {
        audit.push({ action: String(params[1]), target: params[2], details: JSON.parse(String(params[3])) })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${q}`)
    },
  }
  return { client, catalog, settings, audit }
}

const row = (id: string, extra: Partial<Row> = {}): Row => ({ endpoint_id: id, enabled: true, display_name: null, blurb: null, sort_order: null, price_in: null, price_out: null, updated_by: 'admin@x', ...extra })
const cfg = (hash: string) => ({
  hash,
  rows: [
    { id: 'chat-a', displayName: 'A', blurb: 'blurb a', sortOrder: 0, priceIn: 1, priceOut: 2 },
    { id: 'chat-b', displayName: '', blurb: '', sortOrder: 1, priceIn: null, priceOut: null },
  ],
  imageRows: [{ id: 'img-a', displayName: 'Img', blurb: '', sortOrder: 0, priceIn: null, priceOut: null }],
  toDisable: (enabled: string[]) => enabled.filter((id) => !['chat-a', 'chat-b', 'img-a'].includes(id)),
})
const ids = (m: Map<string, Row>, enabled: boolean) => [...m.values()].filter((r) => r.enabled === enabled).map((r) => r.endpoint_id).sort()

test('an empty catalog: every listed model is enabled with the file\'s name, order and price; hash stored; one audit row', async () => {
  const db = fakeDb()
  assert.equal(await applyConfigOn(db.client, 'admin@x', cfg('h1')), true)
  assert.deepEqual(ids(db.catalog, true), ['chat-a', 'chat-b', 'img-a'])
  const a = db.catalog.get('chat-a')!
  assert.deepEqual([a.display_name, a.blurb, a.sort_order, a.price_in, a.price_out, a.updated_by], ['A', 'blurb a', 0, 1, 2, 'models.json'])
  assert.equal(db.catalog.get('chat-b')!.price_in, null, 'a price the file omits follows the curated one')
  assert.equal(db.settings.get('models_json_hash'), 'h1')
  assert.equal(db.audit.length, 1)
  assert.equal(db.audit[0]!.action, 'model_endpoints.config_apply')
  assert.deepEqual(db.audit[0]!.details, { hash: 'h1', chat: 2, image: 1, mode: 'full', disabled: 0, inserted: 3 })
})

test('the same hash again changes nothing and writes no audit row', async () => {
  const db = fakeDb()
  await applyConfigOn(db.client, 'admin@x', cfg('h1'))
  db.catalog.get('chat-a')!.display_name = 'edited in the admin tab'
  assert.equal(await applyConfigOn(db.client, 'admin@x', cfg('h1')), false)
  assert.equal(db.catalog.get('chat-a')!.display_name, 'edited in the admin tab', 'admin edits last until the file changes')
  assert.equal(db.audit.length, 1)
})

test('a changed file: full apply, the enabled models it does not list are switched off, admin edits of listed ones are replaced', async () => {
  const db = fakeDb([row('chat-a', { display_name: 'edited', sort_order: 5 }), row('chat-z'), row('img-z'), row('chat-off', { enabled: false })], 'old-hash')
  assert.equal(await applyConfigOn(db.client, 'admin@x', cfg('h2')), true)
  assert.deepEqual(ids(db.catalog, true), ['chat-a', 'chat-b', 'img-a'])
  assert.deepEqual(ids(db.catalog, false), ['chat-off', 'chat-z', 'img-z'])
  assert.equal(db.catalog.get('chat-a')!.display_name, 'A')
  assert.equal(db.catalog.get('chat-a')!.sort_order, 0)
  assert.equal(db.catalog.get('chat-z')!.updated_by, 'models.json')
  assert.deepEqual(db.audit[0]!.details, { hash: 'h2', chat: 2, image: 1, mode: 'full', disabled: 2, inserted: 2 })
})

test('the first apply on a catalog an admin already curated is additive: nothing enabled, disabled, renamed or reordered', async () => {
  const db = fakeDb([row('chat-a', { display_name: 'my name', sort_order: 9, price_in: 7 }), row('chat-z'), row('chat-b', { enabled: false })])
  assert.equal(await applyConfigOn(db.client, 'admin@x', cfg('h1')), true)
  const a = db.catalog.get('chat-a')!
  assert.deepEqual([a.display_name, a.sort_order, a.price_in, a.updated_by], ['my name', 9, 7, 'admin@x'])
  assert.equal(db.catalog.get('chat-z')!.enabled, true, 'a model the org uses is not dropped')
  assert.equal(db.catalog.get('chat-b')!.enabled, false, 'a model an admin switched off stays off')
  assert.equal(db.catalog.has('img-a'), true, 'a listed model the catalog lacks is added')
  assert.equal(db.catalog.get('img-a')!.enabled, false, '...but DISABLED: the admin switches it on, users never see a surprise model')
  assert.equal(db.settings.get('models_json_hash'), 'h1')
  assert.deepEqual(db.audit[0]!.details, { hash: 'h1', chat: 2, image: 1, mode: 'additive', disabled: 0, inserted: 1 })
  // and from then on the file is the source of truth when it changes
  await applyConfigOn(db.client, 'admin@x', cfg('h2'))
  assert.equal(db.catalog.get('chat-z')!.enabled, false)
})

test('a full apply keeps the price, name and description an admin set when the file omits them', async () => {
  const db = fakeDb([row('chat-a', { display_name: 'my name', blurb: 'my blurb', price_in: 7, price_out: 9 }), row('chat-b', { display_name: 'kept', price_in: 3, price_out: 4 })], 'old-hash')
  await applyConfigOn(db.client, 'admin@x', cfg('h4'))
  const a = db.catalog.get('chat-a')!
  assert.deepEqual([a.display_name, a.blurb, a.price_in, a.price_out], ['A', 'blurb a', 1, 2], 'what the file gives replaces')
  const b = db.catalog.get('chat-b')!
  assert.deepEqual([b.display_name, b.price_in, b.price_out], ['kept', 3, 4], 'what the file omits keeps the admin value')
  assert.equal(b.enabled, true)
  assert.equal(b.sort_order, 1, 'the order is the file\'s')
})

test('a file without imageModels leaves the image catalog alone', async () => {
  const db = fakeDb([row('img-z')], 'old')
  const noImages = { ...cfg('h3'), imageRows: null, toDisable: (e: string[]) => e.filter((id) => !id.startsWith('img-') && !['chat-a', 'chat-b'].includes(id)) }
  await applyConfigOn(db.client, 'admin@x', noImages)
  assert.equal(db.catalog.get('img-z')!.enabled, true)
  assert.equal(db.catalog.has('img-a'), false)
  assert.equal(db.audit[0]!.details.image, null)
})
