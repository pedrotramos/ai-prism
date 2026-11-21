// Wire format and size budget of the image attachments of an AI edit (deck and
// spreadsheet studios; state lives in hooks/usePromptImages.ts).
//
// A raster attachment's vision copy IS its original, so it travels once: the
// server uses the original as the vision channel when `visionUrl` is absent
// (parseInlineImages in server/blocks.js). Only an SVG sends a second, raster
// copy. Sending both put three 5 MiB photos over the old 40 MiB body limit.
//
// The attachments of one request share a budget so the whole JSON body (plus
// the deck: at most 40 slides x 60,000 chars kept by the server, and the
// speaker notes, not capped yet) stays under the 46 MiB studio-media limit.
// Tightening both budgets is threat-model follow-up F-1.
export const MAX_PROMPT_IMAGES = 4
export const MAX_PROMPT_IMAGE_CHARS = 34_000_000 // fits 4 x 6 MiB rasters (33.55M chars)

/** Characters an attachment puts on the wire. */
/** An image attached to an AI edit. */
interface PromptImage {
  id?: string
  dataUrl?: string
  visionUrl?: string
}

export function wireChars(im: PromptImage | null | undefined): number {
  const data = im?.dataUrl?.length || 0
  return im?.visionUrl && im.visionUrl !== im.dataUrl ? data + im.visionUrl.length : data
}

/** The `images` field of a deck tweak: one copy per raster, two for an SVG. */
export function tweakImagePayload(images: PromptImage[] | null | undefined): { dataUrl?: string; visionUrl?: string }[] {
  return (images || []).map((im) => (im.visionUrl && im.visionUrl !== im.dataUrl ? { dataUrl: im.dataUrl, visionUrl: im.visionUrl } : { dataUrl: im.dataUrl }))
}

/**
 * Existing attachments first, then the new ones, up to the count cap; an image
 * that would exceed the total budget is skipped (a smaller one may still fit).
 */
export function admitPromptImages<I extends PromptImage>(
  prev: I[] | null | undefined,
  incoming: I[] | null | undefined,
  { maxImages = MAX_PROMPT_IMAGES, maxChars = MAX_PROMPT_IMAGE_CHARS }: { maxImages?: number; maxChars?: number } = {},
): I[] {
  const out: I[] = []
  let used = 0
  for (const im of [...(prev || []), ...(incoming || [])]) {
    if (!im || out.length >= maxImages) continue
    const n = wireChars(im)
    if (used + n > maxChars) continue
    out.push(im)
    used += n
  }
  return out
}
