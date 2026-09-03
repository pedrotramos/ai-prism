#!/usr/bin/env node
// Offline QA for the pure-HTML deck engine (the only deck engine).
//
//   node scripts/deck-html-qa.mjs
//
// Covers the two server-side guarantees the HTML deck path relies on:
//   1. sanitizeHtmlDeck (server/blocks.js) — the shape gate + <script> strip that
//      every generated/edited deck round-trips through before it's persisted.
//   2. renderPptxFromOps (server/decks.js) — the native .pptx assembler that
//      turns the paint-ops the client extracts off the rendered DOM into a real
//      PowerPoint of editable shapes, incl. the brand-font embedding option.
//
// The live browser rendering/editing (HtmlSlideFrame, HtmlSlideEditor,
// domToSlideOps) is exercised by the app itself; this script guards the two
// pure, dependency-light server functions that a broken refactor would silently
// break.
import JSZip from 'jszip'
import { sanitizeHtmlDeck, clientWorkingSlides, parseInlineImages, spliceAttachedImages } from '../server/blocks.js'
import { renderPptxFromOps } from '../server/decks.js'
import { resolveDeckAssets } from '../client/src/lib/deckAssets.js'
import { zoneFromRatio, canDrop } from '../client/src/lib/treeDnd.js'
import { alignBoxes, distributeBoxes, computeSnap } from '../client/src/lib/deckAlign.js'

let failures = 0
const assert = (cond, msg) => {
  if (cond) {
    console.log('ok  -', msg)
    return
  }
  failures++
  console.error('FAIL:', msg)
}

// ---- 1. sanitizeHtmlDeck ---------------------------------------------------

// a valid deck survives, title is trimmed, slides come back as strings
{
  const out = sanitizeHtmlDeck({
    title: '  Minha apresentação  ',
    audience: 'diretoria',
    slides: ['<section class="slide"><h1>Um</h1></section>', { html: '<section class="slide">Dois</section>' }],
  })
  assert(out && out.title === 'Minha apresentação', 'sanitizeHtmlDeck trims the title')
  assert(out && out.slides.length === 2, 'sanitizeHtmlDeck keeps both string and {html} slides')
  assert(out && out.slides.every((s) => typeof s === 'string'), 'sanitizeHtmlDeck normalizes slides to strings')
  assert(out && out.audience === 'diretoria', 'sanitizeHtmlDeck preserves audience')
}

// <script> is always stripped (defense-in-depth), inline content kept
{
  const out = sanitizeHtmlDeck({
    title: 'x',
    slides: ['<section><script>alert(1)</script><p>oi</p></section>'],
  })
  assert(out && !/‹?script/i.test(out.slides[0]) && !out.slides[0].includes('<script'), 'sanitizeHtmlDeck strips <script>')
  assert(out && out.slides[0].includes('<p>oi</p>'), 'sanitizeHtmlDeck keeps the non-script markup')
}

// empty / malformed inputs are rejected (return null, never throw)
{
  assert(sanitizeHtmlDeck(null) === null, 'sanitizeHtmlDeck(null) → null')
  assert(sanitizeHtmlDeck({ title: '', slides: ['<section/>'] }) === null, 'empty title → null')
  assert(sanitizeHtmlDeck({ title: 'x', slides: [] }) === null, 'no slides → null')
  assert(sanitizeHtmlDeck({ title: 'x', slides: ['   ', ''] }) === null, 'blank-only slides → null')
}

// slide count is capped
{
  const many = Array.from({ length: 80 }, (_, i) => `<section>${i}</section>`)
  const out = sanitizeHtmlDeck({ title: 'x', slides: many })
  assert(out && out.slides.length <= 40, `slide count capped (got ${out?.slides.length})`)
}

// ---- 1b. resolveDeckAssets: replaced images survive to export --------------
// Regression for the "replaced image reverts to the original in the exported
// .pptx" bug. The editor drops the data-ds-asset-id marker when the user swaps
// an <img>'s src (see HtmlSlideEditor setAttr), so serialize() keeps the custom
// src. resolveDeckAssets — which runs on the off-screen export frame too — must
// then leave that custom <img> alone and only re-resolve still-symbolic ones.
{
  const map = new Map([['icon_1', 'data:image/svg+xml;base64,ORIGINAL']])

  // a still-symbolic asset (untouched by the user) resolves to the DS art
  const symbolic = resolveDeckAssets('<section><img data-ds-asset-id="icon_1"></section>', map)
  assert(symbolic.includes('ORIGINAL'), 'resolveDeckAssets resolves a symbolic data-ds-asset-id to the template art')

  // a user-customized <img> (marker already stripped) keeps its own src and is
  // NOT re-resolved to the template original — this is the export-side guarantee
  const customized = resolveDeckAssets('<section><img src="data:image/png;base64,USERIMG"></section>', map)
  assert(customized.includes('USERIMG'), 'resolveDeckAssets preserves a replaced image src')
  assert(!customized.includes('ORIGINAL'), 'resolveDeckAssets does not re-inject the original DS art over a replaced image')

  // belt-and-suspenders: even if a stale marker somehow lingers, an id with no
  // matching asset must never blank out; and idempotency holds on a resolved img
  const twice = resolveDeckAssets(resolveDeckAssets('<section><img data-ds-asset-id="icon_1"></section>', map), map)
  assert(twice.includes('ORIGINAL') && (twice.match(/ORIGINAL/g) || []).length === 1, 'resolveDeckAssets is idempotent on a resolved asset')
}

// ---- 1c. clientWorkingSlides: AI edits the working copy, safely ------------
// The tweak endpoint edits the client's in-memory slides (unsaved manual edits)
// when the body carries a usable `slides` array, else falls back to the DB copy
// (item 4). A malformed payload must never become the thing we edit/persist.
{
  const good = clientWorkingSlides(['<section>Um</section>', { html: '<section>Dois</section>', notes: 'n' }])
  assert(good && good.length === 2, 'clientWorkingSlides accepts a valid working copy')
  assert(good && good[0] === '<section>Um</section>', 'clientWorkingSlides keeps a bare string slide')
  assert(good && good[1] && good[1].notes === 'n', 'clientWorkingSlides preserves per-slide notes')

  assert(clientWorkingSlides(undefined) === null, 'clientWorkingSlides(undefined) → null (fall back to DB)')
  assert(clientWorkingSlides([]) === null, 'clientWorkingSlides([]) → null')
  assert(clientWorkingSlides(['<div>not a section</div>']) === null, 'clientWorkingSlides rejects a slide with no <section>')
  assert(clientWorkingSlides([{ html: '   ' }]) === null, 'clientWorkingSlides rejects a blank slide')
  assert(clientWorkingSlides('nope') === null, 'clientWorkingSlides rejects a non-array')
}

// ---- 1d. parseInlineImages: two channels (vision + original) ---------------
// Attachments carry the ORIGINAL bytes (dataUrl, may be SVG → inserted into the
// slide, vector-preserving) and a RASTER vision channel the model can see. SVG
// is kept as an insertable original but has NO vision channel (the vision API is
// raster-only); a raster attachment doubles as its own vision. Count/size capped.
{
  const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64')
  const jpg = 'data:image/jpeg;base64,' + Buffer.from('y').toString('base64')
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')

  const raster = parseInlineImages([{ dataUrl: png }, jpg])
  assert(raster.length === 2 && raster[0].dataUrl === png, 'parseInlineImages accepts {dataUrl} objects and bare strings')
  assert(raster[0].vision === png && raster[0].index === 1, 'a raster attachment doubles as its own vision channel (1-based index)')

  const withSvg = parseInlineImages([{ dataUrl: svg, visionUrl: png }])
  assert(withSvg.length === 1 && withSvg[0].dataUrl === svg && withSvg[0].isSvg, 'parseInlineImages keeps the SVG original (insertable)')
  assert(withSvg[0].vision === png, 'an SVG attachment uses the provided raster visionUrl for the model')

  const svgOnly = parseInlineImages([{ dataUrl: svg }])
  assert(svgOnly.length === 1 && svgOnly[0].vision === null, 'an SVG with no raster vision has vision:null (raster-only API)')

  assert(parseInlineImages(undefined).length === 0, 'parseInlineImages(undefined) → []')
  assert(parseInlineImages('nope').length === 0, 'parseInlineImages(non-array) → []')
  assert(parseInlineImages(['data:text/html;base64,AAAA']).length === 0, 'parseInlineImages rejects a non-image data-URL')
  assert(parseInlineImages(['https://example.com/x.png']).length === 0, 'parseInlineImages rejects a remote URL')
  assert(parseInlineImages(Array.from({ length: 10 }, () => ({ dataUrl: png }))).length === 4, 'parseInlineImages caps the image count')
}

// ---- 1e. spliceAttachedImages: model inserts the REAL asset ----------------
// When the model decides an attachment is an asset, it emits <img data-attach="N">
// and we swap in the real bytes (SVG kept vector). Unknown markers are dropped.
{
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')
  const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64')
  const atts = parseInlineImages([{ dataUrl: svg, visionUrl: png }])

  const spliced = spliceAttachedImages('<section><img data-attach="1" style="width:200px"><p>x</p></section>', atts)
  assert(spliced.includes(svg), 'spliceAttachedImages inserts the original (SVG) bytes at the marker')
  assert(!spliced.includes('data-attach'), 'spliceAttachedImages removes the data-attach marker')
  assert(spliced.includes('style="width:200px"'), 'spliceAttachedImages keeps the model-chosen styling')

  assert(spliceAttachedImages('<section><img data-attach="9"></section>', atts) === '<section></section>', 'spliceAttachedImages drops a marker with no matching attachment')
  assert(spliceAttachedImages('<section><p>no images</p></section>', atts) === '<section><p>no images</p></section>', 'spliceAttachedImages is a no-op without markers')
  assert(spliceAttachedImages('<section>x</section>', []) === '<section>x</section>', 'spliceAttachedImages is a no-op with no attachments')
}

// ---- 2. renderPptxFromOps --------------------------------------------------

// paint-ops (px on a 1280×720 stage) → a real .pptx zip with the expected parts
{
  const slides = [
    {
      w: 1280,
      h: 720,
      ops: [
        { type: 'rect', x: 0, y: 0, w: 1280, h: 720, fill: '0E1A1F' },
        { type: 'rect', x: 80, y: 80, w: 300, h: 120, radius: 16, fill: 'FFFFFF', line: { color: 'CCCCCC', width: 1 } },
        {
          type: 'text',
          x: 80,
          y: 240,
          w: 1120,
          h: 120,
          align: 'left',
          valign: 'top',
          lineHeight: 1.15,
          runs: [{ text: 'Título do slide', font: 'Arial', size: 40, color: 'FFFFFF', bold: true }],
        },
      ],
    },
    {
      w: 1280,
      h: 720,
      ops: [{ type: 'text', x: 80, y: 80, w: 1120, h: 80, runs: [{ text: 'Segundo slide', size: 24, color: '111111' }] }],
    },
  ]
  const buf = await renderPptxFromOps({ title: 'Deck de teste' }, slides)
  assert(Buffer.isBuffer(buf) && buf.length > 10_000, `renderPptxFromOps produces a .pptx buffer (${buf?.length} bytes)`)

  const zip = await JSZip.loadAsync(buf)
  assert(!!zip.file('ppt/presentation.xml'), '.pptx contains ppt/presentation.xml')
  assert(!!zip.file('ppt/slides/slide1.xml'), '.pptx contains slide1.xml')
  assert(!!zip.file('ppt/slides/slide2.xml'), '.pptx contains slide2.xml (one part per slide)')
  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string')
  assert(slide1.includes('Título do slide'), 'slide1 carries the text run verbatim')
}

// a malformed op must never abort the whole export (best-effort per op)
{
  const buf = await renderPptxFromOps({ title: 'x' }, [
    { w: 1280, h: 720, ops: [{ type: 'text' /* no runs */ }, { type: 'rect', x: 0, y: 0, w: 100, h: 100, fill: '000000' }] },
  ])
  assert(Buffer.isBuffer(buf) && buf.length > 5_000, 'renderPptxFromOps tolerates a malformed op and still exports')
}

// image op with object-fit:cover → pptxgenjs `sizing` so the .pptx crops to fill
// instead of stretching. (contain is letterboxed client-side in domToSlideOps —
// it emits plain coords, exercised by the app, not this pure-server test.) A 1x1
// PNG in a wide box with fit:cover must export cleanly and embed the media part.
{
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const buf = await renderPptxFromOps({ title: 'x' }, [
    { w: 1280, h: 720, ops: [{ type: 'image', x: 100, y: 100, w: 600, h: 200, dataUrl: png1x1, fit: 'cover' }] },
  ])
  const zip = await JSZip.loadAsync(buf)
  const hasMedia = Object.keys(zip.files).some((p) => /ppt\/media\/image[-\d].*\.png$/i.test(p))
  assert(Buffer.isBuffer(buf) && hasMedia, 'renderPptxFromOps embeds an image op with object-fit (cover) as a media part')
}

// a plain image op (no fit — the contain-letterbox case, coords precomputed
// client-side) must still export cleanly as a media part.
{
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const buf = await renderPptxFromOps({ title: 'x' }, [
    { w: 1280, h: 720, ops: [{ type: 'image', x: 340, y: 100, w: 200, h: 200, dataUrl: png1x1 }] },
  ])
  const zip = await JSZip.loadAsync(buf)
  const hasMedia = Object.keys(zip.files).some((p) => /ppt\/media\/image[-\d].*\.png$/i.test(p))
  assert(Buffer.isBuffer(buf) && hasMedia, 'renderPptxFromOps embeds a plain (contain-letterboxed) image op')
}

// brand-font embedding: a TTF data-URI ends up embedded in the zip
{
  // a tiny (invalid-as-a-font but well-formed data-URI) TTF payload is enough to
  // exercise the embed plumbing — the function only base64-decodes and stores it.
  const fakeTtf = 'data:font/ttf;base64,' + Buffer.from('not-a-real-font-but-bytes').toString('base64')
  const buf = await renderPptxFromOps({ title: 'x' }, [{ w: 1280, h: 720, ops: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '000000' }] }], {
    embedFonts: true,
    fontAssets: [{ family: 'BrandSans', weight: '400', style: 'normal', dataUrl: fakeTtf }],
  })
  const zip = await JSZip.loadAsync(buf)
  const hasFont = Object.keys(zip.files).some((p) => /ppt\/fonts\/font\d+\.fntdata/.test(p))
  assert(hasFont, 'embedFonts embeds the DS font bytes at ppt/fonts/*.fntdata')
  const pres = await zip.file('ppt/presentation.xml').async('string')
  assert(pres.includes('embeddedFontLst') && pres.includes('BrandSans'), 'presentation.xml declares the embedded brand font')
}

// embedding is best-effort: a non-embeddable asset must not corrupt the file
{
  const buf = await renderPptxFromOps({ title: 'x' }, [{ w: 1280, h: 720, ops: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '000000' }] }], {
    embedFonts: true,
    fontAssets: [{ family: 'X', dataUrl: 'not-a-data-uri' }],
  })
  assert(Buffer.isBuffer(buf) && buf.length > 5_000, 'renderPptxFromOps falls back cleanly when a font asset is unembeddable')
}

// tree drag-and-drop (item 1): the pure decision helpers behind reorder/reparent
{
  // drop zone from the cursor's vertical position within a row
  assert(zoneFromRatio(0.1) === 'before', 'zoneFromRatio: top band drops before')
  assert(zoneFromRatio(0.5) === 'inside', 'zoneFromRatio: middle band reparents inside')
  assert(zoneFromRatio(0.9) === 'after', 'zoneFromRatio: bottom band drops after')
  assert(zoneFromRatio(0.1, true) === 'inside', 'zoneFromRatio: the slide root only accepts inside')

  // legality: no self-drop, no dropping a node into its own subtree
  assert(canDrop('1', '2') === true, 'canDrop allows a move between unrelated nodes')
  assert(canDrop('1.0', '0') === true, 'canDrop allows reparenting up the tree')
  assert(canDrop('1', '1') === false, 'canDrop forbids dropping a node onto itself')
  assert(canDrop('1', '1.0') === false, 'canDrop forbids dropping a node into its own child')
  assert(canDrop('1', '1.2.3') === false, 'canDrop forbids dropping a node deep into its own subtree')
  assert(canDrop('12', '120') === true, 'canDrop is not fooled by a shared path prefix (12 vs 120)')
  assert(canDrop(null, '1') === false, 'canDrop rejects a null source')
}

// align / distribute / snap geometry (item 8 P1): the pure math the runtime mirrors
{
  // alignBoxes: only the touched axis moves; the other coordinate is preserved
  const boxes = [
    { left: 10, top: 10, width: 100, height: 40 },
    { left: 50, top: 200, width: 60, height: 40 },
    { left: 30, top: 400, width: 200, height: 40 },
  ]
  const left = alignBoxes(boxes, 'left')
  assert(left.every((b) => b.left === 10), 'alignBoxes(left) snaps every left edge to the group min')
  assert(left[1].top === 200, 'alignBoxes(left) leaves the vertical coordinate untouched')
  const right = alignBoxes(boxes, 'right')
  // group right edge = max(left+width) = 30+200 = 230
  assert(right[0].left === 230 - 100 && right[1].left === 230 - 60, 'alignBoxes(right) aligns right edges to the group max')
  const hc = alignBoxes(boxes, 'hcenter')
  const cx = (10 + 230) / 2
  assert(hc[0].left === cx - 50, 'alignBoxes(hcenter) centers each box on the group center-x')
  const top = alignBoxes(boxes, 'top')
  assert(top.every((b) => b.top === 10), 'alignBoxes(top) snaps every top edge to the group min')
  assert(alignBoxes([boxes[0]], 'left').length === 1, 'alignBoxes is a no-op with a single box')

  // distributeBoxes: equal gaps, extremes fixed
  const row = [
    { left: 0, top: 0, width: 20, height: 10 },
    { left: 200, top: 0, width: 20, height: 10 }, // middle — will be repositioned
    { left: 100, top: 0, width: 20, height: 10 },
  ]
  const dist = distributeBoxes(row, 'h')
  // visual order by left: idx0 (0), idx2 (100), idx1 (200). Extremes at 0 and 200.
  // sizes all 20 → span 220, total 60, gap = (220-60)/2 = 80. Middle (idx2) sits
  // at 0 + 20 + 80 = 100.
  assert(dist[0].left === 0 && dist[1].left === 200, 'distributeBoxes keeps the extreme elements fixed')
  assert(dist[2].left === 100, 'distributeBoxes equalizes the gaps between elements')
  assert(distributeBoxes(row.slice(0, 2), 'h').length === 2, 'distributeBoxes is a no-op with fewer than 3 boxes')

  // computeSnap: the closest anchor↔line within threshold wins each axis
  const moving = { left: 98, top: 50, width: 40, height: 20 }
  const snap = computeSnap(moving, [100], [], 6)
  assert(snap.dx === 2 && snap.guideX === 100, 'computeSnap nudges the near edge onto a guide within threshold')
  assert(snap.dy === 0 && snap.guideY === null, 'computeSnap leaves an axis with no nearby guide alone')
  const far = computeSnap({ left: 200, top: 50, width: 40, height: 20 }, [100], [], 6)
  assert(far.dx === 0 && far.guideX === null, 'computeSnap ignores guides beyond the threshold')
  // center anchor can snap too: box center at left+20; put a guide there
  const centerSnap = computeSnap({ left: 0, top: 0, width: 40, height: 20 }, [22], [], 6)
  assert(centerSnap.dx === 2 && centerSnap.guideX === 22, 'computeSnap can snap the box center, not just edges')
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ndeck-html QA passed')
