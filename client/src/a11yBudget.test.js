// Static-count guard for the W3-8 accessibility and token sweep. Fails when a
// budget is exceeded; rules and tagging convention are in a11yBudget.js and
// docs/ui-tokens.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outlineWithoutFocusVisible, arbitraryZIndex, fontSizeClasses, untaggedOneOffs } from './a11yBudget.js'

const SRC = path.dirname(fileURLToPath(import.meta.url))

// Files outside the W3-8 edit scope while their owners' PRs were open. Each
// carries a frozen ceiling (it may only go down); once the owner's follow-up
// lands, delete the entry. Do not add files here.
const FOLLOW_UP = {
  'components/DeckStudio.jsx': { oneOff: 23, outline: 4 },
  'components/Sidebar.jsx': { oneOff: 5, outline: 1 },
  'components/HistoryPage.jsx': { oneOff: 3, outline: 3 },
  'components/ModelPicker.jsx': { oneOff: 12, outline: 1 },
  'components/MemorySection.jsx': { oneOff: 1, outline: 3, z: 1 },
  'components/MemoryAdminCard.jsx': { oneOff: 1 },
  'components/PersonalTab.jsx': { outline: 1 },
  'components/projects/MoveToProjectDialog.jsx': { oneOff: 1 },
  'components/projects/ProjectDetail.jsx': { oneOff: 1 },
  'components/projects/ui.jsx': { oneOff: 1 },
}
const ONE_OFF_BUDGET = 60 // untagged one-off values outside FOLLOW_UP files
const MAX_FONT_SIZE_CLASSES = 6

function sources() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsx')) out.push({ rel: path.relative(SRC, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') })
    }
  }
  walk(SRC)
  return out
}
const files = sources()
const ceiling = (rel, key) => FOLLOW_UP[rel]?.[key] ?? 0

test('every follow-up entry points at a real file', () => {
  for (const rel of Object.keys(FOLLOW_UP)) assert.ok(files.some((f) => f.rel === rel), `${rel} no longer exists: remove it from FOLLOW_UP`)
})

test('outline-none always has a same-line focus-visible: utility', () => {
  for (const f of files) {
    const hits = outlineWithoutFocusVisible(f.text)
    assert.ok(hits.length <= ceiling(f.rel, 'outline'), `${f.rel}: outline-none without focus-visible: on line(s) ${hits.join(', ')}`)
  }
})

test('no arbitrary z-index values: use the scale in tokens.css', () => {
  for (const f of files) assert.ok(arbitraryZIndex(f.text) <= ceiling(f.rel, 'z'), `${f.rel}: arbitrary z-[…] (use z-modal, z-popover …)`)
})

test(`at most ${MAX_FONT_SIZE_CLASSES} distinct legacy font-size classes (use text-caption … text-display)`, () => {
  const all = new Set(files.flatMap((f) => fontSizeClasses(f.text)))
  assert.ok(all.size <= MAX_FONT_SIZE_CLASSES, `${all.size} distinct: ${[...all].sort().join(', ')}`)
})

test(`untagged one-off style values stay within ${ONE_OFF_BUDGET} (tag data with /* data */)`, () => {
  let total = 0
  const per = []
  for (const f of files) {
    const n = untaggedOneOffs(f.text)
    if (f.rel in FOLLOW_UP) assert.ok(n <= ceiling(f.rel, 'oneOff'), `${f.rel}: ${n} untagged one-off values (frozen ceiling ${ceiling(f.rel, 'oneOff')})`)
    else total += n
    if (n) per.push(`${f.rel}:${n}`)
  }
  assert.ok(total <= ONE_OFF_BUDGET, `${total} > ${ONE_OFF_BUDGET}: ${per.join(' ')}`)
})

test('guard functions detect violations in fixtures (RED proof)', () => {
  assert.deepEqual(outlineWithoutFocusVisible('<i className="outline-none" />\n<i className="outline-none focus-visible:ring-2" />'), [1])
  assert.equal(arbitraryZIndex('<i className="fixed z-[75] z-modal" />'), 1)
  assert.deepEqual(fontSizeClasses('text-xs md:text-[11px] text-body prose-sm'), ['xs', '[11px]'])
  assert.equal(untaggedOneOffs('<i style={{ a: 1 }} className="w-[10px] bg-white" />'), 3)
  assert.equal(untaggedOneOffs('<i /* data */ style={{ a: 1 }} />'), 0)
  assert.equal(untaggedOneOffs('// x /* data: swatch */\nconst c = "#fff"'), 0)
  assert.equal(untaggedOneOffs('/* data:start logo */\nconst c = "#fff"\n/* data:end */\nconst d = "#000"'), 1)
})
