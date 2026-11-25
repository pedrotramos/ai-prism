import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import * as Icon from '../Icons.tsx'
import SkeletonJs from '../Skeleton.tsx'
import CostBadge from '../CostBadge.tsx'
import { useT } from '../../lib/i18n.tsx'
import BlockFrame from './BlockFrame.tsx'

// Skeleton.jsx is still JS and tsc infers its `style` prop as required; it is optional at runtime.
const Skeleton = SkeletonJs as ComponentType<{ className?: string; rounded?: string }>

// Renders a generated `image` block inline in the chat. The bytes live on a UC
// Volume and are served (scoped to the owner) by GET /api/images/:id — we fetch
// them as a blob once, hold the object URL for the block's lifetime, and offer
// download / copy / open-full-size. Mirrors the DeckBlock/SpreadsheetBlock
// card styling and the chart block's PNG-download pattern.
interface ImageBlockProps {
  block: { imageId?: string | number | null; caption?: string; prompt?: string; alt?: string; usage?: Record<string, unknown> | null; model?: string }
  models?: unknown
}

export default function ImageBlock({ block, models }: ImageBlockProps) {
  const t = useT()
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading') // loading | ready | error
  const [copied, setCopied] = useState(false)
  const blobRef = useRef<Blob | null>(null)

  useEffect(() => {
    let alive = true
    if (!block.imageId) {
      setStatus('error')
      return
    }
    ;(async () => {
      try {
        const res = await fetch(`/api/images/${block.imageId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (!alive) return
        blobRef.current = blob
        const objUrl = URL.createObjectURL(blob)
        setUrl(objUrl)
        setStatus('ready')
      } catch {
        if (alive) setStatus('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [block.imageId])

  // revoke the object URL only on unmount / id change (not on every render)
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  const filename = () => {
    const base = (block.caption || block.prompt || 'imagem')
      .replace(/[^\w-]+/g, '_')
      .slice(0, 60) || 'imagem'
    return `${base}.png`
  }

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = filename()
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const copy = async () => {
    try {
      const blob = blobRef.current
      if (!blob || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked (permissions / unsupported) — silently no-op; the
      // download action is always available as a fallback.
    }
  }

  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

  const actionBtn =
    'tap-target inline-flex items-center gap-1.5 rounded-control border border-border bg-raised hover:bg-surface-3 px-2.5 text-label font-medium text-muted hover:text-fg transition-colors duration-fast'

  return (
    <BlockFrame
      block="image"
      className="max-w-lg"
      footer={
        // Always-visible action bar: download and copy are primary affordances
        // for a generated image, not hover-only (also works on touch).
        status === 'ready' && url ? (
          <>
            <button type="button" title={t('imageBlock.downloadTitle')} onClick={download} className={actionBtn}>
              <Icon.Download size={14} /> {t('imageBlock.download')}
            </button>
            {canCopy && (
              <button type="button" title={t('imageBlock.copyTitle')} onClick={copy} className={actionBtn}>
                {copied ? <Icon.Check size={14} className="text-success" /> : <Icon.Copy size={14} />}
                {copied ? t('imageBlock.copied') : t('imageBlock.copy')}
              </button>
            )}
            <a href={url} target="_blank" rel="noreferrer" className={actionBtn}>
              <Icon.Expand size={14} /> {t('imageBlock.open')}
            </a>
            {block.usage && <CostBadge usage={block.usage} model={block.model} models={models} className="ml-auto text-caption" />}
          </>
        ) : null
      }
    >
      <div className="p-2">
        <div className="relative group overflow-hidden rounded-control">
          {status === 'loading' && <Skeleton className="w-full aspect-square" rounded="rounded-control" />}
          {status === 'error' && (
            <div role="alert" className="w-full aspect-square flex flex-col items-center justify-center gap-2 text-faint text-body">
              <Icon.Image size={22} className="opacity-40" />
              {t('imageBlock.failed')}
            </div>
          )}
          {status === 'ready' && url && (
            <a href={url} target="_blank" rel="noreferrer" title={t('imageBlock.openTitle')} className="block">
              <img src={url} alt={block.alt || block.caption || t('imageBlock.alt')} className="w-full h-auto block rounded-control" />
            </a>
          )}
        </div>
        {block.caption && <div className="px-1.5 pt-2 text-label text-muted">{block.caption}</div>}
      </div>
    </BlockFrame>
  )
}
