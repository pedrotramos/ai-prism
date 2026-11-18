// The per-turn artifact stage (server/artifactPersist.js, W2-12): an artifact a
// tool creates is held in memory and written into the answer as a prism-block
// fence right after its tool-call marker, so commitTurnAnswer persists it inside
// the answer transaction. Nothing here touches the database.
//   node --test server/artifactPersist.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createArtifactStage, applyStagedArtifacts, MAX_STAGED_ARTIFACTS } from './artifactPersist.js'
import { extractPrismBlocks } from './blocks.js'

const doc = (title = 'Doc', markdown = '# Doc\n\nBody.') => ({ type: 'document', title, markdown })
const deck = (title = 'Deck') => ({ type: 'deck-html', title, slides: ['<section>1</section>', '<section>2</section>'] })
const fence = (obj) => '```prism-block\n' + JSON.stringify(obj) + '\n```'

test('no staged artifact: the answer is returned unchanged (same string)', () => {
  const answer = 'Hello\n\n{{toolcall:c1}}\n\nDone ' + fence(doc())
  assert.equal(applyStagedArtifacts(answer, createArtifactStage()), answer)
  assert.equal(applyStagedArtifacts(answer, undefined), answer)
})

test('a staged artifact lands as a fence right after its tool-call marker and parses as one block', () => {
  const stage = createArtifactStage()
  const r = stage.stage('c1', doc('Staged'), 'k1')
  assert.equal(r.duplicate, false)
  assert.equal(stage.size, 1)
  const out = applyStagedArtifacts('Before\n\n{{toolcall:c1}}\n\nAfter', stage)
  assert.ok(out.indexOf('{{toolcall:c1}}') < out.indexOf('prism-block'), 'fence follows the marker')
  assert.ok(out.indexOf('prism-block') < out.indexOf('After'), 'and precedes the later prose')
  const { content, blocks } = extractPrismBlocks(out)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'document')
  assert.equal(blocks[0].title, 'Staged')
  assert.match(content, /\{\{toolcall:c1\}\}[\s\S]*\{\{block:0\}\}[\s\S]*After/)
})

test('a staged artifact whose marker is missing is appended at the end', () => {
  const stage = createArtifactStage()
  stage.stage('gone', doc('Tail'), 'k')
  const { blocks, content } = extractPrismBlocks(applyStagedArtifacts('Only prose.', stage))
  assert.equal(blocks.length, 1)
  assert.match(content, /^Only prose\.\s+\{\{block:0\}\}$/)
})

test('the same key staged twice in a turn is one artifact (no duplicate)', () => {
  const stage = createArtifactStage()
  const a = stage.stage('c1', doc(), 'same')
  const b = stage.stage('c2', doc(), 'same')
  assert.equal(b.duplicate, true)
  assert.equal(b.ref, a.ref)
  assert.equal(stage.size, 1)
  assert.equal(stage.find('same').ref, a.ref)
  const { blocks } = extractPrismBlocks(applyStagedArtifacts('{{toolcall:c1}} {{toolcall:c2}}', stage))
  assert.equal(blocks.length, 1)
})

test('a model-authored fence of a staged artifact family is dropped (the tool already made it)', () => {
  const stage = createArtifactStage()
  stage.stage('c1', deck('Tool deck'), 'k')
  const outline = { type: 'deck-outline', title: 'Again', slides: [{ headline: 'x' }] }
  const answer = `{{toolcall:c1}}\n\nHere it is again:\n${fence(deck('Text deck'))}\n${fence(outline)}\n${fence(doc('Kept'))}`
  const { blocks } = extractPrismBlocks(applyStagedArtifacts(answer, stage))
  assert.deepEqual(
    blocks.map((b) => `${b.type}:${b.title}`),
    ['deck-html:Tool deck', 'document:Kept'],
    'the text deck and the outline are gone; the other family survives'
  )
})

test('an unfenced deck-outline is also dropped when a deck was staged (it would be materialized again)', () => {
  const stage = createArtifactStage()
  stage.stage('c1', deck('Tool deck'), 'k')
  const bare = JSON.stringify({ type: 'deck-outline', title: 'Bare', slides: [{ headline: 'x' }] })
  const out = applyStagedArtifacts(`{{toolcall:c1}}\n${bare}\nend`, stage)
  assert.ok(!out.includes('deck-outline'), out)
  assert.match(out, /end$/)
})

test('the stage is bounded per turn', () => {
  const stage = createArtifactStage()
  for (let i = 0; i < MAX_STAGED_ARTIFACTS; i++) stage.stage(`c${i}`, doc(`D${i}`), `k${i}`)
  assert.throws(() => stage.stage('over', doc('over'), 'over'), /limit/i)
  assert.equal(stage.size, MAX_STAGED_ARTIFACTS)
})

test('the staged block is a copy: mutating the caller object later changes nothing', () => {
  const stage = createArtifactStage()
  const b = doc('Orig')
  stage.stage('c1', b, 'k')
  b.title = 'Mutated'
  const { blocks } = extractPrismBlocks(applyStagedArtifacts('{{toolcall:c1}}', stage))
  assert.equal(blocks[0].title, 'Orig')
})

test('review fix: an earlier unbalanced fence cannot swallow a staged artifact', () => {
  const stage = createArtifactStage()
  stage.stage('c1', doc('Survives'), 'k')
  const answer = 'Intro\n```prism-block\n{"type":"chart","title":"cut\n\n{{toolcall:c1}}\n\nmore'
  const { blocks, content } = extractPrismBlocks(applyStagedArtifacts(answer, stage))
  assert.deepEqual(blocks.map((b) => b.title), ['Survives'])
  assert.ok(!content.includes('"type"'), 'no raw JSON of the broken fence leaks')
})

test('review fix: a dropped duplicate fence takes its closing ``` even after a blank line', () => {
  const stage = createArtifactStage()
  stage.stage('c1', doc('Tool'), 'k')
  const answer = `{{toolcall:c1}}\n\n\`\`\`prism-block\n${JSON.stringify(doc('Text'))}\n\n\`\`\`\nAfter`
  const out = applyStagedArtifacts(answer, stage)
  const { content, blocks } = extractPrismBlocks(out)
  assert.deepEqual(blocks.map((b) => b.title), ['Tool'])
  assert.ok(!content.includes('```'), content)
  assert.match(content, /After$/)
})

test('review fix: a kept fence right before another fence does not hide the next one', () => {
  const stage = createArtifactStage()
  stage.stage('c1', deck('Tool deck'), 'k')
  const chart = { type: 'table', columns: ['a'], rows: [[1]] }
  const answer = `{{toolcall:c1}}\n${fence(chart)}\n${fence(doc('Kept'))}\n${fence(deck('Dup'))}`
  const { blocks } = extractPrismBlocks(applyStagedArtifacts(answer, stage))
  assert.deepEqual(blocks.map((b) => b.type + ':' + (b.title || '')), ['deck-html:Tool deck', 'table:', 'document:Kept'])
})

test('review fix: the same `sameAs` replaces the staged version in place (one artifact, the latest)', () => {
  const stage = createArtifactStage()
  const a = stage.stage('c1', doc('V1'), 'k1', { sameAs: 'document:create:memo' })
  const b = stage.stage('c2', doc('V2'), 'k2', { sameAs: 'document:create:memo' })
  assert.equal(b.replaced, true)
  assert.equal(b.ref, a.ref)
  assert.equal(stage.size, 1)
  const { blocks } = extractPrismBlocks(applyStagedArtifacts('{{toolcall:c1}} x {{toolcall:c2}}', stage))
  assert.deepEqual(blocks.map((x) => x.title), ['V2'])
  for (let i = 1; i < MAX_STAGED_ARTIFACTS; i++) stage.stage(`d${i}`, doc(`D${i}`), `kk${i}`)
  assert.equal(stage.wouldExceed('document:create:other'), true)
  assert.equal(stage.wouldExceed('document:create:memo'), false, 'a replacement never exceeds the limit')
})
