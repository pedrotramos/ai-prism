import { useEffect, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import type { TFn } from '../../lib/tFn.ts'

// Attachments waiting to be sent, above the message box. Images show a live
// thumbnail (object URL, revoked on unmount) so a pasted screenshot is
// recognisable; audio/video show a media glyph (transcribed server-side);
// other files show the file icon + name. Every remove button is named
// ("Remove report.csv") and is at least 24 px, 44 px on touch screens.

export const isImageFile = (f: { type?: string }): boolean => (f.type || '').startsWith('image/')

const VIDEO_EXT = /^(mp4|mov|webm|m4v|mpeg|mpg|avi|mkv|3gp)$/

// 'audio' | 'video' | null, for the chip glyph only (the server does the real
// detection): the mime type first, then the extension against the
// workspace's advertised media list.
export type MediaKind = 'audio' | 'video' | null

export function mediaKind(f: { type?: string; name: string }, mediaExt: string[] = []): MediaKind {
  const m = f.type || ''
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  const dot = f.name.lastIndexOf('.')
  const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : ''
  if (mediaExt.includes(ext)) return VIDEO_EXT.test(ext) ? 'video' : 'audio'
  return null
}

const REMOVE_BTN =
  'shrink-0 inline-flex items-center justify-center w-11 h-11 md:w-6 md:h-6 rounded-control text-muted hover:text-fg hover:bg-surface transition-colors duration-fast'

function Chip({ file, media, onRemove }: { file: File; media: MediaKind; onRemove: () => void }) {
  const t: TFn = useT()
  const image = isImageFile(file)
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    if (!image) return
    const url = URL.createObjectURL(file)
    setThumb(url)
    return () => URL.revokeObjectURL(url)
  }, [file, image])

  const label = t('composer.removeAttachment', { name: file.name })

  if (image) {
    return (
      <li className="relative inline-flex">
        <img
          src={thumb || undefined}
          alt={file.name}
          className="w-14 h-14 rounded-control object-cover border border-border"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={label}
          title={label}
          className="absolute -top-2 -right-2 inline-flex items-center justify-center w-7 h-7 md:w-6 md:h-6 rounded-pill bg-surface-3 border border-border text-muted hover:text-fg hover:bg-surface transition-colors duration-fast"
        >
          <Icon.Close size={12} />
        </button>
      </li>
    )
  }

  const Glyph = media === 'video' ? Icon.Play : media === 'audio' ? Icon.Waveform : Icon.File
  return (
    <li className="inline-flex items-center gap-1.5 text-label bg-surface-3 rounded-control pl-2 pr-0.5 py-0.5">
      <Glyph size={13} className={media ? 'text-accent' : 'text-muted'} aria-hidden="true" />
      <span className="max-w-40 truncate">{file.name}</span>
      <button type="button" onClick={onRemove} aria-label={label} title={label} className={REMOVE_BTN}>
        <Icon.Close size={12} />
      </button>
    </li>
  )
}

interface AttachmentChipsProps {
  files: File[]
  mediaExt?: string[]
  onRemove: (index: number) => void
}

export default function AttachmentChips({ files, mediaExt, onRemove }: AttachmentChipsProps) {
  const t: TFn = useT()
  if (!files.length) return null
  return (
    <ul className="flex flex-wrap items-start gap-2 px-4 pt-3" aria-label={t('composer.attachments')}>
      {files.map((f, i) => (
        <Chip key={`${f.name}:${f.size}:${i}`} file={f} media={mediaKind(f, mediaExt)} onRemove={() => onRemove(i)} />
      ))}
    </ul>
  )
}
