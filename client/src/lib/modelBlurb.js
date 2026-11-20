// The one-line model description in the UI language (ux#14). The catalog ships
// the blurbs as pt-BR literals; the locale catalogs hold them per language under
// `modelPicker.blurb.<model id>`. The stored text wins when an admin edited it or
// the model is not curated, so nothing the admin wrote is overridden.
import { pt } from './locales/index.js'

/** `t` is the useT() translator; returns '' for a model without a description. */
export function modelBlurb(model, t) {
  const stored = model?.blurb || ''
  const key = `modelPicker.blurb.${model?.id}`
  const seeded = pt[key]
  if (!seeded) return stored // unknown / admin-added model: the stored text
  if (!stored || stored === seeded) return t(key) // still the seeded pt text: follow the UI language
  return stored // edited by an admin
}
