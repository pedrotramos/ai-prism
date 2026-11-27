import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDeckAssets } from './deckAssets.ts'

const MAP = new Map([['illustration_1', 'data:image/png;base64,AAAA']])

test('a double-quoted data-ds-asset-id resolves', () => {
  assert.match(resolveDeckAssets('<img data-ds-asset-id="illustration_1" alt="">', MAP), /src="data:image\/png;base64,AAAA"/)
})

test('a single-quoted data-ds-asset-id resolves to the DS asset', () => {
  const out = resolveDeckAssets("<img data-ds-asset-id='illustration_1' alt=''>", MAP)
  assert.match(out, /src="data:image\/png;base64,AAAA"/)
  assert.doesNotMatch(out, /data-ds-missing/)
})

test('a single-quoted id with the marker kept keeps a well-formed marker', () => {
  assert.match(resolveDeckAssets("<img data-ds-asset-id='illustration_1'>", MAP, { keepMarker: true }), /data-ds-asset-id="illustration_1"/)
})

test('a single-quoted unknown id is marked missing, not left as a remote src', () => {
  assert.match(resolveDeckAssets("<img data-ds-asset-id='nope' src='https://evil.test/x.png'>", MAP), /data-ds-missing="1" src=""/)
})

test('a single-quoted data-ds-logo value resolves', () => {
  assert.match(resolveDeckAssets("<img data-ds-logo='x'>", new Map([['logo', 'data:image/png;base64,BBBB']])), /src="data:image\/png;base64,BBBB"/)
})
