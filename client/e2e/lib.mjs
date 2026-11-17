// Shared pieces of the e2e/a11y harness (seeded from the UX baseline harness of
// 2026-11-17): the fetch shim for the three turn routes, the 4 screens × 2
// themes × 2 widths matrix, and the touch-target / accessible-name scan.
import { readFileSync } from 'node:fs'

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
    await p.locator('button[title="Settings"]').first().click()
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
      return { name: (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '').trim().slice(0, 40), tag: e.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) }
    })
    const under24 = all.filter((s) => s.w < 24 || s.h < 24)
    return { total: all.length, under24: under24.length, noName: all.filter((s) => !s.name).length, under24List: under24 }
  })
}
