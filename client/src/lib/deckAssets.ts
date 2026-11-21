// Pure-HTML deck engine — design-system ASSET resolution.
//
// The model composes flowing HTML/CSS against the DS's color/font tokens (see
// buildDeckTokenStyle). Colors and fonts resolve via CSS custom properties, but
// raster/vector ASSETS — the brand's real product icons, decorative
// illustrations/motifs, and the logo lockup — can't ride a CSS var. So the
// model references them SYMBOLICALLY: `<img data-ds-asset-id="illustration_ds_3">`
// (or `data-ds-logo`). The stored slide HTML keeps only the id, so it stays
// small and re-themeable (swap the DS → the same slide picks up the new brand's
// assets). At paint time we resolve each id to the DS's real inlined data URI.
//
// This closes the gap that made the model INVENT motifs/icons: previously the
// HTML engine had no channel to the DS's real assets, so the model drew its own
// SVGs. Now it names a real asset id and we substitute the real art. The same
// resolver runs in every render surface — preview frame, live editor, and the
// off-screen export frame — so what the user sees is what exports to .pptx
// (domToSlideOps already turns a resolved `<img data:…>` into a native picture).

// Build id → dataUrl map from a template's iconAssets (+ the logo lockups).
// Any asset kind is resolvable (icon / illustration / image / background /
// lockup); the model is steered per-kind in the prompt, but resolution is
// permissive so a valid id never renders blank.
/** The slice of a DS template the asset resolver reads. */
interface DeckAssetTemplate {
  iconAssets?: { id?: string | number; dataUrl?: unknown }[] | null
  logoDataUrl?: string | null
  logoLightDataUrl?: string | null
}

export function buildDeckAssetMap(template: DeckAssetTemplate | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!template) return map
  for (const a of template.iconAssets || []) {
    if (a?.id && typeof a.dataUrl === 'string' && a.dataUrl) map.set(String(a.id), a.dataUrl)
  }
  // logo lockups get stable synthetic ids the prompt advertises
  if (template.logoDataUrl) map.set('logo', template.logoDataUrl)
  if (template.logoLightDataUrl) map.set('logo-light', template.logoLightDataUrl)
  return map
}

// Replace `data-ds-asset-id="ID"` / `data-ds-logo` on <img> tags with a real
// `src="<dataUrl>"`. Operates on the raw HTML string before it's written into a
// srcDoc — no DOM needed, so it works identically in every caller. An id with no
// matching asset (model hallucinated one, or the DS lacks it) has its src left
// empty and gets `data-ds-missing` stamped so a broken-image box never shows:
// CSS in the frame hides those. Idempotent and safe on HTML with no placeholders.
//
// `keepMarker` (editor only): keep the `data-ds-asset-id`/`data-ds-logo`
// attribute alongside the resolved src, so the editable DOM can be serialized
// back to the SYMBOLIC id (see stripResolvedDeckAssets) instead of baking the
// data URI into stored HTML. Preview/export drop the marker (throwaway render).
export function resolveDeckAssets(html: string | null | undefined, assetMap: Map<string, string> | null | undefined, { keepMarker = false }: { keepMarker?: boolean } = {}): string {
  if (typeof html !== 'string' || !html) return html || ''
  const noAssets = !assetMap || assetMap.size === 0
  // resolve data-ds-asset-id="ID"
  let out = html.replace(/<img\b([^>]*?)\bdata-ds-asset-id="([^"]*)"([^>]*?)>/gi, (_m: string, pre: string, id: string, post: string) => {
    const marker = keepMarker ? ` data-ds-asset-id="${id}"` : ''
    const url = noAssets ? undefined : assetMap.get(String(id).trim())
    return buildResolvedImg(pre + post, url, marker)
  })
  // resolve the logo shorthand data-ds-logo (no value)
  out = out.replace(/<img\b([^>]*?)\bdata-ds-logo(?:="[^"]*")?([^>]*?)>/gi, (_m: string, pre: string, post: string) => {
    const marker = keepMarker ? ' data-ds-logo' : ''
    const url = noAssets ? undefined : (assetMap.get('logo') || assetMap.get('logo-light'))
    return buildResolvedImg(pre + post, url, marker)
  })
  return out
}

// Rebuild an <img> tag with the resolved src (dropping any model-written src so
// a placeholder src can't win), or mark it missing when the id didn't resolve.
function buildResolvedImg(attrs: string, url: string | undefined, marker = ''): string {
  const cleaned = attrs.replace(/\bsrc="[^"]*"/i, '').replace(/\bdata-ds-missing(?:="[^"]*")?/i, '').trim()
  if (url) return `<img ${cleaned}${marker} src="${url}">`
  return `<img ${cleaned}${marker} data-ds-missing="1" src="">`
}

// Inverse of resolveDeckAssets({keepMarker:true}): strip the baked-in `src` (and
// the `data-ds-missing` flag) off any <img> that still carries a `data-ds-asset-id`
// / `data-ds-logo` marker, so serialized editor HTML stores the symbolic id, not
// a multi-hundred-KB data URI. Runs inside the editor iframe on a cloned node.
export function stripResolvedDeckAssets(root: ParentNode | null | undefined): void {
  if (!root || !root.querySelectorAll) return
  root.querySelectorAll('img[data-ds-asset-id],img[data-ds-logo]').forEach((img: Element) => {
    img.removeAttribute('src')
    img.removeAttribute('data-ds-missing')
  })
}

// CSS injected into every deck frame so an unresolved asset placeholder collapses
// silently (no broken-image glyph) instead of showing a browser error box.
export const DECK_ASSET_FALLBACK_CSS = 'img[data-ds-missing]{display:none!important}'
