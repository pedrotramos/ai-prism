import { useEffect, useMemo, useRef, useState } from 'react'
import { buildDeckAssetMap, resolveDeckAssets, DECK_ASSET_FALLBACK_CSS } from '../../lib/deckAssets.ts'

// Pure-HTML deck engine (feat/deck-html-engine): render ONE model-authored
// <section> slide as a scaled, sandboxed 1280×720 iframe with the design
// system's tokens/fonts injected — the same mechanism the DS specimen cards use
// (buildTokenStyle/withTokens in DeckTemplateInspector.jsx), reused here so a
// generated slide resolves var(--…) against the brand exactly like the DS's own
// example slides. WYSIWYG: what you see IS the HTML that exports.
//
// This is deliberately dumb — no fitting engine, no absolute-box tree. The slide
// flows in real HTML, which is the whole point of the pivot (kills word-per-line).

// Changing `srcdoc` on a live iframe is a navigation of that frame: it adds a
// session-history entry, so the browser/phone Back first walks the hidden frame
// back through earlier slides (the page sees no popstate and Back seems dead).
// A new document gets a new iframe element instead (key), which adds none.
let frameSeq = 0
const STAGE_W = 1280
const STAGE_H = 720

// The slice of a persisted DS template this frame reads.
interface FrameTemplate {
  fontAssets?: Array<{ family?: string; dataUrl?: string; weight?: string | number; style?: string }> | null
  palette?: Array<{ varName?: string; value?: unknown }> | null
  primaryColor?: string | null
  secondaryColor?: string | null
  accentColor?: string | null
  backgroundColor?: string | null
  headingFont?: string | null
  bodyFont?: string | null
  iconAssets?: Array<{ id?: string | number; dataUrl?: unknown }> | null
  logoDataUrl?: string | null
  logoLightDataUrl?: string | null
}

interface HtmlSlideFrameProps {
  html?: string | null
  template?: FrameTemplate | null
  title?: string
  className?: string
  background?: string
  decorative?: boolean
}

// Rebuilds the DS token CSS from the template's persisted palette + fontAssets.
// Mirrors DeckTemplateInspector.buildTokenStyle; kept local so the deck path
// doesn't import from a settings screen. Any DS drives this — no hardcoding.
export function buildDeckTokenStyle(template?: FrameTemplate | null) {
  if (!template) return ''
  const parts: string[] = []
  const fonts = template.fontAssets || []
  for (const f of fonts) {
    if (!f?.family || !f?.dataUrl) continue
    parts.push(
      `@font-face{font-family:'${f.family.replace(/'/g, '')}';` +
        `font-weight:${f.weight || 400};font-style:${f.style || 'normal'};` +
        `font-display:swap;src:url(${f.dataUrl});}`,
    )
  }
  const vars: string[] = []
  for (const t of template.palette || []) {
    if (t?.varName && typeof t.value === 'string') vars.push(`${t.varName}:${t.value};`)
  }
  // raw brand color fields also become the generic tokens the generation
  // contract promised the model (--primary/--accent/--background/--secondary)
  const map = {
    '--primary': template.primaryColor,
    '--secondary': template.secondaryColor,
    '--accent': template.accentColor,
    '--background': template.backgroundColor,
  }
  for (const [k, v] of Object.entries(map)) if (v) vars.push(`${k}:${v};`)
  const families = [...new Set(fonts.map((f) => f.family).filter((f): f is string => Boolean(f)))]
  const heading = template.headingFont || families[0]
  if (heading) {
    const h = heading.replace(/'/g, '')
    vars.push(`--font-sans:'${h}',system-ui,-apple-system,sans-serif;`)
    vars.push(`--font-heading:'${h}',system-ui,-apple-system,sans-serif;`)
  }
  const body = template.bodyFont || heading
  if (body) vars.push(`--font-body:'${body.replace(/'/g, '')}',system-ui,-apple-system,sans-serif;`)
  const mono = families.find((f) => /mono/i.test(f))
  if (mono) vars.push(`--font-mono:'${mono.replace(/'/g, '')}',ui-monospace,'SF Mono',Menlo,monospace;`)
  /* data:start DS shadow ramp */
  vars.push('--shadow-sm:0 1px 2px rgba(27,49,57,.06),0 1px 3px rgba(27,49,57,.08);')
  vars.push('--shadow-md:0 2px 6px rgba(27,49,57,.08),0 8px 20px rgba(27,49,57,.08);')
  vars.push('--shadow-lg:0 8px 24px rgba(27,49,57,.10),0 24px 48px rgba(27,49,57,.10);')
  /* data:end */
  if (vars.length) parts.push(`:root{${vars.join('')}}`)
  return parts.join('')
}

// Wrap a single <section> into a full sandbox document at fixed stage size, with
// the token style at the top of <head> so brand vars resolve.
function buildSrcDoc(sectionHtml: string, tokenStyle: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style data-ds-tokens>${tokenStyle}</style>
<style>
  html,body{margin:0;padding:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;
    background:var(--background,#fff);font-family:var(--font-body,var(--font-sans,system-ui));}
  /* the slide fills the stage; the model's own section styles layer on top */
  section.slide,section{box-sizing:border-box;width:${STAGE_W}px;height:${STAGE_H}px;
    position:relative;overflow:hidden;}
  ${DECK_ASSET_FALLBACK_CSS}
</style>
</head><body>${sectionHtml || ''}</body></html>`
}

// `decorative` (thumbnails): the frame is a picture of a slide the
// surrounding button already names, so it is skipped by Tab and screen readers.
export default function HtmlSlideFrame({ html, template, title = 'slide', className = '', background = '#0e1a1f', decorative = false }: HtmlSlideFrameProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const tokenStyle = useMemo(() => buildDeckTokenStyle(template), [template])
  // resolve DS asset placeholders (data-ds-asset-id / data-ds-logo) to the
  // brand's real inlined art before painting — kept symbolic in the stored HTML
  const assetMap = useMemo(() => buildDeckAssetMap(template), [template])
  const resolvedHtml = useMemo(() => resolveDeckAssets(html, assetMap), [html, assetMap])
  const srcDoc = useMemo(() => buildSrcDoc(resolvedHtml, tokenStyle), [resolvedHtml, tokenStyle])
  const frameKey = useMemo(() => ++frameSeq, [srcDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const update = () => setScale(el.clientWidth / STAGE_W)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className={`w-full overflow-hidden ${className}`} /* data */ style={{ aspectRatio: '16/9', background }}>
      <iframe
        key={frameKey}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        tabIndex={decorative ? -1 : undefined}
        aria-hidden={decorative || undefined}
        className="border-0 origin-top-left"
        /* data */ style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, pointerEvents: 'none' }}
      />
    </div>
  )
}
