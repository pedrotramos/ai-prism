// Computed-style contract for the global rules in client/src/index.css, checked
// in a real Chrome against the stylesheet compiled from the current source with
// the project's own Vite config (same Tailwind/PostCSS pipeline as
// `npm run bundle`, built in memory; client/dist is not read because feature
// branches do not commit it). Static checks of the CSS source cannot see the
// cascade: a rule can be present and still lose to a Tailwind utility.
//
// Dependencies: `vite` (an existing devDependency, which loads the
// tailwindcss/postcss/autoprefixer pipeline from postcss.config.js) compiles the
// CSS. No browser-automation package (Playwright, Puppeteer) is needed: Chrome
// is driven over the DevTools protocol with Node's built-in WebSocket
// (Node >= 22). The browser binary is found through CHROME_PATH,
// the Playwright cache or the usual install paths; GitHub's ubuntu runners ship
// Google Chrome. Without a browser the tests are skipped with the reason
// printed, never silently.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

function findChrome() {
  const env = process.env.CHROME_PATH
  if (env) return existsSync(env) ? env : null
  const fixed = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  const caches = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]
  const fromCache = caches.flatMap((dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((d) => d.startsWith('chromium-'))
      .flatMap((d) => [
        join(dir, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(dir, d, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(dir, d, 'chrome-linux64/chrome'),
        join(dir, d, 'chrome-linux/chrome'),
      ])
  })
  return [...fixed, ...fromCache].find((p) => existsSync(p)) || null
}

// Tailwind resolves tailwind.config.js and its `content` globs from the working
// directory, so the build runs from the repository root.
async function compileCss() {
  const { build } = await import('vite')
  const cwd = process.cwd()
  process.chdir(REPO)
  try {
    const out = await build({ configFile: join(REPO, 'vite.config.js'), logLevel: 'silent', build: { write: false } })
    const assets = [out].flat().flatMap((o) => o.output)
    const css = assets.filter((a) => a.type === 'asset' && a.fileName.endsWith('.css'))
    assert.equal(css.length, 1, `expected one stylesheet, got ${css.map((a) => a.fileName)}`)
    return String(css[0].source)
  } finally {
    process.chdir(cwd)
  }
}

const CHROME = findChrome()
const SKIP = typeof WebSocket !== 'function'
  ? 'global WebSocket unavailable (needs Node >= 22)'
  : !CHROME
    ? 'no Chrome/Chromium binary found; set CHROME_PATH to run the browser contract'
    : false
if (SKIP) console.warn(`[tokens.browser.test] SKIPPED: ${SKIP}`)

// ---- minimal DevTools-protocol client ----
let chrome, profile, ws, css, seq = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }))
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
  return r.result.value
}
async function pressTab() {
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

before(async () => {
  if (SKIP) return
  css = await compileCss()
  profile = mkdtempSync(join(tmpdir(), 'prism-tokens-chrome-'))
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions']
  // Ubuntu 24.04 runners block the unprivileged user namespace Chrome's sandbox
  // needs; the page is a local static file, so the sandbox adds nothing here.
  if (process.platform === 'linux') args.push('--no-sandbox')
  chrome = spawn(CHROME, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const browserWs = await new Promise((resolve, reject) => {
    let err = ''
    const t = setTimeout(() => reject(new Error(`Chrome did not start: ${err.slice(-400)}`)), 20000)
    chrome.stderr.on('data', (d) => {
      err += d
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
      if (m) { clearTimeout(t); resolve(m[1]) }
    })
    chrome.on('exit', (code) => { clearTimeout(t); reject(new Error(`Chrome exited (${code}): ${err.slice(-400)}`)) })
  })
  const port = new URL(browserWs).port
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    const p = msg.id && pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result)
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')) })
  await send('Runtime.enable')
})

after(async () => {
  ws?.close()
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve))
    chrome.kill()
    await exited
  }
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// The page uses the compiled CSS and the exact utility classes components use
// today (composer textarea: `outline-none`; filled CTA: `bg-[var(--accent)]
// text-white`; active tab: `bg-[var(--accent-soft)] text-[var(--accent)]`).
let pageSeq = 0
async function load(theme, reducedMotion) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-tokens-page-'))
  const file = join(dir, `p${++pageSeq}.html`)
  writeFileSync(file, `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="pane" style="background: var(--surface); padding: 24px">
  <button id="plain" class="rounded-lg px-3 py-2 transition">Plain button</button>
  <textarea id="composer" class="flex-1 resize-none bg-transparent outline-none text-[15px] leading-relaxed"></textarea>
  <div id="editable" contenteditable="true" class="outline-none">Editable</div>
  <button id="cta" class="rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm py-2.5 transition">New chat</button>
  <button id="tab" class="bg-[var(--accent-soft)] text-[var(--accent)] font-semibold">Tone</button>
  <span id="spin" class="block w-3 h-3 animate-spin"></span>
  <div id="fade" class="animate-fade-in">Fade</div>
  <span id="cursor" class="stream-cursor">Streaming</span>
</div></body></html>`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion }] })
  await send('Page.navigate', { url: pathToFileURL(file).href })
  for (let i = 0; i < 100; i++) {
    if ((await evaluate('document.readyState === "complete" && !!document.getElementById("cursor")')) === true) break
    await new Promise((r) => setTimeout(r, 50))
  }
  rmSync(dir, { recursive: true, force: true })
}

// WCAG contrast between two computed `rgb()` / `rgba()` strings (opaque ones).
function rgb(s) {
  const p = /rgba?\(([^)]+)\)/.exec(s)?.[1].split(/[\s,/]+/).map(Number)
  assert.ok(p, `not an rgb colour: ${s}`)
  return p
}
function ratio(a, b) {
  const lum = ([r, g, bl]) => {
    const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl)
  }
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

for (const theme of ['dark', 'light']) {
  test(`${theme}: keyboard focus draws the --focus-ring outline on every control, outline-none included`, { skip: SKIP }, async () => {
    await load(theme, 'no-preference')
    const ring = await evaluate(`(() => { const c = document.createElement('i'); c.style.color = 'var(--focus-ring)'; document.body.append(c); return getComputedStyle(c).color })()`)
    const surface = await evaluate(`getComputedStyle(document.getElementById('pane')).backgroundColor`)
    await evaluate('document.activeElement.blur(); window.focus()')
    for (const id of ['plain', 'composer', 'editable', 'cta', 'tab']) {
      await pressTab()
      const s = await evaluate(`(() => { const el = document.activeElement; const cs = getComputedStyle(el);
        return { id: el.id, focusVisible: el.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset } })()`)
      assert.equal(s.id, id, `Tab order reached ${s.id} instead of ${id}`)
      assert.equal(s.focusVisible, true, `${id} is not :focus-visible after Tab`)
      assert.deepEqual([s.style, s.width, s.offset], ['solid', '2px', '2px'], `${theme} #${id} outline`)
      assert.equal(s.color, ring, `${theme} #${id} outline colour ${s.color} is not --focus-ring ${ring}`)
      assert.ok(ratio(s.color, surface) >= 3, `${theme} #${id} ring ${s.color} on ${surface} = ${ratio(s.color, surface).toFixed(2)}:1`)
    }
  })

  test(`${theme}: reduced motion leaves no transition or animation, the stream cursor is static`, { skip: SKIP }, async () => {
    await load(theme, 'reduce')
    const m = await evaluate(`(() => { const cs = (id, pseudo) => getComputedStyle(document.getElementById(id), pseudo);
      const all = [...document.querySelectorAll('*')].flatMap((el) => [el, ...['::before', '::after'].map((p) => [el, p])]);
      const moving = all.filter((x) => { const s = Array.isArray(x) ? getComputedStyle(x[0], x[1]) : getComputedStyle(x);
        return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || s.animationName !== 'none' }).length;
      return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches, moving,
        transition: [cs('cta').transitionProperty, cs('cta').transitionDuration],
        spin: cs('spin').animationName, fade: [cs('fade').animationName, cs('fade').opacity],
        cursor: [cs('cursor', '::after').animationName, cs('cursor', '::after').opacity, cs('cursor', '::after').content],
        scroll: getComputedStyle(document.documentElement).scrollBehavior } })()`)
    assert.equal(m.matches, true)
    assert.deepEqual(m.transition, ['none', '0s'], 'transitions must be off, not shortened')
    assert.equal(m.spin, 'none')
    assert.deepEqual(m.fade, ['none', '1'], 'entrance animations must not leave content invisible')
    assert.deepEqual(m.cursor, ['none', '1', '"▋"'], 'stream cursor must be static and visible')
    assert.equal(m.scroll, 'auto')
    assert.equal(m.moving, 0, `${m.moving} elements still transition or animate`)
  })

  test(`${theme}: without the preference, motion is untouched`, { skip: SKIP }, async () => {
    await load(theme, 'no-preference')
    const m = await evaluate(`(() => { const cs = (id, p) => getComputedStyle(document.getElementById(id), p);
      return [cs('cta').transitionDuration, cs('spin').animationName, cs('cursor', '::after').animationName] })()`)
    assert.deepEqual(m, ['0.15s', 'spin', 'blink'])
  })

  test(`${theme}: filled accent buttons and accent-on-soft tabs compute to the AA tokens`, { skip: SKIP }, async () => {
    await load(theme, 'no-preference')
    const c = await evaluate(`(() => { const tok = (v) => { const i = document.createElement('i'); i.style.color = 'var(' + v + ')'; document.body.append(i); return getComputedStyle(i).color };
      const cs = (id) => getComputedStyle(document.getElementById(id));
      return { cta: cs('cta').backgroundColor, ctaText: cs('cta').color, strong: tok('--accent-strong'), tab: cs('tab').color, accentText: tok('--accent-text') } })()`)
    assert.equal(c.cta, c.strong)
    assert.ok(ratio(c.ctaText, c.cta) >= 4.5, `${theme} CTA label ${ratio(c.ctaText, c.cta).toFixed(2)}:1`)
    assert.equal(c.tab, c.accentText)
  })
}
