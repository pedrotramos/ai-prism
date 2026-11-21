// Input budgets of the deck studio (W2-16), the client mirror of
// server/routes/decks.js (deckInputBudgetViolation). The server is the
// authority: it answers 413 { code, limit, slide | image } above a budget. The
// studio checks the same numbers first so the user gets a clear, localized
// message without uploading tens of megabytes, and keeps the work on screen.
//
//   - speaker note: at most 9 MiB per slide, counted in UTF-8 bytes;
//   - AI-edit attachments: at most 4, each at most 6 MiB DECODED (the picked
//     file, not its base64 data: URL); an SVG's raster vision copy counts too;
//   - the whole request: at most 46 MiB (the server's studioMedia body class,
//     derived from ONE maxed note + 4 maxed attachments + the working slides), so
//     two 9 MiB notes next to four images are refused here with a named limit
//     instead of falling into a generic 413.
//
// Pure (no React): unit-tested in deckInputBudgets.test.js.
export const DECK_NOTE_MAX_BYTES = 9 * 1024 * 1024 // 9437184
export const DECK_IMAGE_MAX_BYTES = 6 * 1024 * 1024 // 6291456
export const DECK_MAX_IMAGES = 4
export const DECK_REQUEST_MAX_BYTES = 46 * 1024 * 1024 // the studioMedia body class (server/middleware/security.ts)

const BUDGET_CODES = new Set(['deck_note_too_large', 'deck_image_too_large', 'deck_too_many_images', 'deck_request_too_large'])

let encoder = null
function utf8Bytes(s) {
  encoder ||= new TextEncoder()
  return encoder.encode(s).length
}

/** Decoded size of a data: URL (base64 → bytes; any other payload → its UTF-8 length). */
function dataUrlBytes(url) {
  if (typeof url !== 'string') return 0
  const comma = url.indexOf(',')
  if (comma < 0) return utf8Bytes(url)
  const payload = url.slice(comma + 1)
  if (!/;base64$/i.test(url.slice(0, comma))) return utf8Bytes(payload)
  const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - pad
}

function attachmentBytes(im) {
  const original = typeof im === 'string' ? im : im?.dataUrl
  const vision = typeof im === 'object' && im?.visionUrl !== original ? im?.visionUrl : null
  return dataUrlBytes(original) + dataUrlBytes(vision)
}

/**
 * The serialized request against the total budget: { code, limit } or null.
 * `json` is the exact string that will be sent; only a long one is measured in
 * bytes (a UTF-16 unit is at most 3 UTF-8 bytes).
 */
export function jsonOverBudget(json) {
  if (typeof json !== 'string') return null
  if (json.length * 3 <= DECK_REQUEST_MAX_BYTES) return null
  return utf8Bytes(json) > DECK_REQUEST_MAX_BYTES ? { code: 'deck_request_too_large', limit: DECK_REQUEST_MAX_BYTES } : null
}

/** The request body against the total budget (see jsonOverBudget). */
export function requestOverBudget(body) {
  return jsonOverBudget(JSON.stringify(body))
}

/** The first slide whose speaker note is over budget, as a violation, or null. */
export function noteOverBudget(slides) {
  if (!Array.isArray(slides)) return null
  for (let i = 0; i < slides.length; i++) {
    const notes = slides[i]?.notes
    // a UTF-16 unit is at most 3 UTF-8 bytes: only a long note needs encoding
    if (typeof notes === 'string' && notes.length * 3 > DECK_NOTE_MAX_BYTES && utf8Bytes(notes) > DECK_NOTE_MAX_BYTES) {
      return { code: 'deck_note_too_large', limit: DECK_NOTE_MAX_BYTES, slide: i + 1 }
    }
  }
  return null
}

/** The first attachment budget an AI edit breaks, as a violation, or null. */
export function imagesOverBudget(images) {
  if (!Array.isArray(images)) return null
  if (images.length > DECK_MAX_IMAGES) return { code: 'deck_too_many_images', limit: DECK_MAX_IMAGES, image: DECK_MAX_IMAGES + 1 }
  for (let i = 0; i < images.length; i++) {
    if (attachmentBytes(images[i]) > DECK_IMAGE_MAX_BYTES) return { code: 'deck_image_too_large', limit: DECK_IMAGE_MAX_BYTES, image: i + 1 }
  }
  return null
}

/**
 * Picked/pasted files against the attachment budget, given how many slots are
 * taken (attached + still being read): the image files that get a slot, in
 * order (`admitted`), the ones over 6 MiB (by name) and how many valid images
 * land past the 4th. Only `admitted` should reach the attach hook; the studio
 * announces the rest.
 */
export function filesOverBudget(taken, files) {
  const images = Array.from(files || []).filter((f) => (f?.type || '').startsWith('image/'))
  const tooLarge = images.filter((f) => f.size > DECK_IMAGE_MAX_BYTES).map((f) => f.name || '')
  const fitting = images.filter((f) => f.size <= DECK_IMAGE_MAX_BYTES)
  const admitted = fitting.slice(0, Math.max(0, DECK_MAX_IMAGES - (taken || 0)))
  return { admitted, tooLarge, overCount: fitting.length - admitted.length }
}

/** A server 413 that names a deck budget → the violation; anything else → null. */
export function budgetRejection(status, body) {
  if (status !== 413 || !body || !BUDGET_CODES.has(body.code)) return null
  const v = { code: body.code, limit: body.limit }
  if (body.slide != null) v.slide = body.slide
  if (body.image != null) v.image = body.image
  return v
}

const mib = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`

/** Localized copy for a violation, naming the limit. */
export function budgetMessage(t, v) {
  if (v?.code === 'deck_note_too_large') return t('deckStudio.budget.noteTooLarge', { limit: mib(v.limit ?? DECK_NOTE_MAX_BYTES), slide: v.slide ?? '' })
  if (v?.code === 'deck_image_too_large') return t('deckStudio.budget.imageTooLarge', { limit: mib(v.limit ?? DECK_IMAGE_MAX_BYTES), image: v.image ?? '' })
  if (v?.code === 'deck_too_many_images') return t('deckStudio.budget.tooManyImages', { limit: v.limit ?? DECK_MAX_IMAGES })
  if (v?.code === 'deck_request_too_large') return t('deckStudio.budget.requestTooLarge', { limit: mib(v.limit ?? DECK_REQUEST_MAX_BYTES) })
  return ''
}

/**
 * JSON request for the deck routes that keeps the budget answer: throws an
 * Error whose `budget` is the violation on a budget 413 (message: the server's
 * fallback text), or whose `conflict` is the current deck on a 409 deck_conflict,
 * else `HTTP <status>` / the server's `error`, like api.js.
 */
export async function deckRequest(method, url, body) {
  const json = JSON.stringify(body)
  // the whole body against the server's class, before uploading tens of megabytes
  const over = jsonOverBudget(json)
  if (over) throw Object.assign(new Error(`request over ${over.limit} bytes`), { budget: over })
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: json })
  if (r.ok) return r.json()
  const payload = await r.json().catch(() => null)
  const err = new Error(payload?.error || `HTTP ${r.status}`)
  err.status = r.status
  // a 413 without a budget code is the body class itself (Express answers it as HTML)
  err.budget = budgetRejection(r.status, payload) || (r.status === 413 ? { code: 'deck_request_too_large', limit: DECK_REQUEST_MAX_BYTES } : null)
  // N6: a save/AI edit based on a stale revision. `conflict` is the server's current deck.
  if (r.status === 409 && payload?.code === 'deck_conflict' && payload.deck) err.conflict = payload.deck
  // another AI edit holds the deck right now: nothing was spent, try again in a moment
  if (r.status === 409 && payload?.code === 'deck_busy') err.busy = true
  throw err
}
