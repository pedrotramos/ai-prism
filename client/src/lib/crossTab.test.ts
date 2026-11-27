import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openCrossTab, planSync } from './crossTab.ts'

// two ends of an in-memory channel: what one posts the other receives
function pair() {
  const ends: { postMessage: (m: unknown) => void; close: () => void; onmessage: ((e: { data: unknown }) => void) | null }[] = []
  const make = () => {
    const end = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (m: unknown) => ends.filter((o) => o !== end).forEach((o) => o.onmessage?.({ data: m })),
      close: () => {},
    }
    ends.push(end)
    return end
  }
  return make
}

test('a turn that ends in one tab reaches the other tab, not itself', () => {
  const make = pair()
  const a: unknown[] = []
  const b: unknown[] = []
  const tabA = openCrossTab((m) => a.push(m), make)
  openCrossTab((m) => b.push(m), make)
  tabA.post({ kind: 'turn-ended', id: '7' })
  assert.deepEqual(b, [{ kind: 'turn-ended', id: '7' }])
  assert.deepEqual(a, [])
})

test('anything that is not a turn-ended message is ignored', () => {
  const make = pair()
  const got: unknown[] = []
  openCrossTab((m) => got.push(m), make)
  const other = make()
  for (const data of [null, 'x', { kind: 'other' }, { kind: 'turn-ended' }, { kind: 'turn-ended', id: 3 }]) other.postMessage(data)
  assert.deepEqual(got, [])
})

test('without BroadcastChannel the tab works alone', () => {
  const tab = openCrossTab(() => assert.fail('no message expected'), null)
  tab.post({ kind: 'turn-ended', id: '1' })
  tab.close()
})

test('planSync: the open conversation reloads unless this tab is mid-turn or mid-load', () => {
  const m = { kind: 'turn-ended', id: '7' } as const
  const idle = { currentId: 7, streaming: false, loadingSession: false }
  assert.deepEqual(planSync(m, idle), { list: true, reload: true })
  assert.deepEqual(planSync(m, { ...idle, currentId: 8 }), { list: true, reload: false })
  assert.deepEqual(planSync(m, { ...idle, currentId: null }), { list: true, reload: false })
  assert.deepEqual(planSync(m, { ...idle, streaming: true }), { list: true, reload: false })
  assert.deepEqual(planSync(m, { ...idle, loadingSession: true }), { list: true, reload: false })
})
