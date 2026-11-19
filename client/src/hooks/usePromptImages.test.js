// readAsDataUrl must settle on EVERY terminal outcome of a FileReader read
// (load, error, abort): the deck studio holds an attachment slot until the
// read settles (DeckStudio useAttachBudget), so a pending promise would keep
// a slot reserved forever (QA W2-16 r2).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readAsDataUrl } from './usePromptImages.js'

const realFileReader = globalThis.FileReader
afterEach(() => {
  globalThis.FileReader = realFileReader
})

/** A FileReader that ends its read with `outcome`, firing the events a browser fires. */
function fakeReader(outcome) {
  return class {
    constructor() {
      this.result = null
      this.listeners = {}
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] ||= []).push(fn)
    }
    fire(type) {
      this[`on${type}`]?.({ type })
      for (const fn of this.listeners[type] || []) fn({ type })
    }
    readAsDataURL() {
      queueMicrotask(() => {
        if (outcome === 'load') this.result = 'data:image/png;base64,AAAA'
        this.fire(outcome)
        this.fire('loadend')
      })
    }
  }
}

const settled = (p, ms = 200) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r('pending'), ms))])

test('a completed read resolves with its data URL', async () => {
  globalThis.FileReader = fakeReader('load')
  assert.deepEqual(await settled(readAsDataUrl({})), { v: 'data:image/png;base64,AAAA' })
})

test('a failed read resolves with null', async () => {
  globalThis.FileReader = fakeReader('error')
  assert.deepEqual(await settled(readAsDataUrl({})), { v: null })
})

test('an aborted read resolves with null instead of staying pending', async () => {
  globalThis.FileReader = fakeReader('abort')
  assert.deepEqual(await settled(readAsDataUrl({})), { v: null })
})
