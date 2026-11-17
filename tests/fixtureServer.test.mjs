// Tests for the e2e fixture server and the recorder's publish guard.
//   node --test tests/fixtureServer.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startFixtureServer } from '../client/e2e/fixture-server.mjs'
import { publishProblems } from '../client/e2e/record/publish-guard.mjs'

let srv
let root
before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'fx-'))
  mkdirSync(path.join(root, 'dist'))
  mkdirSync(path.join(root, 'dist-secret'))
  writeFileSync(path.join(root, 'dist', 'index.html'), '<html>spa</html>')
  writeFileSync(path.join(root, 'dist-secret', 'x.txt'), 'secret')
  const fixtures = { routes: { 'GET /api/me': { status: 200, contentType: 'application/json', body: '{"email":"e2e-user@example.com"}' } } }
  srv = await startFixtureServer({ port: 0, fixtures, dist: path.join(root, 'dist') })
})
after(() => srv?.close())

test('a malformed URL escape gets a 400 and the server keeps serving', async () => {
  const bad = await fetch(`${srv.url}/%E0%A4%A`)
  assert.equal(bad.status, 400)
  const ok = await fetch(`${srv.url}/api/me`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).email, 'e2e-user@example.com')
})

test('paths outside dist (including a sibling folder with the same prefix) fall back to the SPA', async () => {
  const res = await fetch(`${srv.url}/..%2Fdist-secret%2Fx.txt`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '<html>spa</html>')
})

test('an /api request without a fixture is a JSON 404 and is listed as a miss', async () => {
  const res = await fetch(`${srv.url}/api/nope?x=1`)
  assert.equal(res.status, 404)
  const misses = await (await fetch(`${srv.url}/__fixtures/misses`)).json()
  assert.deepEqual(misses, [{ key: 'GET /api/nope?x=1', count: 1 }])
})

test('publishProblems allows only placeholder e-mail domains and no secrets or workspace hosts', () => {
  assert.deepEqual(publishProblems('{"email":"e2e-user@example.com","b":"x@test.invalid"}'), [])
  assert.match(publishProblems('{"email":"someone@acme.com"}').join(' '), /e-mail outside example\.com\/test\.invalid: someone@acme\.com/)
  // built at runtime so no token-shaped literal sits in the source
  const fakePat = ['da', 'pi', '0123456789abcdef'.repeat(2)].join('')
  assert.match(publishProblems(`Bearer ${fakePat}`).join(' '), /token/)
  assert.match(publishProblems('https://adb-1.2.azuredatabricks.net/x').join(' '), /workspace host/)
  assert.match(publishProblems('https://my.cloud.databricks.com').join(' '), /workspace host/)
})
