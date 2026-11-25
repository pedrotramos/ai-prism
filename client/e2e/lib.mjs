// Shared pieces of the e2e/a11y harness (seeded from the UX baseline harness of
// 2026-11-17): the fetch shim for the three turn routes, the 4 screens × 2
// themes × 2 widths matrix, and the touch-target / accessible-name scan.
import { readFileSync } from 'node:fs'
import { routeToolUsage } from './web-search-cost-fixtures.mjs'

export const FIXTURES_URL = new URL('./fixtures/api.json', import.meta.url)
export const loadFixtures = () => JSON.parse(readFileSync(FIXTURES_URL, 'utf8'))

// /api/chat, /continue and /regenerate return a stream the test feeds with
// real SSE event shapes through window.__sse.push(obj) / .end(), or an HTTP
// 500 when window.__sseMode = 'http500'. Everything else goes to the network
// (the fixture server in CI).
export const FETCH_SHIM = `(() => {
  const orig = window.fetch.bind(window)
  window.__sseMode = 'stream'
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (/\\/api\\/chat$|\\/continue$|\\/regenerate$/.test(url)) {
      if (window.__sseMode === 'http500') return Promise.resolve(new Response(JSON.stringify({ error: 'AI Gateway returned 503: upstream model temporarily unavailable' }), { status: 500, headers: { 'content-type': 'application/json' } }))
      let ctrl
      const enc = new TextEncoder()
      const body = new ReadableStream({ start(c) { ctrl = c } })
      window.__sse = { push: (o) => ctrl.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\\n\\n')), end: () => ctrl.close() }
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    }
    return orig(input, init)
  }
})()`

export const VARIANTS = [
  { theme: 'dark', mobile: false },
  { theme: 'dark', mobile: true },
  { theme: 'light', mobile: false },
  { theme: 'light', mobile: true },
]
export const variantName = (v) => `${v.theme}-${v.mobile ? 'mobile' : 'desktop'}`

export function contextOptions({ theme = 'dark', mobile = false } = {}) {
  return {
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
    // the selectors and the counts assume the English UI (i18n follows
    // navigator.language) and a fixed clock zone for "x hours ago" groupings
    locale: 'en-US',
    timezoneId: 'UTC',
  }
}

/** A browser context in the given variant with theme + fetch shim installed. */
export async function newVariantContext(browser, variant) {
  const c = await browser.newContext(contextOptions(variant))
  await c.addInitScript((th) => {
    try {
      localStorage.setItem('prism-theme', th)
    } catch {
      // sandboxed slide iframes have no storage; the theme only matters on the top page
    }
  }, variant.theme)
  await c.addInitScript(FETCH_SHIM)
  return c
}

const settle = (p, ms = 600) => p.waitForTimeout(ms)

// Waits until the page stops growing or scrolling (the chat auto-scrolls while
// blocks, charts and slide previews render), then pins the main scroll area
// to its natural end state, the bottom. Without this, how many elements are
// in the viewport — and so the axe and touch-target counts — varies per run.
export async function stableLayout(p, { pinBottom = false, timeoutMs = 10_000 } = {}) {
  await p.evaluate(
    async ({ pinBottom, timeoutMs }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const main = () => {
        const els = [...document.querySelectorAll('*')].filter((e) => {
          const s = getComputedStyle(e)
          return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 20
        })
        els.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)
        return els[0] || null
      }
      const sig = () => {
        const m = main()
        return `${document.body.scrollHeight}|${m ? `${m.scrollHeight}:${Math.round(m.scrollTop)}` : '-'}`
      }
      const deadline = Date.now() + timeoutMs
      let last = sig()
      let stable = 0
      while (Date.now() < deadline && stable < 4) {
        await sleep(250)
        const now = sig()
        stable = now === last ? stable + 1 : 0
        last = now
      }
      if (pinBottom) {
        const m = main()
        if (m) m.scrollTop = m.scrollHeight
        await sleep(300)
      }
    },
    { pinBottom, timeoutMs }
  )
}

// The four screens of the regression bar. `ids` come from the fixtures (the
// seeded sessions). Each step waits for a concrete element, then lets the
// 250 ms fade-in finish so axe sees the final paint.
export const SCREENS = {
  welcome: async (p, base) => {
    await p.goto(`${base}/#/chat`)
    await p.locator('textarea').first().waitFor()
    await settle(p)
    await stableLayout(p)
  },
  'chat-rich': async (p, base, ids) => {
    await p.goto(`${base}/#/chat/${ids.s1}`)
    await p.getByText('Open in Slides Studio').first().waitFor()
    await settle(p, 1000)
    await stableLayout(p, { pinBottom: true })
  },
  'settings-preferences': async (p, base) => {
    await p.goto(`${base}/#/chat`)
    await p.locator('textarea').first().waitFor()
    // the topbar's gear is named exactly "Settings" (the sidebar footer's is "Open settings")
    await p.getByRole('button', { name: 'Settings', exact: true }).click()
    await p.getByRole('button', { name: 'Preferences', exact: true }).first().waitFor()
    await settle(p, 800)
    await stableLayout(p)
  },
  'deck-studio': async (p, base, ids) => {
    await p.goto(`${base}/#/chat/${ids.s1}`)
    const open = p.getByText('Open in Slides Studio').first()
    await open.waitFor()
    await stableLayout(p)
    await open.scrollIntoViewIfNeeded()
    await open.click()
    await p.locator('iframe').first().waitFor()
    await settle(p, 1500)
    await stableLayout(p)
  },
}

// Admin Costs: every /api/costs* request is answered here (no warehouse), by breakdown, so the page and its
// people KPIs render the same numbers on any day. The dates are not asserted anywhere.
const COSTS_ROWS = {
  resource: [
    { product: 'MODEL_SERVING', resource_id: 'databricks-claude-sonnet-5-5', dbus: 180.5, usd: 12.6 },
    { product: 'SQL', resource_id: 'warehouse-demo', dbus: 6, usd: 4.2 },
    { product: 'APPS', resource_id: 'ai-prism', dbus: 10, usd: 0.7 },
  ],
  model: [{ endpoint_name: 'databricks-claude-sonnet-5-5', requests: 420, prompt_tokens: 900000, completion_tokens: 100000, total_tokens: 1000000, dbus: 180.5, usd: 12.6 }],
  person: [
    { user_email: 'ana@example.com', requests: 300, total_tokens: 700000, dbus: 120, usd: 8.4 },
    { user_email: 'bruno@example.com', requests: 150, total_tokens: 303000, dbus: 61.5, usd: 4.27 },
  ],
  tag: [{ tag_value: '1234', infra_usd: 4.9, ai_usd: 12.67, dbus: 197.5, usd: 17.57 }],
}

export async function routeCosts(p) {
  await routeToolUsage(p)
  await p.route('**/api/costs**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/costs/meta') return route.fulfill({ json: { breakdowns: ['resource', 'model', 'person', 'tag'], tagKeys: ['cost_center'], maxDays: 366 } })
    const by = url.searchParams.get('by') || 'resource'
    const rows = COSTS_ROWS[by] || []
    const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0)
    return route.fulfill({
      json: { by, period: { from: url.searchParams.get('from'), to: url.searchParams.get('to') }, currency: 'USD', tagKey: by === 'tag' ? 'cost_center' : undefined, rows, totals: { usd: sum('usd'), dbus: sum('dbus') } },
    })
  })
}

// ui-revamp W2-4: the screens the revamp added. Projects and Agents read the recorded fixtures (api.json); Costs is
// answered by routeCosts above.
SCREENS.projects = async (p, base) => {
  await p.goto(`${base}/#/projects`)
  await p.getByRole('heading', { name: 'Projects', level: 1 }).waitFor()
  await p.getByRole('button', { name: /Revenue analytics/ }).first().waitFor()
  await settle(p, 800)
  await stableLayout(p)
}
SCREENS['project-detail'] = async (p, base) => {
  await p.goto(`${base}/#/projects/3`)
  await p.getByRole('heading', { name: 'Revenue analytics', level: 1 }).waitFor()
  await p.getByRole('heading', { name: 'Members' }).waitFor()
  await settle(p, 800)
  await stableLayout(p)
}
SCREENS.agents = async (p, base) => {
  await p.goto(`${base}/#/agents`)
  await p.getByRole('heading', { name: 'Agents', level: 1 }).waitFor()
  await p.getByText('Weekly sales summary').first().waitFor()
  await settle(p, 800)
  await stableLayout(p)
}
SCREENS.costs = async (p, base) => {
  await routeCosts(p)
  await p.goto(`${base}/#/costs`)
  await p.getByRole('heading', { name: 'Costs', level: 1 }).waitFor()
  await p.getByText('databricks-claude-sonnet-5-5').first().waitFor()
  await settle(p, 800)
  await stableLayout(p)
}

/** Lighthouse pages (dark desktop, fresh profile), as in the baseline. */
export const LIGHTHOUSE_PAGES = {
  welcome: (base) => `${base}/#/chat`,
  chat: (base, ids) => `${base}/#/chat/${ids.s1}`,
  history: (base) => `${base}/#/history`,
}

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** Visible interactive elements: how many are under 24×24 px and how many have no name. */
export async function touchTargets(p) {
  return p.evaluate(() => {
    const els = [...document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')]
    const vis = els.filter((e) => {
      const r = e.getBoundingClientRect()
      const cs = getComputedStyle(e)
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight
    })
    const all = vis.map((e) => {
      const r = e.getBoundingClientRect()
      // the name a screen reader gets, in the order of the accessible-name computation: aria-labelledby, aria-label,
      // an associated <label> (for= or wrapping), title, text, placeholder. A date input named by its <label for>
      // is named; counting it as "unnamed" measured the markup, not the user's experience (axe `label` agrees).
      const byIds = (e.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
      const labelText = e.labels ? [...e.labels].map((l) => l.textContent || '').join(' ') : ''
      const name = [byIds, e.getAttribute('aria-label'), labelText, e.getAttribute('title'), e.innerText, e.getAttribute('placeholder')].map((x) => (x || '').trim()).find(Boolean) || ''
      return { name: name.slice(0, 40), tag: e.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) }
    })
    const under24 = all.filter((s) => s.w < 24 || s.h < 24)
    return { total: all.length, under24: under24.length, noName: all.filter((s) => !s.name).length, under24List: under24 }
  })
}
