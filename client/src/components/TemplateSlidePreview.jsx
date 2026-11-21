// Renders one entry of a template's `previewSlides` (see DeckTemplatesSettings
// mineSlideTheme/extractPptxTheme) — a deliberately lightweight summary
// (background/title/bullets/image) mined from a real slide in the imported
// .pptx, NOT the full `deck` layout schema DeckSlidePreview renders. This is
// a browsing aid for the Design System inspector, not a pixel-perfect clone
// of the source file.
import { DS_FALLBACK } from '../lib/dsDefaults.ts'
import { contrastOn } from '../../../shared/deckTheme.js'

const SIZE_SCALE = {
  thumb: { heading: '0.55rem', body: '0.4rem', maxBullets: 2 },
  canvas: { heading: '1.15rem', body: '0.75rem', maxBullets: 6 },
}

export default function TemplateSlidePreview({ slide, template, variant = 'canvas', className = '' }) {
  const bg = /^#?[0-9a-fA-F]{6}$/.test(slide?.background || '') ? slide.background : template?.backgroundColor || DS_FALLBACK.background
  // the shared WCAG ink rule; a non-hex bg (mined junk) keeps the DS light-bg ink
  const onBg = /^#?[0-9a-fA-F]{6}$/.test(bg || '') ? contrastOn(bg) : DS_FALLBACK.inkOnLight
  const headingFont = template?.headingFont || 'Georgia, serif'
  const bodyFont = template?.bodyFont || 'Helvetica, Arial, sans-serif'
  const hasImage = !!slide?.imageDataUrl
  const hasText = !!(slide?.title || slide?.bullets?.length)
  const fs = SIZE_SCALE[variant] || SIZE_SCALE.canvas

  return (
    <div className={`relative aspect-video overflow-hidden rounded-lg shadow-sm ${className}`} /* data */ style={{ background: bg, color: onBg }}>
      <div className={`h-full flex ${hasImage && hasText ? 'flex-row' : 'flex-col justify-center'} p-[6%] gap-[5%]`}>
        {hasText && (
          <div className={hasImage ? 'flex-1 min-w-0 flex flex-col justify-center' : ''}>
            {slide.title && (
              <div className="font-bold mb-[4%] line-clamp-2" /* data */ style={{ fontFamily: headingFont, fontSize: fs.heading, lineHeight: 1.2 }}>
                {slide.title}
              </div>
            )}
            {slide.bullets?.length > 0 && (
              <ul className="list-disc pl-[6%] space-y-[3%]" /* data */ style={{ fontFamily: bodyFont, fontSize: fs.body, opacity: 0.9 }}>
                {slide.bullets.slice(0, fs.maxBullets).map((b, i) => (
                  <li key={i} className="line-clamp-1">
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {hasImage && (
          <div className={hasText ? 'flex-1 min-w-0 flex items-center justify-center' : 'flex-1 flex items-center justify-center'}>
            <img src={slide.imageDataUrl} alt="" className="max-w-full max-h-full object-contain rounded" />
          </div>
        )}
        {!hasText && !hasImage && (
          <div className="text-center opacity-50 text-label" /* data */ style={{ fontFamily: bodyFont }}>
            Slide sem texto extraído
          </div>
        )}
      </div>
    </div>
  )
}
