import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pgSslOptions } from './db.js'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBAAAA\n-----END CERTIFICATE-----\n'

test('default: TLS on, chain not verified (the historical behavior)', () => {
  assert.deepEqual(pgSslOptions({}), { rejectUnauthorized: false })
  assert.deepEqual(pgSslOptions({ PGSSLMODE: 'require' }), { rejectUnauthorized: false })
})

test('PGSSLMODE=disable turns TLS off, whatever the CA knobs say', () => {
  assert.equal(pgSslOptions({ PGSSLMODE: 'disable', PG_SSL_CA: PEM }), false)
  assert.equal(pgSslOptions({ PGSSLMODE: 'false' }), false)
})

test('PG_SSL_CA (inline PEM) pins the CA and verifies the chain', () => {
  assert.deepEqual(pgSslOptions({ PG_SSL_CA: PEM }), { ca: PEM, rejectUnauthorized: true })
})

test('PG_SSL_CA as a file path is read', () => {
  const file = path.join(os.tmpdir(), `ai-prism-ca-${process.pid}.pem`)
  fs.writeFileSync(file, PEM)
  try {
    assert.deepEqual(pgSslOptions({ PG_SSL_CA: file }), { ca: PEM, rejectUnauthorized: true })
  } finally {
    fs.unlinkSync(file)
  }
})

test('an explicit PG_SSL_REJECT_UNAUTHORIZED wins over the CA default', () => {
  assert.deepEqual(pgSslOptions({ PG_SSL_CA: PEM, PG_SSL_REJECT_UNAUTHORIZED: '0' }), { ca: PEM, rejectUnauthorized: false })
  assert.deepEqual(pgSslOptions({ PG_SSL_REJECT_UNAUTHORIZED: '1' }), { rejectUnauthorized: true })
})
