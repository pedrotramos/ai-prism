// Pure geometry for the editor's align / distribute / snap features (item 8, P1).
// Boxes are plain rects — { left, top, width, height } — in one consistent space
// (the runtime feeds root-local px). Kept DOM-free so the QA harness exercises
// the exact math the iframe runtime mirrors; the runtime only adds the DOM reads
// and style writes around these decisions.

// Bounding box of a set of rects.
function bounds(boxes) {
  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity
  for (const b of boxes) {
    minL = Math.min(minL, b.left)
    minT = Math.min(minT, b.top)
    maxR = Math.max(maxR, b.left + b.width)
    maxB = Math.max(maxB, b.top + b.height)
  }
  return { minL, minT, maxR, maxB, cx: (minL + maxR) / 2, cy: (minT + maxB) / 2 }
}

// Align every box to a shared edge/center of the group's bounding box. Only the
// axis the mode touches moves; the other coordinate is preserved. Returns new
// { left, top } for each box, in the SAME order as the input.
// modes: left | hcenter | right | top | vmiddle | bottom
export function alignBoxes(boxes, mode) {
  if (!Array.isArray(boxes) || boxes.length < 2) return boxes.map((b) => ({ left: b.left, top: b.top }))
  const g = bounds(boxes)
  return boxes.map((b) => {
    let left = b.left, top = b.top
    if (mode === 'left') left = g.minL
    else if (mode === 'right') left = g.maxR - b.width
    else if (mode === 'hcenter') left = g.cx - b.width / 2
    else if (mode === 'top') top = g.minT
    else if (mode === 'bottom') top = g.maxB - b.height
    else if (mode === 'vmiddle') top = g.cy - b.height / 2
    return { left, top }
  })
}

// Distribute boxes so the GAPS between consecutive elements are equal, keeping
// the extreme elements fixed (the standard design-tool behaviour). Needs ≥ 3
// boxes to be meaningful. Returns new { left, top } in the INPUT order.
// axis: 'h' (horizontal gaps) | 'v' (vertical gaps)
export function distributeBoxes(boxes, axis) {
  const out = boxes.map((b) => ({ left: b.left, top: b.top }))
  if (!Array.isArray(boxes) || boxes.length < 3) return out
  const horiz = axis === 'h'
  const start = (b) => (horiz ? b.left : b.top)
  const size = (b) => (horiz ? b.width : b.height)
  // walk in visual order, but write back to the original slots
  const order = boxes.map((b, i) => i).sort((a, b) => start(boxes[a]) - start(boxes[b]))
  const first = boxes[order[0]]
  const last = boxes[order[order.length - 1]]
  const span = (start(last) + size(last)) - start(first)
  const totalSize = order.reduce((s, i) => s + size(boxes[i]), 0)
  const gap = (span - totalSize) / (order.length - 1)
  let cursor = start(first)
  for (const i of order) {
    if (horiz) out[i].left = Math.round(cursor)
    else out[i].top = Math.round(cursor)
    cursor += size(boxes[i]) + gap
  }
  return out
}

// Snap a moving box to nearby guide lines. `linesX`/`linesY` are candidate guide
// coordinates (edges + centers of siblings and the slide). The moving box offers
// three anchors per axis (near edge, center, far edge); the closest anchor↔line
// pair within `threshold` wins that axis. Returns the correction to apply and the
// guide coordinate to draw (null when nothing snapped on that axis).
export function computeSnap(moving, linesX, linesY, threshold = 6) {
  const axis = (anchors, lines) => {
    let best = null
    for (const a of anchors) {
      for (const line of lines) {
        const d = line - a
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.delta))) {
          best = { delta: d, guide: line }
        }
      }
    }
    return best
  }
  const ax = axis([moving.left, moving.left + moving.width / 2, moving.left + moving.width], linesX || [])
  const ay = axis([moving.top, moving.top + moving.height / 2, moving.top + moving.height], linesY || [])
  return {
    dx: ax ? ax.delta : 0,
    dy: ay ? ay.delta : 0,
    guideX: ax ? ax.guide : null,
    guideY: ay ? ay.guide : null,
  }
}
