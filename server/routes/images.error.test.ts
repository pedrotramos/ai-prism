// QA regression test for a failed image-volume read: a JSON 500 must not be marked as an artifact download.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import registerImageRoutes from './images.ts'

const auth = (req: Request, _res: Response, next: NextFunction) => (Object.assign(req, { email: 'a@example.com', token: 'tok' }), next())

test('a failed image read returns the JSON error without an artifact download header', async () => {
  const app = express()
  registerImageRoutes(app, {
    auth,
    ensureReady: async () => {},
    getImage: async () => ({ id: '7', contentType: 'image/svg+xml', volumePath: '/v/7', shared: false, readOnly: false }),
    getImageBytes: async () => { throw new Error('volume unavailable') },
  })
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/api/images/7`)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'volume unavailable' })
    assert.equal(response.headers.get('content-disposition'), null)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
