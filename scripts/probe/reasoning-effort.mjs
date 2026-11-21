#!/usr/bin/env node
// Probes which catalog chat models accept a reasoning-effort parameter through the
// AI Gateway (OpenAI-compatible chat/completions), and records the answer so the
// `reasoning` catalog flag in server/llm.js is set from evidence, never guessed.
//
//   node scripts/probe/reasoning-effort.mjs --profile <databricks-cli-profile> \
//        [--models id1,id2] [--shape openai|anthropic|gemini|auto] [--out file.json]
//
// For each chat model it sends ONE tiny request per level (low, medium, high) plus
// one control request without the parameter and one with an invalid value (`invalid`) (max_tokens 2048, no tools, no stream),
// and writes { model, shape, level, accepted, status, usage, error } rows to the
// JSON file (default: ./reasoning-effort-probe.json: pass --out to keep it outside
// the repo). Only serving-endpoint chat/completions calls are made; nothing in the
// workspace is created, changed or deleted. The token comes from
// `databricks auth token` and is never printed or written.
//
// Run by hand, never in CI (it needs a workspace and spends a few cents).
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { MODELS, REASONING_LEVELS, reasoningFields } from '../../server/llm.ts'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const profile = arg('profile')
if (!profile) {
  console.error('usage: reasoning-effort.mjs --profile <name> [--models a,b] [--shape auto|openai|anthropic|anthropic-budget|gemini] [--out file.json]')
  process.exit(2)
}
const out = arg('out', 'reasoning-effort-probe.json')
const shapeArg = arg('shape', 'auto')
const wanted = arg('models') ? new Set(arg('models').split(',')) : null

// provider → the body shape tried first in `auto` mode
const AUTO_SHAPE = { Anthropic: 'anthropic', Google: 'gemini' }
const shapeFor = (m) => (shapeArg === 'auto' ? AUTO_SHAPE[m.provider] || 'openai' : shapeArg)

const cli = (a) => JSON.parse(execFileSync('databricks', [...a, '--profile', profile, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
const token = cli(['auth', 'token']).access_token
let host = cli(['auth', 'env']).env?.DATABRICKS_HOST || ''
if (!token || !host) {
  console.error('could not resolve a token/host for that profile (databricks auth login -p <profile>)')
  process.exit(1)
}
if (!host.startsWith('http')) host = `https://${host}`
const url = `${host.replace(/\/$/, '')}/serving-endpoints/chat/completions`

// a question that needs real multi-step reasoning, so the usage block can show whether a level changed anything
const PROMPT = 'How many prime numbers are there between 1000 and 1100? Reply with just the number.'

async function call(model, extra) {
  const body = { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 2048, ...extra }
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return {
    accepted: res.ok,
    status: res.status,
    usage: res.ok ? json?.usage ?? null : null,
    error: res.ok ? null : text.replace(/\s+/g, ' ').slice(0, 300),
  }
}

const rows = []
for (const m of MODELS.filter((x) => (x.modality || 'chat') === 'chat' && (!wanted || wanted.has(x.id)))) {
  const shape = shapeFor(m)
  // `invalid` is the negative control: an endpoint that validates the field rejects it, so its
  // acceptance of the real levels is meaningful; one that accepts it is ignoring the field
  for (const level of [null, ...REASONING_LEVELS, 'invalid']) {
    const extra = level ? reasoningFields(shape, level === 'invalid' ? '__invalid__' : level, m.maxOut) : {}
    const r = await call(m.id, extra).catch((e) => ({ accepted: false, status: 0, usage: null, error: String(e.message).slice(0, 300) }))
    rows.push({ model: m.id, provider: m.provider, shape, level: level || 'control', ...r })
    console.log(`${m.id.padEnd(34)} ${shape.padEnd(9)} ${(level || 'control').padEnd(8)} ${r.accepted ? 'ACCEPT' : `REJECT ${r.status}`}`)
  }
}
writeFileSync(out, JSON.stringify({ probedAt: new Date().toISOString(), profile, rows }, null, 2) + '\n')
console.log(`wrote ${rows.length} rows to ${out}`)
