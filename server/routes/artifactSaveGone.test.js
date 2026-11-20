// N7 item 15: saving an artifact whose row is gone (the retention sweep deleted its
// chat while the Studio was open, or while an AI edit ran) answers 404, never 200.
// The update helpers report whether a row matched; the routes turn "no" into 404.
//
//   node --test server/routes/artifactSaveGone.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import registerSpreadsheetRoutes from './spreadsheets.js'
import registerDocumentRoutes from './documents.js'

const auth = (req, _res, next) => ((req.email = 'a@example.com'), (req.token = 'tok'), next())
const SHEET = { id: '5', title: 'S', sheets: [{ name: 'A', blocks: [{ kind: 'note', text: 'hi' }] }], read_only: false }
const DOC = { id: '6', title: 'D', markdown: '# D', read_only: false }

async function serve(register, deps) {
  const app = express()
  app.use(express.json())
  register(app, { auth, ensureReady: async () => {}, ...deps })
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const call = (method, path, body) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  return { call, close: () => server.close() }
}

test('N7-15: PATCH /api/spreadsheets/:id is 404 when the row vanished between the read and the write', async () => {
  const s = await serve(registerSpreadsheetRoutes, { getSpreadsheet: async () => SHEET, updateSpreadsheet: async () => false })
  try {
    const r = await s.call('PATCH', '/api/spreadsheets/5', { title: 'T', sheets: SHEET.sheets })
    assert.equal(r.status, 404)
    assert.match(r.body.error, /planilha/i)
  } finally { s.close() }
})

test('N7-15: ...and 200 when the row was written (control)', async () => {
  const s = await serve(registerSpreadsheetRoutes, { getSpreadsheet: async () => SHEET, updateSpreadsheet: async () => true })
  try {
    assert.equal((await s.call('PATCH', '/api/spreadsheets/5', { title: 'T', sheets: SHEET.sheets })).status, 200)
  } finally { s.close() }
})

test('N7-15: PATCH /api/documents/:id is 404 when the row vanished, 200 when written', async () => {
  const gone = await serve(registerDocumentRoutes, { getDocument: async () => DOC, updateDocument: async () => false })
  try {
    assert.equal((await gone.call('PATCH', '/api/documents/6', { title: 'D', markdown: '# new' })).status, 404)
  } finally { gone.close() }
  const ok = await serve(registerDocumentRoutes, { getDocument: async () => DOC, updateDocument: async () => true })
  try {
    assert.equal((await ok.call('PATCH', '/api/documents/6', { title: 'D', markdown: '# new' })).status, 200)
  } finally { ok.close() }
})
