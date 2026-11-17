// Strict checks for the design-system fields the client pastes into a <style>
// block after the server sanitized the HTML: the @font-face rules and the :root
// tokens that DeckTemplatesSettings.jsx, DeckTemplateInspector.jsx and
// deck/HtmlSlideFrame.jsx build from fontAssets[] (family, weight, style,
// dataUrl), headingFont, bodyFont and palette[].varName. A quote, `;`, `{`, `}`
// or `<` in any of them could end the CSS string or the <style> element, so each
// field takes a small character allowlist and a length cap. Palette values
// (hex only) and the other payload checks stay in validateTemplatePayload
// (server/routes/deckTemplates.js).
//
// Returns the names of the offending fields ([] when everything is fine).
// Absent / empty optional fields are not checked.

// Character allowlists, not CSS grammars: what matters is that nothing can end
// the quoted CSS string, the declaration or the <style> element (no quotes,
// backslash, `;`, `{`, `}`, `<`, `>`, `/`, control characters). An invalid but
// harmless value (font-weight "regular") is left to the browser to ignore, so
// a design system that saved before this check still saves.
// letters (any script), combining marks, digits, space and . _ - ( ) + &
const FAMILY = /^[\p{L}\p{M}\p{N} ._()+&-]{1,80}$/u
// a font-family list as typed in the editor or mined from a .pptx: also commas
const FONT_LIST = /^[\p{L}\p{M}\p{N} ._()+&,-]{1,120}$/u
const WEIGHT = /^[A-Za-z0-9 .-]{1,32}$/
const STYLE = /^[A-Za-z0-9 .-]{1,32}$/
// base64 font: font/*, application/font-*, application/x-font-*, the EOT type,
// and application/octet-stream (dsImport.js toDataUrl falls back to it for an
// unknown extension). The payload must be pure base64.
const FONT_DATA_URL =
  /^data:(?:font\/[a-z0-9.+-]{1,40}|application\/(?:x-)?font-[a-z0-9.+-]{1,40}|application\/vnd\.ms-fontobject|application\/octet-stream);base64,[A-Za-z0-9+/]+={0,2}$/i
const FONT_DATA_URL_MAX = 2_000_000
const VAR_NAME = /^[A-Za-z0-9_.-]{0,82}$/

const present = (v) => v !== undefined && v !== null && v !== ''

function fontOk(f) {
  if (!f || typeof f !== 'object') return false
  if (typeof f.family !== 'string' || !FAMILY.test(f.family)) return false
  if (present(f.weight) && !WEIGHT.test(String(f.weight))) return false
  if (present(f.weight) && typeof f.weight !== 'string' && typeof f.weight !== 'number') return false
  if (present(f.style) && (typeof f.style !== 'string' || !STYLE.test(f.style))) return false
  if (typeof f.dataUrl !== 'string' || f.dataUrl.length > FONT_DATA_URL_MAX || !FONT_DATA_URL.test(f.dataUrl)) return false
  return true
}

export function validateTemplateTokens(t) {
  const bad = []
  if (t.fontAssets !== undefined && !(Array.isArray(t.fontAssets) && t.fontAssets.every(fontOk))) bad.push('fontAssets')
  for (const k of ['headingFont', 'bodyFont']) {
    if (present(t[k]) && (typeof t[k] !== 'string' || !FONT_LIST.test(t[k]))) bad.push(k)
  }
  if (
    t.palette !== undefined &&
    !(Array.isArray(t.palette) && t.palette.every((p) => p && (p.varName == null || (typeof p.varName === 'string' && VAR_NAME.test(p.varName)))))
  ) {
    bad.push('palette')
  }
  return bad
}
