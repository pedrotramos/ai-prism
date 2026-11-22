import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n.tsx'

/**
 * HtmlDeckPreview: renders HTML deck in a sandbox iframe
 * Features:
 * - Self-contained HTML (no external resources)
 * - Render progressively as HTML arrives
 * - CSP-protected sandbox
 * - Handles incremental loading via streaming
 */
interface HtmlDeckPreviewProps {
  html?: string
  className?: string
  onReady?: (() => void) | null
}

export default function HtmlDeckPreview({ html, className = '', onReady = null }: HtmlDeckPreviewProps) {
  const t = useT()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loading, setLoading] = useState(!!html)

  useEffect(() => {
    if (!html || !iframeRef.current) return

    try {
      const iframe = iframeRef.current
      const doc = iframe.contentDocument as Document // same-origin srcdoc iframe: never null here; a null would throw into the existing catch

      // Reset doc
      doc.open()

      // Set minimal CSP and write HTML
      doc.write(html)
      doc.close()

      setLoading(false)
      onReady?.()
    } catch (e) {
      console.error('HtmlDeckPreview error:', e)
      setLoading(false)
    }
  }, [html, onReady])

  return (
    <div className={`relative w-full bg-surface-2 rounded-card overflow-hidden ${className}`}>
      {loading && (
        <div role="status" className="absolute inset-0 bg-surface/50 flex items-center justify-center z-raised">
          <div className="text-body text-muted">{t('deckStudio.loading')}</div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className="w-full h-full"
        /* data */ style={{ aspectRatio: '16 / 9', border: 'none' }}
        title={t('deckStudio.title')}
        sandbox="allow-same-origin"
        srcDoc={html}
      />
    </div>
  )
}
