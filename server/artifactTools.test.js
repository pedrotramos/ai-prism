// The artifact tools (server/artifactTools.js, W2-12): create_/update_ deck,
// spreadsheet and document through function-calling, over the Prism engines. A
// tool never writes a row: it STAGES the artifact (server/artifactPersist.js)
// and the answer commit persists it. The engine and the owner-scoped reads are
// injected here, so these run without a gateway or a database.
//   node --test server/artifactTools.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactToolDefs, invokeArtifactTool, ARTIFACT_TOOL_KIND } from './artifactTools.js'
import { createArtifactStage, applyStagedArtifacts } from './artifactPersist.js'
import { extractPrismBlocks } from './blocks.js'
import { buildToolDefs } from './tools.js'

const OUTLINE = {
  title: 'Q3 review',
  slides: [
    { kind: 'cover', headline: 'Q3 review' },
    { kind: 'content', headline: 'Revenue grew', content: 'Up 12%.' },
  ],
}

function fakeDeps(over = {}) {
  const calls = { generate: [], template: 0, getDeck: [], getSpreadsheet: [], getDocument: [] }
  const deps = {
    getSelectedDeckTemplate: async () => {
      calls.template++
      return { id: 't1' }
    },
    generateDeckFromOutline: async (token, model, outline, opts) => {
      calls.generate.push({ token, model, outline, opts })
      opts.onTitle?.(outline.title)
      const slides = outline.slides.map((s, i) => `<section class="slide"><h2>${s.headline || i}</h2></section>`)
      slides.forEach((h, i) => opts.onSlide?.(h, i))
      return { slides, usage: { prompt_tokens: 10, completion_tokens: 20 }, ok: slides.length, cancelled: false }
    },
    getDeck: async (email, token, id) => {
      calls.getDeck.push(id)
      return null
    },
    getSpreadsheet: async (email, token, id) => {
      calls.getSpreadsheet.push(id)
      return null
    },
    getDocument: async (email, token, id) => {
      calls.getDocument.push(id)
      return null
    },
    ...over,
  }
  return { deps, calls }
}

function ctxFor(extra = {}) {
  const events = []
  return {
    ctx: { email: 'a@test.invalid', sessionId: '1', model: 'm1', toolCallId: 'c1', send: (e) => events.push(e), artifacts: createArtifactStage(), ...extra },
    events,
  }
}

const resolverFor = (name) => artifactToolDefs({ deck: true, spreadsheet: true, document: true }).find((d) => d.def.function.name === name).resolver

const staged = (ctx) => extractPrismBlocks(applyStagedArtifacts(`{{toolcall:${ctx.toolCallId}}}`, ctx.artifacts)).blocks

// ---------------------------------------------------------------- definitions

test('tool defs are gated per artifact capability of the turn', () => {
  const names = (caps) => artifactToolDefs(caps).map((d) => d.def.function.name).sort()
  assert.deepEqual(names({}), [])
  assert.deepEqual(names({ deck: true }), ['create_deck', 'update_deck'])
  assert.deepEqual(names({ spreadsheet: true }), ['create_spreadsheet', 'update_spreadsheet'])
  assert.deepEqual(names({ document: true }), ['create_document', 'update_document'])
  for (const d of artifactToolDefs({ deck: true, spreadsheet: true, document: true })) {
    assert.equal(d.def.type, 'function')
    assert.equal(d.def.function.parameters.type, 'object')
    assert.ok(d.def.function.description.length > 40)
    assert.equal(d.resolver.kind, ARTIFACT_TOOL_KIND)
  }
})

test('buildToolDefs registers the artifact tools AFTER the other tools, only when asked', async () => {
  const none = await buildToolDefs([], 't', 'a@test.invalid', { includePython: true })
  assert.ok(!none.tools.some((t) => /^(create|update)_/.test(t.function.name)))
  const built = await buildToolDefs([], 't', 'a@test.invalid', { includePython: true, artifacts: { deck: true, document: true } })
  const names = built.tools.map((t) => t.function.name)
  assert.equal(names[0], 'execute_python', 'existing tools keep their position')
  assert.deepEqual(names.slice(1).sort(), ['create_deck', 'create_document', 'update_deck', 'update_document'])
  assert.equal(built.resolvers.get('create_deck').kind, ARTIFACT_TOOL_KIND)
  assert.equal(built.resolvers.get('create_deck').toolName, 'create_deck')
})

// ---------------------------------------------------------------- create_*

test('create_deck: generates through the engine with the turn signal, streams, stages one deck-html, writes nothing', async () => {
  const { deps, calls } = fakeDeps()
  const { ctx, events } = ctxFor({ signal: new AbortController().signal })
  const r = await invokeArtifactTool('tok', resolverFor('create_deck'), OUTLINE, ctx, deps)
  assert.equal(calls.generate.length, 1)
  const g = calls.generate[0]
  assert.equal(g.model, 'm1', 'the turn model materializes the slides')
  assert.equal(g.opts.signal, ctx.signal, 'the abort signal reaches the slide queue')
  assert.equal(g.opts.usageKind, 'artifact', 'the slide calls land in the ledger as kind artifact')
  assert.deepEqual(g.opts.template, { id: 't1' })
  assert.deepEqual(
    events.map((e) => e.type),
    ['deck_stream_start', 'deck_slide', 'deck_slide']
  )
  const blocks = staged(ctx)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'deck-html')
  assert.equal(blocks[0].slides.length, 2)
  assert.equal(blocks[0].deckId, undefined, 'no row yet: the commit stamps the id')
  assert.match(r.resultText, /Q3 review/)
  assert.match(r.resultText, /2 slides/)
  assert.ok(r.resultText.length < 600, 'the model gets a summary, not the slide HTML')
  assert.ok(!r.resultText.includes('<section'), 'no HTML replayed to the model')
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 20 })
})

test('create_deck twice with the same arguments in one turn generates and stages once', async () => {
  const { deps, calls } = fakeDeps()
  const { ctx } = ctxFor()
  await invokeArtifactTool('tok', resolverFor('create_deck'), OUTLINE, ctx, deps)
  const again = await invokeArtifactTool('tok', resolverFor('create_deck'), OUTLINE, { ...ctx, toolCallId: 'c2' }, deps)
  assert.equal(calls.generate.length, 1)
  assert.equal(ctx.artifacts.size, 1)
  assert.match(again.resultText, /already/i)
})

test('create_deck: an aborted signal rejects with the abort reason and stages nothing', async () => {
  const ac = new AbortController()
  const { deps } = fakeDeps({
    generateDeckFromOutline: async (token, model, outline, opts) => {
      ac.abort()
      return { slides: [], usage: null, ok: 0, cancelled: true, signal: opts.signal }
    },
  })
  const { ctx } = ctxFor({ signal: ac.signal })
  await assert.rejects(invokeArtifactTool('tok', resolverFor('create_deck'), OUTLINE, ctx, deps), (e) => e?.name === 'AbortError')
  assert.equal(ctx.artifacts.size, 0)
})

test('create_deck: an invalid outline is a tool error (thrown), nothing staged', async () => {
  const { deps, calls } = fakeDeps()
  const { ctx } = ctxFor()
  await assert.rejects(invokeArtifactTool('tok', resolverFor('create_deck'), { title: 'x', slides: [] }, ctx, deps), /slides/i)
  assert.equal(calls.generate.length, 0)
  assert.equal(ctx.artifacts.size, 0)
})

test('create_spreadsheet: sanitized spec staged; the workbook model must materialize', async () => {
  const { deps } = fakeDeps()
  const { ctx } = ctxFor()
  const args = { title: 'Sales', sheets: [{ name: 'Data', blocks: [{ kind: 'table', columns: [{ header: 'Item' }, { header: 'Qty', format: 'integer' }], rows: [['a', 1]] }] }] }
  const r = await invokeArtifactTool('tok', resolverFor('create_spreadsheet'), args, ctx, deps)
  const blocks = staged(ctx)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'spreadsheet')
  assert.equal(blocks[0].sheets[0].name, 'Data')
  assert.match(r.resultText, /Sales/)
  await assert.rejects(invokeArtifactTool('tok', resolverFor('create_spreadsheet'), { title: 'x', sheets: [] }, ctx, deps), /sheet/i)
})

test('create_document: sanitized markdown staged (unsafe HTML neutralized)', async () => {
  const { deps } = fakeDeps()
  const { ctx } = ctxFor()
  await invokeArtifactTool('tok', resolverFor('create_document'), { title: 'Memo', markdown: '# Memo\n\n<script>x</script>Hi' }, ctx, deps)
  const [b] = staged(ctx)
  assert.equal(b.type, 'document')
  assert.equal(b.title, 'Memo')
  assert.ok(!b.markdown.includes('<script'), b.markdown)
  await assert.rejects(invokeArtifactTool('tok', resolverFor('create_document'), { title: 'Empty', markdown: '  ' }, ctx, deps), /markdown/i)
})

test('a tool called outside a turn (no stage) refuses instead of writing anything', async () => {
  const { deps } = fakeDeps()
  await assert.rejects(invokeArtifactTool('tok', resolverFor('create_document'), { markdown: '# a' }, { email: 'a@test.invalid' }, deps), /turn/i)
})

// ---------------------------------------------------------------- update_*

test('update_* on an artifact the caller does not own (or that does not exist) is a not-found refusal', async () => {
  const { deps, calls } = fakeDeps()
  const { ctx } = ctxFor()
  await assert.rejects(invokeArtifactTool('tok', resolverFor('update_deck'), { deck_id: '42', title: 'x' }, ctx, deps), /not found/i)
  await assert.rejects(invokeArtifactTool('tok', resolverFor('update_spreadsheet'), { spreadsheet_id: '43', sheets: [] }, ctx, deps), /not found/i)
  await assert.rejects(invokeArtifactTool('tok', resolverFor('update_document'), { document_id: '44', markdown: '# x' }, ctx, deps), /not found/i)
  // read through the owner-scoped getters with the caller's identity
  assert.deepEqual([calls.getDeck, calls.getSpreadsheet, calls.getDocument], [['42'], ['43'], ['44']])
  // a non-numeric id never reaches the database
  await assert.rejects(invokeArtifactTool('tok', resolverFor('update_document'), { document_id: '1; drop', markdown: '# x' }, ctx, deps), /not found/i)
  assert.deepEqual(calls.getDocument, ['44'])
  assert.equal(ctx.artifacts.size, 0)
})

test('update_deck: rebuilds only the listed slides, copies the rest, stages a new deck (the source row is untouched)', async () => {
  const source = { id: '9', title: 'Old', slides: ['<section>A</section>', '<section>B</section>', '<section>C</section>'], format: 'html', audience: 'Board' }
  const { deps, calls } = fakeDeps({ getDeck: async () => source })
  const { ctx, events } = ctxFor()
  await invokeArtifactTool('tok', resolverFor('update_deck'), { deck_id: '9', title: 'New', slides: [{ index: 1, headline: 'B2' }, { index: 7, headline: 'D' }] }, ctx, deps)
  assert.equal(calls.generate.length, 1)
  assert.deepEqual(calls.generate[0].outline.slides.map((s) => s.headline), ['B2', 'D'], 'only the changed briefs are generated')
  const [b] = staged(ctx)
  assert.equal(b.type, 'deck-html')
  assert.equal(b.title, 'New')
  assert.equal(b.audience, 'Board')
  assert.deepEqual(b.slides.map((s) => s.replace(/<[^>]+>/g, '')), ['A', 'B2', 'C', 'D'])
  assert.deepEqual(source.slides, ['<section>A</section>', '<section>B</section>', '<section>C</section>'], 'source not mutated')
  // live build: the whole deck streams, indexes in final order
  const slideEvents = events.filter((e) => e.type === 'deck_slide')
  assert.deepEqual([...new Set(slideEvents.map((e) => e.index))].sort(), [0, 1, 2, 3])
  assert.equal(events[0].type, 'deck_stream_start')
})

test('update_spreadsheet: replaces sheets by name and appends new ones', async () => {
  const table = (v) => ({ kind: 'table', columns: [{ header: 'V' }], rows: [[v]] })
  const source = { id: '5', title: 'Book', sheets: [{ name: 'A', blocks: [table('a')] }, { name: 'B', blocks: [table('b')] }] }
  const { deps } = fakeDeps({ getSpreadsheet: async () => source })
  const { ctx } = ctxFor()
  await invokeArtifactTool('tok', resolverFor('update_spreadsheet'), { spreadsheet_id: '5', sheets: [{ name: 'b', blocks: [table('b2')] }, { name: 'C', blocks: [table('c')] }] }, ctx, deps)
  const [b] = staged(ctx)
  assert.equal(b.title, 'Book')
  assert.deepEqual(b.sheets.map((s) => `${s.name}:${s.blocks[0].rows[0][0]}`), ['A:a', 'b:b2', 'C:c'])
})

test('update_document: replaces the markdown, keeps the title unless given', async () => {
  const { deps } = fakeDeps({ getDocument: async () => ({ id: '3', title: 'Memo', markdown: '# Memo\n\nold' }) })
  const { ctx } = ctxFor()
  await invokeArtifactTool('tok', resolverFor('update_document'), { document_id: '3', markdown: '# Memo\n\nnew' }, ctx, deps)
  const [b] = staged(ctx)
  assert.equal(b.title, 'Memo')
  assert.match(b.markdown, /new/)
})
