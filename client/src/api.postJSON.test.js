// postJSON keeps the server's machine-readable answer on the error (N7-4): the
// code (and limit) lets a Studio show its own localized copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postJSON } from './api.js'

test('a coded 400 reaches the caller as error.code / error.limit, message stays the fallback', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ code: 'spreadsheet_too_many_images', limit: 4, error: 'no máximo 4 imagens' }) })
  try {
    await assert.rejects(postJSON('/x', {}), (e) => e.code === 'spreadsheet_too_many_images' && e.limit === 4 && e.status === 400 && e.message === 'no máximo 4 imagens')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a non-JSON failure still reads HTTP <status>', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('html') } })
  try {
    await assert.rejects(postJSON('/x', {}), (e) => e.message === 'HTTP 502' && e.code === undefined)
  } finally {
    globalThis.fetch = realFetch
  }
})
