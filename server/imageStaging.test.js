// N7 item 14: generate_image stages its image until the answer commits (like the
// artifact tools, W2-12). The tool writes the bytes to the Volume (it must, to
// hand the model something) but inserts NO chat_images row; the row is written
// by commitTurnAnswer in the answer's transaction. A cancelled turn leaves no
// row, and its Volume file is removed (best effort).
//
//   node --test server/imageStaging.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateImageStaged } from './tools.ts'
import { extractPrismBlocks } from './blocks.ts'

function fakeDeps(over = {}) {
  const calls = { put: [], del: [], create: [] }
  return {
    calls,
    generateImage: async () => ({ dataUrls: ['data:image/png;base64,AAAA'], usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    putImageDataUrl: async (token, relPath) => (calls.put.push(relPath), { volumePath: `/Volumes/x/${relPath}`, contentType: 'image/png', bytes: 3 }),
    deleteImageFile: async (token, p) => (calls.del.push(p), true),
    createImage: async (...a) => (calls.create.push(a), '1'),
    ...over,
  }
}
const ctx = (extra = {}) => ({ sessionId: '9', email: 'a@example.com', lang: 'en', imageModel: 'img-enabled', ...extra })

test('N7-14: the tool writes the file but inserts no chat_images row; the ref is pending', async () => {
  const d = fakeDeps()
  const out = await generateImageStaged('tok', { prompt: 'a cat' }, ctx(), d)
  assert.equal(d.calls.put.length, 1)
  assert.deepEqual(d.calls.create, [], 'no database row before the answer commits')
  assert.equal(out.imageRefs.length, 1)
  const r = out.imageRefs[0]
  assert.match(r.ref, /^img_[A-Za-z0-9_-]+$/)
  assert.ok(r.pending?.volumePath, 'carries what the commit needs to insert the row')
  assert.match(out.resultText, new RegExp(r.ref))
})

test('N7-14: a pending ref resolves into an image block that carries the pending insert, not an id', async () => {
  const d = fakeDeps()
  const { imageRefs } = await generateImageStaged('tok', { prompt: 'a cat' }, ctx(), d)
  const text = '```prism-block\n' + JSON.stringify({ type: 'image', imageRef: imageRefs[0].ref, caption: 'c' }) + '\n```'
  const { blocks } = extractPrismBlocks(text, [], undefined, imageRefs)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'image')
  assert.equal(blocks[0].imageId, undefined)
  assert.equal(blocks[0].pendingImage.volumePath, imageRefs[0].pending.volumePath)
})

test('N7-14: a cancel right after the file was written removes the file and rethrows', async () => {
  const ac = new AbortController()
  const d = fakeDeps({
    putImageDataUrl: async (token, relPath) => {
      ac.abort()
      return { volumePath: `/Volumes/x/${relPath}`, contentType: 'image/png', bytes: 3 }
    },
  })
  await assert.rejects(generateImageStaged('tok', { prompt: 'p' }, ctx({ signal: ac.signal }), d), (e) => e.name === 'AbortError')
  assert.equal(d.calls.del.length, 1)
  assert.deepEqual(d.calls.create, [])
})
