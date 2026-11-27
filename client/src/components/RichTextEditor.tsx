import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { stripUnsafeMarkdownHtml } from '../../../shared/markdownSafety.js'
import { blockedImageHtml, getEgressPolicy, imageVerdict } from '../lib/egressPolicy.ts'

// WYSIWYG editor for a document's markdown. Business users (the document
// audience — directors, non-technical staff) shouldn't have to hand-edit
// `**bold**`, `##` and `| tables |`; this is a click-and-type surface over a
// contentEditable, seeded from markdown (marked) and serialized back to
// markdown on every change (turndown + GFM plugin for tables/strikethrough).
// Markdown stays the storage format, so the server, export and AI-tweak paths
// are untouched — DocumentStudio still keeps a raw-markdown "advanced" mode.
//
// Self-contained: marked/turndown are bundled (no CDN), so it works under the
// app's strict CSP.

// One shared turndown instance. ATX headings (`##`) and fenced code match what
// the model emits and what react-markdown renders elsewhere, so a round-trip
// through the editor doesn't churn the markdown style.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
})
turndown.use(gfm)
// The GFM plugin emits single-tilde strikethrough (`~x~`), but remark-gfm — the
// renderer used everywhere else in the app — only recognizes double-tilde
// (`~~x~~`). Override so a round-trip through the editor stays renderable.
// a blocked-image placeholder goes back to the markdown image it came from.
// (typed loosely: client/src/turndown.d.ts only declares the string-filter rule shape)
const blockedImageRule = {
  filter: (node: HTMLElement) => node.nodeName === 'SPAN' && node.classList.contains('md-image-blocked'),
  replacement: (_content: string, node: HTMLElement) => `![${node.dataset.mdAlt || ''}](${node.dataset.mdSrc || ''})`,
}
turndown.addRule('blockedImage', blockedImageRule as unknown as Parameters<typeof turndown.addRule>[1])
turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content: string) => `~~${content}~~`,
})

// An image the egress policy does not allow is a placeholder, never an <img>
// (md-exfil T4): the editor's HTML is assigned to innerHTML, where an <img>
// would load, with no click. The source rides along as inert data-* so
// htmlToMarkdown can write the image syntax back.
type ImageLabel = (alt: string, host: string | null) => string
const defaultImageLabel: ImageLabel = (alt, host) => (host ? `${alt} (${host})` : alt)
const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function imageToHtml(src: string, alt: string, label: ImageLabel = defaultImageLabel): string {
  const v = imageVerdict(src, getEgressPolicy())
  if (v.blocked) return blockedImageHtml({ alt, host: v.host, src, label: label(alt, v.host) })
  return `<img src="${escAttr(src)}" alt="${escAttr(alt)}" referrerpolicy="no-referrer">`
}

// The markdown is neutralized first (raw HTML → text, unsafe link schemes → #): this
// output is assigned to innerHTML, and marked passes raw HTML through (shared/markdownSafety.js)
export function markdownToHtml(md?: string | null, imageLabel?: ImageLabel): string {
  const m = new Marked({ renderer: { image: ({ href, text }) => imageToHtml(href || '', text || '', imageLabel) } })
  // sync parse (no async extensions registered), so the result is a string, not a Promise
  return m.parse(stripUnsafeMarkdownHtml(md || ''), { breaks: false, gfm: true }) as string
}
export function htmlToMarkdown(html?: string | null): string {
  return turndown.turndown(html || '').trim()
}

// exec a formatting command on the current selection inside the editor
function exec(cmd: string, value: string | null = null) {
  // the DOM lib types the value as string | undefined; null is what this has always passed
  document.execCommand(cmd, false, value as string | undefined)
}

interface ToolbarButtonProps {
  onClick: () => void
  title: string
  children?: ReactNode
  active?: boolean
}

function ToolbarButton({ onClick, title, children, active }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      // onMouseDown + preventDefault so clicking the button doesn't blur the
      // editor and lose the selection execCommand needs to act on.
      onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault()
        onClick()
      }}
      title={title}
      aria-label={title}
      className={`grid h-8 min-w-8 place-items-center rounded-control px-1.5 text-body hover:bg-surface-3 transition-colors duration-fast ${
        active ? 'text-accent-text' : 'text-muted'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarSeparator() {
  return <span role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px shrink-0 bg-border" />
}

// The page previews the exported .docx, so — like the spreadsheet's paper — it
// stays white with near-black ink in both app themes. The custom properties
// re-scope the few tokens the prose styles read (index.css .prose-chat) to
// their light values.
/* data:start the document page: white paper and dark ink are the printed colours, not UI chrome */
const PAGE_CLASS = [
  'bg-[hsl(0_0%_100%)] text-[hsl(215_17%_14%)] [color-scheme:light]',
  '[--text:hsl(215_17%_14%)] [--muted:hsl(217_12%_33.5%)] [--border:hsl(216_16%_87.5%)] [--surface-3:hsl(214_18%_92.4%)]',
  '[--accent:hsl(233_65%_54%)] [--link:hsl(233.6_56%_46.3%)] [--code-bg:hsl(225_20%_96%)]',
].join(' ')
/* data:end */

/** The white "page" of a document: the rendered text and the editable surface both sit on it. */
export function DocPage({ children, className = '', printArea = false }: { children: ReactNode; className?: string; printArea?: boolean }) {
  return (
    <div
      data-doc-page
      className={`${printArea ? 'doc-print-area ' : ''}mx-auto w-full max-w-3xl rounded-card border border-border-soft shadow-raised font-serif ${PAGE_CLASS} ${className}`}
    >
      {children}
    </div>
  )
}

// the block style shown in the toolbar's "Text" menu
const BLOCKS = ['p', 'h1', 'h2', 'h3', 'blockquote'] as const
type Block = (typeof BLOCKS)[number]

interface RichTextEditorProps {
  markdown?: string
  onChange?: (markdown: string) => void
}

export default function RichTextEditor({ markdown, onChange }: RichTextEditorProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const lastEmitted = useRef(markdown)
  const [block, setBlock] = useState<Block>('p')
  const imageLabel: ImageLabel = (alt, host) => {
    const shown = alt || t('message.imageAltFallback')
    return host ? t('message.imageBlocked', { alt: shown, host }) : t('message.imageBlockedNoHost', { alt: shown })
  }
  const labelRef = useRef(imageLabel)
  labelRef.current = imageLabel

  // an allowed image whose load fails (dead link, CSP) becomes the same placeholder
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onErr = (e: Event) => {
      const img = e.target
      if (!(img instanceof HTMLImageElement)) return
      const src = img.getAttribute('src') || ''
      const alt = img.getAttribute('alt') || ''
      let host: string | null = null
      try {
        host = new URL(src, location.href).host || null
      } catch {
        host = null
      }
      img.outerHTML = blockedImageHtml({ alt, host: host && host !== location.host ? host : null, src, label: labelRef.current(alt, host) })
    }
    el.addEventListener('error', onErr, true)
    return () => el.removeEventListener('error', onErr, true)
  }, [])

  // keep the "Text" menu on the block the caret is in
  useEffect(() => {
    const onSel = () => {
      const node = window.getSelection()?.anchorNode
      const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
      if (!el || !ref.current?.contains(el)) return
      const hit = el.closest('h1,h2,h3,blockquote')
      setBlock(hit && ref.current.contains(hit) ? (hit.tagName.toLowerCase() as Block) : 'p')
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // Seed the DOM from markdown only when the incoming markdown differs from
  // what we last emitted — otherwise every keystroke (which bubbles up as new
  // markdown via onChange) would re-render and reset the caret. This lets an AI
  // tweak or external change flow in while typing stays smooth.
  useEffect(() => {
    if (!ref.current) return
    if (markdown === lastEmitted.current) return
    ref.current.innerHTML = markdownToHtml(markdown, imageLabel)
    lastEmitted.current = markdown
  }, [markdown])

  // initial mount
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = markdownToHtml(markdown, imageLabel)
    // eslint-disable-line react-hooks/exhaustive-deps
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = () => {
    if (!ref.current) return
    const md = htmlToMarkdown(ref.current.innerHTML)
    lastEmitted.current = md
    onChange?.(md)
  }

  const format = (block: string) => {
    // formatBlock wants a tag name; toggle back to <p> when re-clicked
    exec('formatBlock', block)
    emit()
  }

  const blockLabel: Record<Block, string> = {
    p: t('richText.paragraph'),
    h1: t('richText.h1'),
    h2: t('richText.h2'),
    h3: t('richText.h3'),
    blockquote: t('richText.quote'),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar: text style · inline marks · lists · link · clear */}
      <div role="toolbar" aria-label={t('richText.toolbar')} className="shrink-0 flex flex-wrap items-center gap-0.5 border-b border-border bg-raised px-3 py-1.5">
        <span className="relative inline-flex items-center">
          <select
            value={block}
            aria-label={t('richText.blockStyle')}
            onChange={(e) => {
              const next = e.target.value as Block
              setBlock(next)
              format(next)
              ref.current?.focus({ preventScroll: true })
            }}
            className="h-8 appearance-none rounded-control border border-transparent bg-transparent pl-2 pr-7 text-body text-fg hover:bg-surface-3 focus-visible:border-accent"
          >
            {BLOCKS.map((b) => (
              <option key={b} value={b}>{blockLabel[b]}</option>
            ))}
          </select>
          <Icon.ChevronDown size={13} className="pointer-events-none absolute right-2 text-faint" aria-hidden />
        </span>
        <ToolbarSeparator />
        <ToolbarButton onClick={() => { exec('bold'); emit() }} title={t('richText.bold')}><span className="font-bold">B</span></ToolbarButton>
        <ToolbarButton onClick={() => { exec('italic'); emit() }} title={t('richText.italic')}><span className="italic">I</span></ToolbarButton>
        <ToolbarButton onClick={() => { exec('strikeThrough'); emit() }} title={t('richText.strike')}><span className="line-through">S</span></ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton onClick={() => { exec('insertUnorderedList'); emit() }} title={t('richText.bulletList')}><Icon.List size={15} /></ToolbarButton>
        <ToolbarButton onClick={() => { exec('insertOrderedList'); emit() }} title={t('richText.numberList')}><Icon.ListOrdered size={15} /></ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton
          onClick={() => {
            const url = window.prompt(t('richText.linkPrompt'))
            if (url) { exec('createLink', url); emit() }
          }}
          title={t('richText.link')}
        >
          <Icon.Link size={15} />
        </ToolbarButton>
        <ToolbarButton onClick={() => { exec('removeFormat'); emit() }} title={t('richText.clear')}><Icon.Eraser size={15} /></ToolbarButton>
      </div>
      {/* the page: editable surface — reuses the same prose styles as the rendered doc */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-sunk px-3 py-4 md:px-6 md:py-6">
        <DocPage>
          <div
            ref={ref}
            contentEditable
            suppressContentEditableWarning
            onInput={emit}
            onBlur={emit}
            spellCheck
            role="textbox"
            aria-multiline="true"
            aria-label={t('richText.editorLabel')}
            className="prose-chat prose-doc min-h-[50vh] p-5 md:p-10"
          />
        </DocPage>
      </div>
    </div>
  )
}
