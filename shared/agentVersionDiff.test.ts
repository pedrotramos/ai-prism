// shared/agentVersionDiff.ts: what changed between two saved versions of an agent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffVersions, lineDiff } from './agentVersionDiff.ts'
import type { VersionContent } from './agentVersionDiff.ts'

const def = (over: Record<string, unknown> = {}) => ({
  instructions: 'Be brief.',
  prompt: 'Summarise last week.',
  model: 'model-a',
  reasoningEffort: null,
  tools: ['web_search'],
  schedule: null,
  lang: 'en',
  ...over,
})
const v = (over: Partial<VersionContent> & { def?: Record<string, unknown> } = {}): VersionContent => ({ name: 'Sales', description: 'd', definition: def(over.def), ...(over.name ? { name: over.name } : {}), ...(over.description !== undefined ? { description: over.description } : {}) })

test('the first version has nothing to compare with', () => {
  assert.deepEqual(diffVersions(null, v()), { changes: [], isEmpty: true })
})

test('identical content is an empty diff, whatever the key order or the empty-string noise', () => {
  const a = v()
  const b: VersionContent = { description: 'd', name: 'Sales', definition: { lang: 'en', schedule: null, tools: ['web_search'], reasoningEffort: undefined as never, model: 'model-a', prompt: 'Summarise last week.', instructions: '  Be brief.  ', extra: '' } }
  assert.equal(diffVersions(a, b).isEmpty, true)
})

test('name and description are compared as values, in that order, before the recipe', () => {
  const d = diffVersions(v(), v({ name: 'Sales 2', description: 'new', def: { model: 'model-b' } }))
  assert.deepEqual(d.changes.map((c) => c.field), ['name', 'description', 'model'])
  assert.deepEqual([d.changes[0]!.before, d.changes[0]!.after, d.changes[0]!.kind], ['Sales', 'Sales 2', 'value'])
  assert.equal(d.isEmpty, false)
})

test('long texts get a line diff with context; same lines far from a change are dropped', () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
  const after = before.replace('line 6', 'line six')
  const d = diffVersions(v({ def: { instructions: before } }), v({ def: { instructions: after } }))
  const c = d.changes[0]!
  assert.equal(c.field, 'instructions')
  assert.equal(c.kind, 'text')
  assert.deepEqual(c.lines!.filter((l) => l.op !== 'same'), [{ op: 'del', text: 'line 6' }, { op: 'add', text: 'line six' }])
  assert.ok(c.lines!.length <= 6, 'two lines of context on each side, no more')
  assert.ok(!c.lines!.some((l) => l.text === 'line 0'))
})

test('lineDiff: additions at the end, removals at the start, an empty side, and a text too large for the table', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb\nc'), [{ op: 'same', text: 'a' }, { op: 'same', text: 'b' }, { op: 'add', text: 'c' }])
  assert.deepEqual(lineDiff('a\nb', 'b'), [{ op: 'del', text: 'a' }, { op: 'same', text: 'b' }])
  assert.deepEqual(lineDiff('', 'x'), [{ op: 'add', text: 'x' }])
  assert.deepEqual(lineDiff('x', ''), [{ op: 'del', text: 'x' }])
  const big = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n')
  const big2 = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n')
  const out = lineDiff(big, big2)
  assert.equal(out.length, 1200, 'past the cap the two texts are shown whole')
  assert.ok(out.slice(0, 600).every((l) => l.op === 'del') && out.slice(600).every((l) => l.op === 'add'))
})

test('tools are a set diff; the same members in another order is flagged as reordered', () => {
  const d = diffVersions(v({ def: { tools: ['web_search', 'genie_one'] } }), v({ def: { tools: ['genie_one', 'artifact:deck'] } }))
  assert.deepEqual([d.changes[0]!.kind, d.changes[0]!.added, d.changes[0]!.removed], ['set', ['artifact:deck'], ['web_search']])
  const r = diffVersions(v({ def: { tools: ['a', 'b'] } }), v({ def: { tools: ['b', 'a'] } }))
  assert.equal(r.changes[0]!.reordered, true)
  assert.deepEqual(r.changes[0]!.added, [])
})

test('the schedule and the effort are compared as values (null is "none")', () => {
  const sched = { freq: 'daily', minute: 0, hour: 8, tz: 'UTC' }
  const d = diffVersions(v(), v({ def: { schedule: sched, reasoningEffort: 'high' } }))
  assert.deepEqual(d.changes.map((c) => c.field), ['reasoningEffort', 'schedule'])
  assert.deepEqual(d.changes[1]!.before, null)
  assert.deepEqual(d.changes[1]!.after, sched)
  // a changed hour inside the schedule is a change
  assert.equal(diffVersions(v({ def: { schedule: sched } }), v({ def: { schedule: { ...sched, hour: 9 } } })).changes.length, 1)
})

test('a payload this module does not know (a flow graph) still shows up as changed', () => {
  const g1 = { nodes: [{ id: 'a' }], edges: [] }
  const g2 = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }
  const d = diffVersions(v({ def: { graph: g1 } }), v({ def: { graph: g2 } }))
  assert.deepEqual(d.changes.map((c) => [c.field, c.kind]), [['graph', 'value']])
  assert.deepEqual(d.changes[0]!.after, g2)
  assert.equal(diffVersions(v({ def: { graph: g1 } }), v({ def: { graph: { edges: [], nodes: [{ id: 'a' }] } } })).isEmpty, true, 'key order is not a change')
  // a key that appears or disappears
  assert.equal(diffVersions(v(), v({ def: { graph: g1 } })).changes[0]!.field, 'graph')
})
