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
]

test('every colour and shadow token is defined in both themes', () => {
  for (const [name, vars] of Object.entries(THEMES)) {
    for (const t of COLOUR_TOKENS) assert.ok(vars[t], `${name} theme is missing ${t}`)
  }
})

test('scales are defined once on :root: 6 type steps, rhythm, 4 radii, z-index, 3 durations', () => {
  const type = Object.keys(root).filter((k) => k.startsWith('--font-size-'))
  assert.equal(type.length, 6, `type scale has ${type.length} steps: ${type.join(' ')}`)
  for (const k of type) assert.ok(root[k.replace('--font-size-', '--line-height-')], `${k} has no line height`)
  assert.equal(root['--space-in-group'], 'var(--space-2)')
  assert.equal(resolve(root, root['--space-2']), '8px')
  assert.equal(resolve(root, root['--space-between-groups']), '24px')
  assert.equal(resolve(root, root['--space-section']), '32px')
  assert.deepEqual(
    ['--radius-card', '--radius-control', '--radius-badge', '--radius-pill'].map((k) => root[k]),
    ['12px', '8px', '6px', '9999px']
  )
  const z = Object.entries(root).filter(([k]) => k.startsWith('--z-')).map(([, v]) => Number(v))
  assert.ok(z.length >= 6, 'z-index scale too short')
  assert.deepEqual([...z].sort((a, b) => a - b), z, 'z-index tokens must be declared in ascending order')
  assert.deepEqual(
    ['--duration-fast', '--duration-base', '--duration-slow'].map((k) => root[k]),
    ['150ms', '200ms', '300ms']
  )
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
  for (const k of ['caption', 'label', 'body', 'title', 'heading', 'display']) {
    assert.match(String([].concat(ext.fontSize[k])[0]), /^var\(--font-size-/)
  }
  assert.equal(ext.borderRadius.card, 'var(--radius-card)')
  assert.equal(ext.boxShadow.overlay, 'var(--shadow-overlay)')
  assert.equal(ext.zIndex.modal, 'var(--z-modal)')
  assert.equal(ext.transitionDuration.fast, 'var(--duration-fast)')
  assert.equal(ext.spacing['in-group'], 'var(--space-in-group)')
})
