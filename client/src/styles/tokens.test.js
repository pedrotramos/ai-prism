// Contract for the design-token layer (client/src/styles/tokens.css) and the
// static parts of client/src/index.css. The contrast checks compute WCAG 2.x
// ratios from the token values themselves, so a later palette tweak that
// breaks AA fails here instead of in an axe run weeks later.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const tokensCss = readFileSync(here('./tokens.css'), 'utf8')
const indexCss = readFileSync(here('../index.css'), 'utf8')
const indexHtml = readFileSync(here('../../index.html'), 'utf8')

// ---- tiny CSS reader: custom properties per selector block ----
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
function blocks(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(stripComments(css)))) {
    const vars = {}
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim()
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), vars })
  }
  return out
}
const all = blocks(tokensCss)
const varsFor = (pred) => Object.assign({}, ...all.filter((b) => pred(b.selector)).map((b) => b.vars))
const dark = varsFor((s) => s.split(',').map((x) => x.trim()).includes(":root[data-theme='dark']"))
const light = varsFor((s) => s === ":root[data-theme='light']")
const root = varsFor((s) => s === ':root')
const THEMES = { dark, light }

// ---- colour math (WCAG 2.x relative luminance) ----
function resolve(vars, value, depth = 0) {
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) {
    assert.ok(depth < 5, `var() cycle at ${v}`)
    assert.ok(vars[ref[1]], `undefined token ${ref[1]}`)
    return resolve(vars, vars[ref[1]], depth + 1)
  }
  return v
}
function rgba(str) {
  const s = str.trim().toLowerCase()
  if (s === 'white' || s === '#fff') return [255, 255, 255, 1]
  let m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = /^rgba?\(([^)]+)\)$/.exec(s)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  throw new Error(`unsupported colour ${str}`)
}
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])).concat(1)
const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const colour = (vars, name) => rgba(resolve(vars, vars[name]))
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3']

// ---- token presence ----
const COLOUR_TOKENS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--border', '--border-soft',
  '--text', '--muted', '--faint', '--accent', '--accent-strong', '--accent-soft', '--accent-text',
  '--on-accent', '--bubble-user', '--danger', '--success', '--warning', '--info',
  '--disabled-bg', '--disabled-text', '--focus-ring',
  '--shadow-raised', '--shadow-overlay', '--shadow-modal',
  // ui-revamp W0-1 (design.md §4.1)
  '--raised', '--action', '--on-action', '--code-bg', '--chart-neg', '--link',
  '--success-soft', '--warning-soft', '--danger-soft', '--info-soft',
  '--spectrum', '--spectrum-conic',
]

// The role table of design.md §4.1, exact values. ★ marks the AA fixes.
const ROLE_VALUES = {
  light: {
    '--bg': '#eceef1', '--surface': '#fafafb', '--raised': '#ffffff', '--surface-2': '#f2f3f5', '--surface-3': '#e8ebef',
    '--border': '#dadee4', '--border-soft': '#e8ebef',
    '--text': '#1d2229', '--muted': '#4b5360',
    '--faint': '#616975', // ★ (design: #646C78; that is 4.44:1 on --surface-3 and accent-soft, so one notch darker)
    '--accent': '#3d4fd6', '--accent-soft': '#e8eafb', '--accent-text': '#3442b8',
    '--success': '#197650', // ★ (design: #1F8457 is 4.02:1 on --bg and 3.91:1 on --surface-3)
    '--success-soft': '#e3f3ea',
    '--warning': '#8f5a0c', // ★
    '--warning-soft': '#fbf1de', '--danger': '#b83d37', '--chart-neg': '#c8524b', '--code-bg': '#f3f4f7',
  },
  dark: {
    '--bg': '#121519', '--surface': '#181c21', '--raised': '#1f242a', '--surface-2': '#15191d', '--surface-3': '#242930',
    '--border': '#2d333c', '--border-soft': '#242930',
    '--text': '#e6e9ed', '--muted': '#aeb5c0',
    '--faint': '#8d95a2', // ★
    '--accent': '#8c98ff', '--accent-soft': '#262b4d', '--accent-text': '#aab3ff',
    '--success': '#5cc08e', '--success-soft': '#17342a', '--warning': '#e2a94b', '--warning-soft': '#352914',
    '--danger': '#ee7b73', '--chart-neg': '#e07a71', '--code-bg': '#14171b',
  },
}
const SPECTRUM = 'linear-gradient(90deg, #5b6cff, #2fb4c6 28%, #7cc86a 50%, #f0b43c 74%, #ec6a5c)'
const norm = (v) => v.toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/ ?(0\.)/g, ' 0.')

for (const [name, expected] of Object.entries(ROLE_VALUES)) {
  test(`${name}: role values match the §4.1 table`, () => {
    for (const [k, v] of Object.entries(expected)) assert.equal(THEMES[name][k]?.toLowerCase(), v, `${name} ${k}`)
  })
}

test('action buttons are ink on surface in both themes, spectrum is brand data shared by both', () => {
  for (const [name, vars] of Object.entries(THEMES)) {
    assert.equal(vars['--action'], 'var(--text)', name)
    assert.equal(vars['--on-action'], 'var(--surface)', name)
    assert.equal(norm(vars['--spectrum']), norm(SPECTRUM), name)
    assert.match(vars['--spectrum-conic'], /^conic-gradient\(/, name)
  }
})

test('the dark values also apply when the system prefers dark and no theme is set', () => {
  const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(stripComments(tokensCss))
  assert.ok(media, 'tokens.css needs @media (prefers-color-scheme: dark) { :root:not([data-theme=\'light\']) { … } }')
  const inMedia = Object.fromEntries([...media[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]))
  for (const [k, v] of Object.entries(dark)) assert.equal(inMedia[k], v, `${k} drifted between the dark block and the system-dark block`)
})

test('action and on-action reach 4.5:1 against each other (send button, toast)', () => {
  for (const [name, vars] of Object.entries(THEMES)) {
    const r = ratio(colour(vars, '--on-action'), colour(vars, '--action'))
    assert.ok(r >= 4.5, `${name} ${r.toFixed(2)}`)
  }
})

for (const [name, vars] of Object.entries(THEMES)) {
  test(`${name}: faint, status colours and accent-text hold 4.5:1 on --raised and on their own soft fills`, () => {
    for (const fg of ['--text', '--muted', '--faint', '--accent-text', '--danger', '--success', '--warning', '--info']) {
      const r = ratio(colour(vars, fg), colour(vars, '--raised'))
      assert.ok(r >= 4.5, `${name} ${fg} on --raised = ${r.toFixed(2)}:1`)
    }
    for (const [fg, soft] of [['--success', '--success-soft'], ['--warning', '--warning-soft'], ['--accent-text', '--accent-soft'], ['--faint', '--accent-soft']]) {
      const base = colour(vars, '--surface')
      const r = ratio(colour(vars, fg), over(colour(vars, soft), base))
      assert.ok(r >= 4.5, `${name} ${fg} on ${soft} = ${r.toFixed(2)}:1`)
    }
  })
}

test('every colour and shadow token is defined in both themes', () => {
  for (const [name, vars] of Object.entries(THEMES)) {
    for (const t of COLOUR_TOKENS) assert.ok(vars[t], `${name} theme is missing ${t}`)
  }
})

test('scales are defined once on :root: 7 type steps, rhythm, 7 radii, z-index, 3 durations', () => {
  const type = Object.keys(root).filter((k) => k.startsWith('--font-size-'))
  assert.equal(type.length, 7, `type scale has ${type.length} steps: ${type.join(' ')}`)
  assert.deepEqual(
    ['caption', 'label', 'body', 'reading', 'title', 'heading', 'display'].map((k) => [root[`--font-size-${k}`], root[`--line-height-${k}`]]),
    [['12px', '16px'], ['13.5px', '20px'], ['14px', '21px'], ['15.5px', '26px'], ['16px', '22px'], ['22px', '28px'], ['30px', '36px']]
  )
  assert.ok(Math.min(...type.map((k) => parseFloat(root[k]))) >= 12, 'nothing under 12px')
  for (const k of type) assert.ok(root[k.replace('--font-size-', '--line-height-')], `${k} has no line height`)
  assert.equal(root['--space-in-group'], 'var(--space-2)')
  assert.equal(resolve(root, root['--space-2']), '8px')
  assert.equal(resolve(root, root['--space-between-groups']), '24px')
  assert.equal(resolve(root, root['--space-section']), '32px')
  assert.deepEqual(
    ['--radius-card', '--radius-control', '--radius-badge', '--radius-pill', '--radius-panel', '--radius-modal', '--radius-composer'].map((k) => root[k]),
    ['12px', '8px', '6px', '999px', '14px', '16px', '18px']
  )
  assert.equal(root['--bp-overlay'], '1100px')
  assert.equal(root['--bp-mobile'], '760px')
  const z = Object.entries(root).filter(([k]) => k.startsWith('--z-')).map(([, v]) => Number(v))
  assert.ok(z.length >= 6, 'z-index scale too short')
  assert.deepEqual([...z].sort((a, b) => a - b), z, 'z-index tokens must be declared in ascending order')
  assert.deepEqual(
    ['--duration-fast', '--duration-base', '--duration-slow'].map((k) => root[k]),
    ['140ms', '200ms', '320ms']
  )
  assert.equal(root['--ease-emphasized'], 'cubic-bezier(0.2, 0.7, 0.2, 1)')
})

// ---- WCAG contrast in the token values ----
for (const [name, vars] of Object.entries(THEMES)) {
  test(`${name}: text, muted and faint reach 4.5:1 on every surface`, () => {
    for (const fg of ['--text', '--muted', '--faint']) {
      for (const bg of SURFACES) {
        const r = ratio(colour(vars, fg), colour(vars, bg))
        assert.ok(r >= 4.5, `${name} ${fg} on ${bg} = ${r.toFixed(2)}:1`)
      }
    }
  })

  test(`${name}: faint stays a quieter step than muted`, () => {
    const s = colour(vars, '--surface')
    assert.ok(ratio(colour(vars, '--faint'), s) < ratio(colour(vars, '--muted'), s))
  })

  test(`${name}: labels on accent-strong reach 4.5:1, also at hover brightness(1.1)`, () => {
    const on = colour(vars, '--on-accent')
    const fill = colour(vars, '--accent-strong')
    assert.ok(ratio(on, fill) >= 4.5, `${name} on-accent / accent-strong = ${ratio(on, fill).toFixed(2)}`)
    const hover = fill.slice(0, 3).map((c) => Math.min(255, c * 1.1)).concat(1)
    assert.ok(ratio(on, hover) >= 4.5, `${name} hover = ${ratio(on, hover).toFixed(2)}`)
  })

  test(`${name}: accent-text reaches 4.5:1 on accent-soft and on every surface`, () => {
    const fg = colour(vars, '--accent-text')
    const soft = colour(vars, '--accent-soft')
    for (const bg of SURFACES) {
      const base = colour(vars, bg)
      assert.ok(ratio(fg, over(soft, base)) >= 4.5, `${name} accent-text on accent-soft over ${bg}`)
      assert.ok(ratio(fg, base) >= 4.5, `${name} accent-text on ${bg}`)
    }
  })

  test(`${name}: danger, success, warning and info read as text (4.5:1) on every surface`, () => {
    for (const fg of ['--danger', '--success', '--warning', '--info']) {
      for (const bg of SURFACES) {
        const r = ratio(colour(vars, fg), colour(vars, bg))
        assert.ok(r >= 4.5, `${name} ${fg} on ${bg} = ${r.toFixed(2)}:1`)
      }
    }
  })

  test(`${name}: focus ring is a visible indicator (3:1) on every surface`, () => {
    for (const bg of SURFACES) {
      const r = ratio(colour(vars, '--focus-ring'), colour(vars, bg))
      assert.ok(r >= 3, `${name} focus-ring on ${bg} = ${r.toFixed(2)}:1`)
    }
  })
}

// ---- global rules ----
const css = stripComments(indexCss)

test('index.css loads the token layer before Tailwind', () => {
  const imp = css.indexOf("@import './styles/tokens.css'")
  assert.ok(imp >= 0, 'tokens.css is not imported')
  assert.ok(imp < css.indexOf('@tailwind base'), '@import must come before @tailwind')
  assert.ok(!/--faint\s*:/.test(css), 'colour tokens must live only in tokens.css')
})

// The focus ring, reduced motion and the two token bridges are behaviour of
// the cascade, so they are asserted on computed styles in a real browser:
// see tokens.browser.test.js.

test('the viewport allows pinch zoom', () => {
  const meta = /<meta name="viewport" content="([^"]+)"/.exec(indexHtml)
  assert.ok(meta)
  assert.doesNotMatch(meta[1], /maximum-scale|user-scalable\s*=\s*(no|0)/)
})

test('the Tailwind theme reads the CSS variables and the dead palette is gone', async () => {
  const { default: config } = await import(here('../../../tailwind.config.js'))
  const ext = config.theme.extend
  assert.equal(ext.colors.ink, undefined, 'ink.* palette should be removed')
  const flat = (o) => Object.values(o).flatMap((v) => (typeof v === 'object' ? flat(v) : [v]))
  for (const v of flat(ext.colors)) assert.match(v, /^var\(--[\w-]+\)$/, `hard-coded colour ${v}`)
  assert.equal(ext.colors['accent-strong'] ?? ext.colors.accent?.strong, 'var(--accent-strong)')
  for (const k of ['caption', 'label', 'body', 'reading', 'title', 'heading', 'display']) {
    assert.match(String([].concat(ext.fontSize[k])[0]), /^var\(--font-size-/)
  }
  assert.equal(ext.colors.raised, 'var(--raised)')
  assert.equal(ext.colors.sunk, 'var(--surface-2)')
  assert.equal(ext.colors.action, 'var(--action)')
  assert.equal(ext.colors['on-action'], 'var(--on-action)')
  assert.equal(ext.colors.code, 'var(--code-bg)')
  assert.equal(ext.colors['chart-neg'], 'var(--chart-neg)')
  assert.equal(ext.colors.border.soft, 'var(--border-soft)')
  assert.equal(ext.backgroundImage.spectrum, 'var(--spectrum)')
  for (const k of ['panel', 'modal', 'composer']) assert.equal(ext.borderRadius[k], `var(--radius-${k})`)
  assert.equal(ext.screens.ov, '1101px')
  assert.equal(ext.borderRadius.card, 'var(--radius-card)')
  assert.equal(ext.boxShadow.overlay, 'var(--shadow-overlay)')
  assert.equal(ext.zIndex.modal, 'var(--z-modal)')
  assert.equal(ext.transitionDuration.fast, 'var(--duration-fast)')
  assert.equal(ext.spacing['in-group'], 'var(--space-in-group)')
})

// ---- fonts: IBM Plex, bundled (no third-party CDN, nothing for the CSP to allow) ----
test('IBM Plex Sans, Serif and Mono replace Inter and JetBrains Mono', async () => {
  const { default: config } = await import(here('../../../tailwind.config.js'))
  const ff = config.theme.extend.fontFamily
  assert.match(ff.sans[0], /IBM Plex Sans/)
  assert.match(ff.serif[0], /IBM Plex Serif/)
  assert.match(ff.mono[0], /IBM Plex Mono/)
  assert.doesNotMatch(JSON.stringify(ff), /Inter|JetBrains/)
  assert.match(css, /font-family:\s*'IBM Plex Sans'/, 'body uses Plex Sans')
  assert.doesNotMatch(css, /Inter|JetBrains/)
})

test('the Plex faces are bundled through @fontsource imports, not fetched from a CDN', () => {
  for (const face of ['ibm-plex-sans', 'ibm-plex-serif', 'ibm-plex-mono']) {
    assert.match(indexCss, new RegExp(`@import '@fontsource/${face}/`), `index.css must import @fontsource/${face}`)
  }
  assert.doesNotMatch(indexHtml, /fonts\.googleapis|fonts\.gstatic|<link[^>]+stylesheet/)
})

test('the tabular-figures helper exists', () => {
  assert.match(css, /\.num\s*\{[^}]*tabular-nums/)
})

// ---- identity ----
test('the document starts on the system theme (no hard-coded data-theme) and the hook defaults to system', () => {
  assert.doesNotMatch(indexHtml, /<html[^>]*data-theme=/)
  const hook = readFileSync(here('../app/hooks/useSettingsState.ts'), 'utf8')
  assert.match(hook, /stored\('prism-theme',\s*'system'\)/)
})

test('the prism mark: outline triangle, input beam and four spectrum rays; favicon matches', () => {
  const logo = readFileSync(here('../components/Logo.tsx'), 'utf8')
  const fav = readFileSync(here('../../public/favicon.svg'), 'utf8')
  for (const [name, src] of [['Logo.tsx', logo], ['favicon.svg', fav]]) {
    assert.match(src, /M12 3\.5 20\.5 19H3\.5Z/, `${name}: triangle`)
    for (const c of ['#5B6CFF', '#2FB4C6', '#F0B43C', '#EC6A5C']) assert.ok(src.toUpperCase().includes(c), `${name}: ray ${c}`)
    assert.doesNotMatch(src, /#FF3621|#FF8A00|#22C55E|#3B82F6/i, `${name}: old Databricks-red gradient is gone`)
  }
  assert.match(fav, /#161A22/, 'favicon tile')
})
