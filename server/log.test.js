// Structured logger (server/log.js): one JSON object per line with exactly the
// fields of the design row, redaction of e-mails, tokens, prompts and SQL, and
// the guarantee that a log call never throws into a route. The last test is the
// guard that keeps every server log line on this logger (no console.* left).
//
//   node --test server/log.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { log, logger, redact, userHash, setLogWriter, runWithRequestContext } from './log.js'

const FIELDS = ['duration_ms', 'level', 'msg', 'request_id', 'route', 'status', 'ts', 'user_hash']

// captures what the logger writes; returns the parsed lines
function capture(fn) {
  const lines = []
  const prev = setLogWriter((line) => lines.push(line))
  try {
    fn()
  } finally {
    setLogWriter(prev)
  }
  return lines
}

test('log: one JSON object on one line with exactly the row fields', () => {
  const lines = capture(() => log('info', 'hello', { status: 200, duration_ms: 12 }))
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('\n'), 'no newline inside the line')
  const o = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(o).sort(), FIELDS)
  assert.equal(o.level, 'info')
  assert.equal(o.msg, 'hello')
  assert.equal(o.status, 200)
  assert.equal(o.duration_ms, 12)
  assert.equal(o.request_id, null)
  assert.equal(o.user_hash, null)
  assert.equal(o.route, null)
  assert.ok(!Number.isNaN(Date.parse(o.ts)), 'ts is an ISO timestamp')
})

test('log: request context fills request_id, user_hash and route', () => {
  const req = { method: 'GET', path: '/api/sessions', email: 'ana@example.com' }
  const lines = capture(() => runWithRequestContext({ requestId: 'rid-1', req }, () => logger.warn('deep')))
  const o = JSON.parse(lines[0])
  assert.equal(o.level, 'warn')
  assert.equal(o.request_id, 'rid-1')
  assert.equal(o.route, 'GET /api/sessions')
  assert.equal(o.user_hash, userHash('ana@example.com'))
})

test('userHash: 12 hex chars, stable, never the e-mail', () => {
  const h = userHash('ana@example.com')
  assert.match(h, /^[0-9a-f]{12}$/)
  assert.equal(userHash('ana@example.com'), h)
  assert.notEqual(userHash('bob@example.com'), h)
  assert.equal(userHash(null), null)
})

test('redaction: no e-mail, token, prompt or SQL reaches the output', () => {
  const email = 'maria.silva@cliente.com.br'
  const bearer = 'Bearer abc.def-ghi_JKL123456'
  // assembled at runtime: a literal token-shaped string trips secret scanners
  const dapi = ['da', 'pi', '0123456789abcdef'.repeat(2)].join('')
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJlLXNpZw'].join('.')
  const sql = 'SELECT secret_col FROM customers WHERE id = 7'
  const prompt = 'my confidential quarterly numbers are 42'
  const lines = capture(() => {
    log('warn', `user ${email} failed with ${bearer} and ${dapi}`, {
      err: new Error(`token ${jwt} rejected running ${sql}`),
      prompt,
      sql,
      token: dapi,
      email,
    })
    log('error', `lakebase user pool (${email}): idle client error`, { route: `GET /api/x?token=${dapi}` })
    log('info', `query failed: INSERT INTO chat_messages (content) VALUES ('${prompt}')`)
  })
  const out = lines.join('\n')
  for (const raw of [email, 'abc.def-ghi_JKL123456', dapi, jwt, 'secret_col', 'FROM customers', prompt, "VALUES ('"]) {
    assert.ok(!out.includes(raw), `output must not contain ${JSON.stringify(raw)}`)
  }
  for (const l of lines) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), FIELDS)
  // the redacted message still says what happened
  assert.match(JSON.parse(lines[0]).msg, /failed with/)
  assert.match(JSON.parse(lines[0]).msg, /rejected running/)
  // an e-mail field becomes the user hash, not a raw value
  assert.equal(JSON.parse(lines[0]).user_hash, userHash(email))
})

test('redact: leaves ordinary text alone', () => {
  assert.equal(redact('title/session update failed: timeout'), 'title/session update failed: timeout')
  assert.equal(redact('select a model first'), 'select a model first')
})

test('log: msg is capped so a huge error cannot flood the log', () => {
  const lines = capture(() => log('info', 'x'.repeat(10_000)))
  assert.ok(JSON.parse(lines[0]).msg.length <= 1000)
})

test('log: never throws into the caller', () => {
  const prev = setLogWriter(() => {
    throw new Error('stdout closed')
  })
  try {
    const circular = {}
    circular.self = circular
    assert.doesNotThrow(() => log('error', 'boom', { err: circular, status: circular }))
    assert.doesNotThrow(() => log('nonsense-level', undefined, undefined))
  } finally {
    setLogWriter(prev)
  }
})

test('log: an unknown level is logged as info', () => {
  const lines = capture(() => log('loud', 'x'))
  assert.equal(JSON.parse(lines[0]).level, 'info')
})

// ---- AC6: every server log line goes through the logger ----------------------
const SERVER = path.dirname(fileURLToPath(import.meta.url))
function sourceFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(c|m)?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p)
  }
  return out
}

test('no console.* left in server/ (outside tests)', () => {
  const hits = []
  for (const f of sourceFiles(SERVER)) {
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // a call, or console injected as a default logger (`log = console`)
        if (/\bconsole\.(log|info|warn|error|debug|trace)\b|=\s*console\b/.test(line)) hits.push(`${path.relative(SERVER, f)}:${i + 1}`)
      })
  }
  assert.deepEqual(hits, [])
})
