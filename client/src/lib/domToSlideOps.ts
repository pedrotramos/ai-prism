// DOM → slide paint-ops extractor for the pure-HTML deck export (task #29).
// The Claude Design .pptx export is DOM→native shapes, element by element (we
// dissected their file: every div/h2/td becomes a positioned <p:sp>, text a
// real <a:t>, backgrounds rect/roundRect solidFill — no rasterization). The
// rendered geometry only exists in the browser, so we walk each slide's live
// iframe here and emit a flat list of ops the server turns into pptxgenjs
// shapes. See project_pure_html_deck_engine.
//
// Coordinates are in px on the fixed 1280×720 stage; the server scales to the
// 10×5.625in canvas. Everything stays editable in PowerPoint.

import { resolveDeckAssets, DECK_ASSET_FALLBACK_CSS } from './deckAssets.ts'

const STAGE_W = 1280
const STAGE_H = 720
// px (on the 1280-wide stage) → points on the 10in-wide pptx canvas:
// 10in × 72pt/in ÷ 1280px = 0.5625. Using the screen 0.75 (=72/96) made every
// font 1.33× too big → text overflowed its measured box and collided. This is
// the correct stage-relative factor.
const PX_TO_PT = (10 * 72) / STAGE_W

// The iframe's window: `Window` plus the globals (XMLSerializer, ...) the extractor uses.
type Win = Window & typeof globalThis
interface Box { x: number; y: number; w: number; h: number }
interface ParsedColor { hex: string; a: number; rgb: number[] }
interface RunStyle { font: string; size: number; color: string; bold: boolean; italic: boolean; transform?: string; tracking: number }
interface Run extends RunStyle { text: string }
type Op =
  | (Box & { type: 'rect'; fill: string | null; radius: number; line: { color: string | null; width: number } | null })
  | (Box & { type: 'image'; dataUrl: string; fit?: 'cover'; transparency?: number })
  | (Box & { type: 'text'; runs: Run[]; align: 'center' | 'right' | 'left'; valign: 'middle' | 'top'; lineHeight: number })
interface SlideOps { w: number; h: number; ops: Op[] }

// parse "rgb(a)(…)" → { hex, a, rgb:[r,g,b] }; null for transparent/none.
function parseColor(c: string | null | undefined): ParsedColor | null {
  if (!c) return null
  const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c)
  if (!m) return null
  const a = m[4] != null ? parseFloat(m[4]) : 1
  if (a === 0) return null
  const rgb = [m[1]!, m[2]!, m[3]!].map((v) => Math.round(parseFloat(v)))
  const hex = rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
  return { hex: hex.toUpperCase(), a, rgb }
}

const hexToRgb = (h: string | null | undefined): number[] => {
  const s = (h || '').replace('#', '')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
const rgbToHex = (rgb: number[]): string => rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase()

// Composite a parsed color over an opaque backdrop hex → concrete opaque hex.
// A translucent card (e.g. rgba(255,255,255,0.06) on navy) reads as a specific
// solid color on screen; the .pptx has no per-shape alpha compositing we can
// rely on, so we bake that exact blend. This is why a white-6% card was coming
// out solid white (alpha dropped) instead of the subtle dark panel it is.
function flattenColor(parsed: ParsedColor | null, backdropHex: string | null | undefined): string | null {
  if (!parsed) return null
  if (parsed.a >= 0.999) return parsed.hex
  const bg = hexToRgb(backdropHex || 'FFFFFF')
  const out = parsed.rgb.map((c, i) => c * parsed.a + bg[i]! * (1 - parsed.a))
  return rgbToHex(out)
}

// Bake a CSS `opacity` (0..1) into an already-resolved opaque hex by compositing
// it over the backdrop — same philosophy as flattenColor for translucent fills.
// The .pptx has no reliable per-shape text alpha, so a 40%-opacity heading is
// exported as the concrete faded color it reads as on screen. alpha≥~1 is a
// no-op; the caller only invokes this when the effective opacity is < 1.
function fadeHex(hex: string, alpha: number, backdropHex: string | null | undefined): string
function fadeHex(hex: string | null, alpha: number, backdropHex: string | null | undefined): string | null
function fadeHex(hex: string | null, alpha: number, backdropHex: string | null | undefined): string | null {
  if (!hex || alpha >= 0.999) return hex
  const bg = hexToRgb(backdropHex || 'FFFFFF')
  const fg = hexToRgb(hex)
  return rgbToHex(fg.map((c, i) => c * alpha + bg[i]! * (1 - alpha)))
}

// The first concrete family in a CSS font-family list, stripped of quotes and
// generic fallbacks — the brand face to embed for high-fidelity export.
function primaryFamily(family: string | null | undefined): string {
  const first = String(family || '')
    .split(',')[0]!
    .trim()
    .replace(/^['"]|['"]$/g, '')
  const generic = /^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system)$/i
  return first && !generic.test(first) ? first : ''
}

// Map a CSS family to the face written into the .pptx. Two modes:
//  • 'universal' (default): a web-safe face (Arial/Georgia/Courier New) so the
//    file opens identically on any machine — matches Claude Design's default.
//  • 'brand': the design system's real family name, so the deck renders in the
//    brand font when that font travels with the file (embedded) or is installed.
function resolveFont(family: string | null | undefined, mode: string): string {
  if (mode === 'brand') {
    const brand = primaryFamily(family)
    if (brand) return brand
  }
  const f = (family || '').toLowerCase()
  if (/mono|courier|consolas|menlo/.test(f)) return 'Courier New'
  if (/georgia|times|serif/.test(f) && !/sans/.test(f)) return 'Georgia'
  return 'Arial'
}

const weightToBold = (w: string): boolean => {
  const n = parseInt(w, 10)
  return Number.isFinite(n) ? n >= 600 : w === 'bold' || w === 'bolder'
}

// Is this element a leaf text container? — it has non-whitespace text and no
// BLOCK-level element children (only text nodes / inline formatting like span,
// b, i, a). Those get one text op with inline runs; block containers instead
// contribute their background as a rect and recurse.
function isTextLeaf(el: Element, win: Win): boolean {
  let hasText = false
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.textContent!.trim()) hasText = true
    else if (node.nodeType === 1) {
      const d = win.getComputedStyle(node as Element).display
      if (d && !/inline/.test(d)) return false // a block child → not a leaf
    }
  }
  return hasText
}

// Apply CSS text-transform to the raw text so an uppercased eyebrow exports
// uppercased (we read textContent, which is the SOURCE case).
function applyTransform(text: string, transform: string | undefined): string {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  if (transform === 'capitalize') return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
  return text
}

// Build inline runs (text + per-run color/weight/italic) from a text-leaf's
// descendants, so a heading with a colored <span> keeps that color in the pptx.
function buildRuns(el: Element, win: Win, fontMode: string): Run[] {
  const runs: Run[] = []
  const styleOf = (cs: CSSStyleDeclaration): RunStyle => ({
    font: resolveFont(cs.fontFamily, fontMode),
    size: Math.round(parseFloat(cs.fontSize) * PX_TO_PT * 10) / 10, // px→pt (stage-relative)
    color: parseColor(cs.color)?.hex || '000000',
    bold: weightToBold(cs.fontWeight),
    italic: cs.fontStyle === 'italic',
    transform: cs.textTransform, // uppercase/lowercase/capitalize/none
    // letter-spacing px → points (pptxgenjs charSpacing is in points)
    tracking: cs.letterSpacing && cs.letterSpacing !== 'normal' ? Math.round(parseFloat(cs.letterSpacing) * PX_TO_PT * 10) / 10 : 0,
  })
  const walk = (node: Node, inherited: RunStyle): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = applyTransform(child.textContent!, inherited.transform)
        if (text) runs.push({ text, ...inherited })
      } else if (child.nodeType === 1) {
        if ((child as Element).tagName === 'BR') {
          // a <br> is a hard line break — carry it as a newline run so
          // "Time Jurídico<br>Preparado por" doesn't collapse onto one line
          runs.push({ text: '\n', ...inherited })
          continue
        }
        const cs = win.getComputedStyle(child as Element)
        walk(child, { ...inherited, ...styleOf(cs) })
      }
    }
  }
  const base = win.getComputedStyle(el)
  walk(el, styleOf(base))
  // merge adjacent runs with identical styling (fewer <a:r> in the pptx)
  const merged: Run[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && last.font === r.font && last.size === r.size && last.color === r.color && last.bold === r.bold && last.italic === r.italic && last.tracking === r.tracking) {
      last.text += r.text
    } else merged.push({ ...r })
  }
  return merged.filter((r) => r.text.length)
}

// Serialize an inline <svg> with its COMPUTED colors baked in, so token-based
// fills (var(--accent) etc.) survive as concrete rgb when the SVG is lifted out
// of the document (where :root vars no longer resolve → would render black).
function serializeSvgWithComputedColors(svg: SVGSVGElement, win: Win, w: number, h: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  // walk original + clone in lockstep; copy computed paint props onto the clone
  const origNodes = [svg, ...svg.querySelectorAll('*')]
  const cloneNodes = [clone, ...clone.querySelectorAll('*')]
  const PAINT = ['fill', 'stroke', 'stopColor', 'stop-color', 'color', 'strokeWidth', 'opacity', 'fillOpacity', 'strokeOpacity']
  for (let i = 0; i < origNodes.length; i++) {
    const cs = win.getComputedStyle(origNodes[i]!)
    const c = cloneNodes[i]!
    if (!c.setAttribute) continue
    // resolve fill/stroke to concrete values (computed style already resolves var())
    const fill = cs.fill
    if (fill && fill !== 'none') c.setAttribute('fill', fill)
    const stroke = cs.stroke
    if (stroke && stroke !== 'none') c.setAttribute('stroke', stroke)
    const sw = cs.strokeWidth
    if (sw && sw !== '0px') c.setAttribute('stroke-width', String(parseFloat(sw)))
    const stop = cs.stopColor
    if (stop && stop !== 'rgb(0, 0, 0)') c.setAttribute('stop-color', stop)
    // strip inline style so the baked attributes win (style referenced var())
    if (c.hasAttribute('style')) c.removeAttribute('style')
  }
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  const xml = new win.XMLSerializer().serializeToString(clone)
  return 'data:image/svg+xml;base64,' + win.btoa(unescape(encodeURIComponent(xml)))
}

// Walk one slide's root element, producing ops in paint order (DOM order ≈
// z-order for static flow; absolutely-positioned nodes still come out in tree
// order, which matches how they were authored).
export function extractSlideOps(slideRoot: Element, win: Win, { fontMode = 'universal' }: { fontMode?: string } = {}): Op[] {
  const ops: Op[] = []
  // table cells whose background was already painted by the row-level rect
  // (see the TR branch) — their own per-cell bg rect is then skipped.
  const paintedRowCells = new Set<Element>()
  const rootRect = slideRoot.getBoundingClientRect()
  const sx = STAGE_W / rootRect.width
  const sy = STAGE_H / rootRect.height
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round((r.left - rootRect.left) * sx),
      y: Math.round((r.top - rootRect.top) * sy),
      w: Math.round(r.width * sx),
      h: Math.round(r.height * sy),
    }
  }

  const visit = (el: Element, backdrop: string, inheritedOpacity = 1): void => {
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return
    const b = box(el)
    if (b.w <= 0 || b.h <= 0) return
    // CSS `opacity` compounds down the tree (a 50% parent halves its children).
    // We carry the cumulative factor and BAKE it into exported colors, since the
    // .pptx can't reliably render per-shape alpha (mirrors the fill-flatten path).
    const elOpacity = (() => {
      const o = parseFloat(cs.opacity)
      return Number.isFinite(o) ? o : 1
    })()
    const opacity = inheritedOpacity * elOpacity

    // Table ROW with same-fill cells → emit ONE rect spanning the row, so a
    // rounded header reads as a single rounded block (pptxgenjs roundRect can't
    // do per-corner radius, and per-<th> rects would round every cell's 4
    // corners). We paint the row bg here, then let the cells' TEXT render (their
    // own bg is skipped via `paintedRowCells`). Radius comes from the corner
    // cells' own border-radius — the DS decides it, we don't.
    if (el.tagName === 'TR') {
      const cells = [...el.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD')
      const fills = cells.map((c) => parseColor(win.getComputedStyle(c).backgroundColor)?.hex || null)
      const uniqueFill = fills.find(Boolean)
      const allSame = uniqueFill && fills.every((f) => f === uniqueFill)
      if (allSame && cells.length) {
        // max corner radius among the cells (the DS rounds the outer cells)
        const radii = cells.map((c) => parseFloat(win.getComputedStyle(c).borderTopLeftRadius) || parseFloat(win.getComputedStyle(c).borderTopRightRadius) || 0)
        const radius = Math.max(...radii, 0)
        const rowFill = fadeHex(flattenColor(parseColor(win.getComputedStyle(cells[0]!).backgroundColor), backdrop), opacity, backdrop)
        ops.push({ type: 'rect', ...b, fill: rowFill, radius: Math.round(radius * sx), line: null })
        for (const c of cells) paintedRowCells.add(c) // their own bg already painted
        for (const child of el.children) visit(child, rowFill || backdrop, opacity)
        return
      }
    }

    // 1) background / border → rect (roundRect when border-radius). Translucent
    // fills are FLATTENED against the current backdrop so a white-6% card reads
    // as the subtle dark panel it is on screen — not solid white.
    const bgParsed = paintedRowCells.has(el) ? null : parseColor(cs.backgroundColor)
    const bgFlat = bgParsed ? flattenColor(bgParsed, backdrop) : null
    // bake the element's cumulative CSS opacity into the fill/border color too
    const bg = bgFlat ? fadeHex(bgFlat, opacity, backdrop) : null
    const bw = parseFloat(cs.borderTopWidth) || 0
    const border = bw > 0 ? parseColor(cs.borderTopColor) : null
    if (bg || border) {
      const radius = parseFloat(cs.borderTopLeftRadius) || 0
      ops.push({
        type: 'rect',
        ...b,
        fill: bg || null,
        radius: Math.round(radius * sx),
        line: border ? { color: fadeHex(flattenColor(border, backdrop), opacity, backdrop), width: Math.max(0.5, bw * sx) } : null,
      })
    }
    // an opaque bg becomes the backdrop for descendants (translucent children
    // composite over IT, not the slide bg). Use the FADED bg so a child's text
    // composites over what the panel actually looks like.
    const childBackdrop = bg && bgParsed!.a >= 0.999 && opacity >= 0.999 ? bg : backdrop

    // 2) <img> → image (only real embedded data; DS asset URLs resolve at
    // render — captured as their src when it's a data URI)
    if (el.tagName === 'IMG') {
      const img = el as HTMLImageElement
      const src = img.currentSrc || img.src || ''
      // Match the preview's object-fit so the .pptx doesn't stretch the image.
      // For `contain` we compute the LETTERBOXED rect here (from the image's
      // natural aspect + the element box) and emit those exact coords — a plain
      // draw the server can't get wrong. pptxgenjs's own `sizing:contain` proved
      // unreliable (stretched anyway), so we don't lean on it. `cover` still uses
      // server-side sizing (it must crop); `fill`/`none` keep the stretch-to-box.
      const objFit = cs.objectFit
      const nw = img.naturalWidth || 0
      const nh = img.naturalHeight || 0
      let rect: Box = b
      let fit: 'cover' | undefined
      if (objFit === 'contain' && nw > 0 && nh > 0 && b.w > 0 && b.h > 0) {
        const na = nw / nh
        const ba = b.w / b.h
        const dw = na > ba ? b.w : Math.round(b.h * na)
        const dh = na > ba ? Math.round(b.w / na) : b.h
        rect = { x: b.x + Math.round((b.w - dw) / 2), y: b.y + Math.round((b.h - dh) / 2), w: dw, h: dh }
      } else if (objFit === 'cover') {
        fit = 'cover'
      }
      // images keep real alpha in the .pptx (pptxgenjs `transparency` is a 0..100
      // percentage), so a faded logo/photo exports faded rather than baked
      if (src.startsWith('data:image')) ops.push({ type: 'image', ...rect, dataUrl: src, ...(fit ? { fit } : {}), ...(opacity < 0.999 ? { transparency: Math.round((1 - opacity) * 100) } : {}) })
      return
    }
    // inline SVG (charts/icons) → serialize to a data URI, drawn as one image.
    // CRITICAL: the SVG uses var(--accent)/var(--primary) tokens that resolve
    // via the document ':root'. Serialized standalone, those vars are undefined
    // and the shapes render BLACK. So we bake each element's COMPUTED fill/
    // stroke (concrete rgb) onto a clone before serializing. Also stamp explicit
    // width/height so the standalone SVG has intrinsic size.
    if (el.tagName === 'svg') {
      try {
        const dataUrl = serializeSvgWithComputedColors(el as SVGSVGElement, win, b.w, b.h)
        if (dataUrl) ops.push({ type: 'image', ...b, dataUrl, ...(opacity < 0.999 ? { transparency: Math.round((1 - opacity) * 100) } : {}) })
      } catch {
        /* unserializable — skip */
      }
      return
    }

    // 3) text leaf → text op; else recurse into children
    if (isTextLeaf(el, win)) {
      const runs = buildRuns(el, win, fontMode)
      // bake cumulative opacity into each run's color (text has no reliable
      // per-run alpha in the .pptx) so a faded caption exports faded
      if (opacity < 0.999) for (const r of runs) r.color = fadeHex(r.color, opacity, backdrop)
      if (runs.length) {
        // inset the text box by the element's padding, so a table cell's text
        // sits with the same breathing room it has on screen (14–16px pads).
        const pl = (parseFloat(cs.paddingLeft) || 0) * sx
        const pr = (parseFloat(cs.paddingRight) || 0) * sx
        const pt = (parseFloat(cs.paddingTop) || 0) * sy
        const pb = (parseFloat(cs.paddingBottom) || 0) * sy
        // vertical centering matches CSS line-box centering in cells/kickers
        const valign = /middle|center/.test(cs.display) || cs.display === 'flex' || cs.alignItems === 'center' ? 'middle' : 'top'
        ops.push({
          type: 'text',
          x: Math.round(b.x + pl),
          y: Math.round(b.y + pt),
          w: Math.max(Math.round(b.w - pl - pr), 8),
          h: Math.max(Math.round(b.h - pt - pb), 8),
          runs,
          align: cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left',
          valign,
          lineHeight: cs.lineHeight && cs.lineHeight !== 'normal' ? parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) : 1.15,
        })
      }
      return
    }
    // Mixed container (not a text leaf): recurse into element children AND emit
    // any DIRECT non-empty text nodes as their own text ops. Without this, a
    // flex row like `<div><svg/> texto</div>` drops "texto" (the icon makes the
    // div a non-leaf, and el.children skips text nodes). We measure the exact
    // text box with a Range so it's positioned right next to the icon.
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue
      if (!node.textContent!.trim()) continue
      try {
        const range = win.document.createRange()
        range.selectNode(node)
        const r = range.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        // Style comes from the CONTAINER's own computed style — the text node
        // inherits it. (Do NOT reuse buildRuns(el)'s first run: that walks the
        // whole element and its first run may be a sibling icon's color, which
        // made the banner text render orange.)
        const style = {
          font: resolveFont(cs.fontFamily, fontMode),
          size: Math.round(parseFloat(cs.fontSize) * PX_TO_PT * 10) / 10,
          color: fadeHex(parseColor(cs.color)?.hex || '000000', opacity, backdrop),
          bold: weightToBold(cs.fontWeight),
          italic: cs.fontStyle === 'italic',
          tracking: cs.letterSpacing && cs.letterSpacing !== 'normal' ? Math.round(parseFloat(cs.letterSpacing) * PX_TO_PT * 10) / 10 : 0,
        }
        // The Range hugs the text tightly at the DM-Sans measurement; Arial in
        // the .pptx is a touch wider and would wrap. Pad the width (and clamp to
        // the parent's inner width so it never overflows the slide) to keep it
        // on one line, matching the on-screen single-line banner.
        const parentR = el.getBoundingClientRect()
        const maxRight = (parentR.right - rootRect.left) * sx
        const x = Math.round((r.left - rootRect.left) * sx)
        const w = Math.max(Math.min(Math.round(r.width * sx * 1.12 + 6), Math.round(maxRight - x)), 8)
        ops.push({
          type: 'text',
          x,
          y: Math.round((r.top - rootRect.top) * sy),
          w,
          h: Math.max(Math.round(r.height * sy), 8),
          runs: [{ ...style, text: applyTransform(node.textContent!.replace(/\s+/g, ' '), cs.textTransform) }],
          align: cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left',
          valign: 'middle',
          lineHeight: 1.15,
        })
      } catch {
        /* range unsupported — skip */
      }
    }
    for (const child of el.children) visit(child, childBackdrop, opacity)
  }

  // start from the slide root's children (the root itself is the full-bleed bg,
  // handled as its own rect if colored). The root bg is the initial backdrop
  // that translucent descendants composite over.
  const rootCs = win.getComputedStyle(slideRoot)
  const rootBg = flattenColor(parseColor(rootCs.backgroundColor), 'FFFFFF') || 'FFFFFF'
  ops.push({ type: 'rect', x: 0, y: 0, w: STAGE_W, h: STAGE_H, fill: rootBg, radius: 0, line: null })
  for (const child of slideRoot.children) visit(child, rootBg)
  return ops
}

// Extract ops for every slide iframe in order. `frames` = array of iframe
// elements (the Studio's rail/stage frames render the exact slides).
export function extractDeckOps(frames: Iterable<HTMLIFrameElement>): SlideOps[] {
  const slides: SlideOps[] = []
  for (const frame of frames) {
    try {
      const doc = frame.contentDocument
      const win = frame.contentWindow
      if (!doc || !win) continue
      const root = doc.querySelector('section') || doc.body
      slides.push({ w: STAGE_W, h: STAGE_H, ops: extractSlideOps(root, win as Win) })
    } catch {
      slides.push({ w: STAGE_W, h: STAGE_H, ops: [] }) // cross-origin/blank — skip
    }
  }
  return slides
}

// Build the same srcDoc HtmlSlideFrame uses (tokens injected), so an off-screen
// export frame renders IDENTICALLY to what the Studio shows. Duplicated minimal
// wrapper here to avoid a circular import with the React component.
function exportSrcDoc(sectionHtml: string | null | undefined, tokenStyle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style data-ds-tokens>${tokenStyle}</style>
<style>html,body{margin:0;padding:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;background:var(--background,#fff);font-family:var(--font-body,var(--font-sans,system-ui));}
section.slide,section{box-sizing:border-box;width:${STAGE_W}px;height:${STAGE_H}px;position:relative;overflow:hidden;}
${DECK_ASSET_FALLBACK_CSS}</style>
</head><body>${sectionHtml || ''}</body></html>`
}

// Renders each slide full-size (1280×720) in a hidden iframe, waits for load +
// webfonts, and extracts native paint-ops. Returns [{w,h,ops}] for the server.
// `tokenStyleBuilder` builds the DS token CSS (buildDeckTokenStyle from
// HtmlSlideFrame) so brand vars resolve exactly as on screen.
export async function extractOpsFromSlides(
  slidesHtml: string[] | null | undefined,
  tokenStyleBuilder: string | (() => string) | null | undefined,
  { fontMode = 'universal', assetMap = null }: { fontMode?: string; assetMap?: Parameters<typeof resolveDeckAssets>[1] | null } = {},
): Promise<SlideOps[]> {
  const tokenStyle = typeof tokenStyleBuilder === 'function' ? tokenStyleBuilder() : tokenStyleBuilder || ''
  const out: SlideOps[] = []
  for (const html of slidesHtml || []) {
    // resolve DS asset placeholders to the brand's real inlined art so a
    // referenced icon/illustration/logo exports as a native picture (an
    // unresolved id collapses via DECK_ASSET_FALLBACK_CSS instead of 404ing)
    const resolved = assetMap ? resolveDeckAssets(html, assetMap) : html
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${STAGE_W}px;height:${STAGE_H}px;border:0;visibility:hidden;`
    document.body.appendChild(frame)
    try {
      await new Promise((resolve) => {
        frame.onload = resolve
        frame.srcdoc = exportSrcDoc(resolved, tokenStyle)
      })
      const doc = frame.contentDocument!
      const win = frame.contentWindow as Win
      // let webfonts settle so geometry matches the on-screen render
      try {
        if (doc.fonts?.ready) await doc.fonts.ready
      } catch {
        /* fonts API unavailable — proceed */
      }
      // wait for images to decode so naturalWidth/Height is known — the image op
      // needs the natural aspect to compute the object-fit:contain letterbox
      // (otherwise it falls back to stretching the image to the element box).
      try {
        const imgs = [...doc.images].filter((im) => !im.complete)
        if (imgs.length) {
          await Promise.race([
            Promise.all(imgs.map((im) => new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }) }))),
            new Promise((r) => setTimeout(r, 3000)), // never hang the export on a broken asset
          ])
        }
      } catch {
        /* proceed on any decode error */
      }
      await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)))
      const root = doc.querySelector('section') || doc.body
      out.push({ w: STAGE_W, h: STAGE_H, ops: extractSlideOps(root, win, { fontMode }) })
    } catch {
      out.push({ w: STAGE_W, h: STAGE_H, ops: [] })
    } finally {
      frame.remove()
    }
  }
  return out
}
