import { useCallback, useState } from 'react'
import { admitPromptImages } from '../lib/promptImages.ts'

// Shared image-attachment state for the AI tweak prompts (Deck + Spreadsheet
// studios). Mirrors the Composer's paste-to-attach behavior, but keeps images
// as base64 data URLs so they ride along in the tweak endpoint's JSON body
// (those endpoints are plain JSON, not multipart).
//
// Each image carries TWO channels:
//   • dataUrl   — the ORIGINAL bytes (incl. SVG). This is what gets INSERTED
//                 into the slide as a real <img> when the model decides the
//                 attachment is an asset to use (vector stays vector).
//   • visionUrl — a RASTER (PNG) copy the model can actually SEE. The gateway's
//                 vision API rejects SVG, so an SVG is rasterized here purely
//                 for the model to look at; the slide never uses this copy.
// For a raster attachment (png/jpeg/…) both channels are the same data URL in
// memory; on the wire it travels once (lib/promptImages.ts, tweakImagePayload).
//
// Non-image clipboard content is ignored (left to the input's default paste).
// A count cap plus a total size budget (lib/promptImages.ts) keeps the request
// under the studio's body limit.
const MAX_BYTES = 6 * 1024 * 1024 // ~6MB/image — matches the media request ceiling
const RASTER_MAX = 1024 // longest side of a rasterized SVG (keeps the PNG small)

// Settles on EVERY terminal outcome of the read: `loadend` fires after load,
// error and abort alike (only a completed read has a string result; the others
// give null), and a read that cannot start resolves null too. Never pending:
// the deck studio holds an attachment slot until this settles (QA W2-16 r2).
export function readAsDataUrl(file: Blob): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const r = new FileReader()
    r.onloadend = () => resolve(typeof r.result === 'string' ? r.result : null)
    try {
      r.readAsDataURL(file)
    } catch {
      resolve(null)
    }
  })
}

// The gateway's vision API only accepts raster image data URLs — an
// `image/svg+xml` payload is rejected ("Invalid data URL ... base64 image").
// Rasterize an SVG data URL to a PNG data URL via an offscreen canvas. We keep
// the PNG's alpha transparent (NO opaque ground): many brand SVGs are white or
// light art on transparency, and painting a white background would erase them.
// Returns null if the SVG can't be decoded (caller drops the attachment rather
// than sending a bad URL). A viewBox with no intrinsic width/height falls back
// to RASTER_MAX so the canvas is never zero-sized.
function rasterizeSvg(svgDataUrl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const iw = img.naturalWidth || img.width || RASTER_MAX
        const ih = img.naturalHeight || img.height || RASTER_MAX
        const scale = Math.min(1, RASTER_MAX / Math.max(iw, ih, 1))
        const w = Math.max(1, Math.round(iw * scale))
        const h = Math.max(1, Math.round(ih * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D // a fresh canvas always has a 2d context
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = svgDataUrl
  })
}

/** An attachment held by the studios' AI prompt (dataUrl = original, visionUrl = raster copy). */
interface AttachedImage {
  id: string
  name: string
  dataUrl: string
  visionUrl: string
}

export function usePromptImages() {
  const [images, setImages] = useState<AttachedImage[]>([])

  const addFiles = useCallback(async (list: ArrayLike<File> | null | undefined) => {
    const files = Array.from(list || []).filter((f) => (f.type || '').startsWith('image/') && f.size <= MAX_BYTES)
    if (!files.length) return
    const read = await Promise.all(
      files.map(async (f) => {
        const dataUrl = await readAsDataUrl(f)
        if (!dataUrl) return null
        // The model's vision API rejects SVG, so its VISION copy is a rasterized
        // PNG — but the slide still gets the original SVG (dataUrl), kept vector.
        let visionUrl: string = dataUrl
        if (/^data:image\/svg\+xml/i.test(dataUrl)) {
          const raster = await rasterizeSvg(dataUrl)
          if (!raster) return null // undecodable SVG — drop rather than send bad data
          visionUrl = raster
        }
        return { id: `${f.name}:${f.size}:${Math.random().toString(36).slice(2, 8)}`, name: f.name || 'imagem.png', dataUrl, visionUrl }
      }),
    )
    setImages((prev) => admitPromptImages(prev, read.filter((im): im is AttachedImage => im !== null)))
  }, [])

  // Paste-to-attach: pull image file items off the clipboard. Returns true when
  // it consumed images (caller should preventDefault so the binary isn't also
  // dropped as text into the prompt box).
  const onPaste = useCallback(
    (e: { clipboardData?: DataTransfer | null; preventDefault: () => void }) => {
      const items = e.clipboardData?.items
      if (!items) return false
      const files: File[] = []
      for (const it of items) {
        if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
          const blob = it.getAsFile()
          if (blob) files.push(blob)
        }
      }
      if (!files.length) return false
      e.preventDefault()
      addFiles(files)
      return true
    },
    [addFiles],
  )

  const removeAt = useCallback((id: string) => setImages((prev) => prev.filter((im) => im.id !== id)), [])
  const clear = useCallback(() => setImages([]), [])

  return { images, addFiles, onPaste, removeAt, clear }
}
