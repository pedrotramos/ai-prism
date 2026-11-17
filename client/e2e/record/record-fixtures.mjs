#!/usr/bin/env node
// Records client/e2e/fixtures/api.json: every /api response the e2e screens
// trigger, captured from a REAL local server (LOCAL_DEV_MODE=1, seeded
// Postgres, fake AI Gateway). Re-record whenever the screens start calling
// different endpoints (the fixture server lists misses). See CONTRIBUTING.md.
//
//   IDS=$(node client/e2e/record/seed-rich.mjs)       # seed the local DB
//   APP_URL=http://127.0.0.1:8000 IDS="$IDS" node client/e2e/record/record-fixtures.mjs
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { SCREENS, VARIANTS, LIGHTHOUSE_PAGES, newVariantContext, FIXTURES_URL } from '../lib.mjs'
import { fixtureKey } from '../fixture-server.mjs'
import { publishProblems } from './publish-guard.mjs'

const BASE = (process.env.APP_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const ids = JSON.parse(process.env.IDS || '{}')
if (!ids.s1 || !ids.s2) throw new Error('IDS must be the JSON printed by seed-rich.mjs ({"s1":…,"s2":…,"s3":…})')

const routes = {}
async function capture(resp) {
  const url = resp.url()
  if (!url.startsWith(BASE + '/api/')) return
  const key = fixtureKey(resp.request().method(), url.slice(BASE.length))
  if (routes[key]) return
  const contentType = resp.headers()['content-type'] || ''
  let buf
  try {
    buf = await resp.body()
  } catch {
    return // aborted / streaming responses are not fixtures
  }
  const text = /json|text|svg|javascript|css/.test(contentType)
  routes[key] = text
    ? { status: resp.status(), contentType, body: buf.toString('utf8') }
    : { status: resp.status(), contentType, encoding: 'base64', body: buf.toString('base64') }
}

const browser = await chromium.launch()
try {
  for (const v of VARIANTS) {
    for (const [name, go] of Object.entries(SCREENS)) {
      const c = await newVariantContext(browser, v)
      const p = await c.newPage()
      p.on('response', capture)
      await go(p, BASE, ids)
      await p.waitForLoadState('networkidle').catch(() => {})
      await c.close()
      process.stdout.write(`recorded ${name} (${v.theme}/${v.mobile ? 'mobile' : 'desktop'})\n`)
    }
  }
  // pages only the flows and Lighthouse visit
  const c = await newVariantContext(browser, VARIANTS[0])
  const p = await c.newPage()
  p.on('response', capture)
  for (const url of [LIGHTHOUSE_PAGES.history(BASE), `${BASE}/#/chat/${ids.s2}`, `${BASE}/#/chat/${ids.s3}`]) {
    await p.goto(url)
    await p.waitForLoadState('networkidle').catch(() => {})
    await p.waitForTimeout(1200)
  }
  await c.close()
} finally {
  await browser.close()
}

// Nothing workspace-specific may land in the repo: the local server's gateway
// host is a loopback fake, the identity is the seed's neutral e2e user.
const out = JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 10), ids, routes }, null, 1)
const problems = publishProblems(out)
if (problems.length) throw new Error(`refusing to write fixtures: ${problems.join('; ')}`)
writeFileSync(FIXTURES_URL, out + '\n')
process.stdout.write(`wrote ${Object.keys(routes).length} routes to ${FIXTURES_URL.pathname}\n`)
