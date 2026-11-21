// readAsDataUrl must settle on EVERY terminal outcome of a FileReader read
// (load, error, abort): the deck studio holds an attachment slot until the
// read settles (DeckStudio useAttachBudget), so a pending promise would keep
// a slot reserved forever (QA W2-16 r2).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readAsDataUrl } from './usePromptImages.ts'

const realFileReader = globalThis.FileReader
afterEach(() => {
  globalThis.FileReader = realFileReader
})

/** A FileReader that ends its read with `outcome`, firing the events a browser fires. */
type ReaderEvent = { type: string }
type ReaderListener = (e: ReaderEvent) => void

function fakeReader(outcome: string): typeof FileReader {
  class Fake {
    result: string | null = null
    listeners: Record<string, ReaderListener[]> = {}
    addEventListener(type: string, fn: ReaderListener) {
      ;(this.listeners[type] ||= []).push(fn)
    }
    fire(type: string) {
      ;(this as unknown as Record<string, ReaderListener | undefined>)[`on${type}`]?.({ type })
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
  return Fake as unknown as typeof FileReader // the double implements only what readAsDataUrl uses
}

const settled = (p: Promise<unknown>, ms = 200) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r('pending'), ms))])
const blob = {} as Blob // never read: the fake reader ignores its argument

test('a completed read resolves with its data URL', async () => {
  globalThis.FileReader = fakeReader('load')
  assert.deepEqual(await settled(readAsDataUrl(blob)), { v: 'data:image/png;base64,AAAA' })
})

test('a failed read resolves with null', async () => {
  globalThis.FileReader = fakeReader('error')
  assert.deepEqual(await settled(readAsDataUrl(blob)), { v: null })
})

test('an aborted read resolves with null instead of staying pending', async () => {
  globalThis.FileReader = fakeReader('abort')
  assert.deepEqual(await settled(readAsDataUrl(blob)), { v: null })
})

test('a read that throws synchronously (readAsDataURL rejects the argument) resolves with null', async () => {
  globalThis.FileReader = class {
    readAsDataURL() {
      throw new TypeError("Failed to execute 'readAsDataURL' on 'FileReader': parameter 1 is not of type 'Blob'.")
    }
  } as unknown as typeof FileReader // only readAsDataURL is exercised
  assert.deepEqual(await settled(readAsDataUrl(blob)), { v: null })
})
