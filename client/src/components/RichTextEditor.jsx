import { useEffect, useRef } from 'react'
import { marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { stripUnsafeMarkdownHtml } from '../../../shared/markdownSafety.js'

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
turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content) => `~~${content}~~`,
})

// The markdown is neutralized first (raw HTML → text, unsafe link schemes → #): this
// output is assigned to innerHTML, and marked passes raw HTML through (shared/markdownSafety.js)
export function markdownToHtml(md) {
  return marked.parse(stripUnsafeMarkdownHtml(md || ''), { breaks: false, gfm: true })
}
export function htmlToMarkdown(html) {
  return turndown.turndown(html || '').trim()
}

// exec a formatting command on the current selection inside the editor
function exec(cmd, value = null) {
  document.execCommand(cmd, false, value)
}

function ToolbarButton({ onClick, title, children, active }) {
  return (
    <button
      type="button"
      // onMouseDown + preventDefault so clicking the button doesn't blur the
      // editor and lose the selection execCommand needs to act on.
      onMouseDown={(e) => {
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

export default function RichTextEditor({ markdown, onChange }) {
  const t = useT()
  const ref = useRef(null)
  const lastEmitted = useRef(markdown)

  // Seed the DOM from markdown only when the incoming markdown differs from
  // what we last emitted — otherwise every keystroke (which bubbles up as new
  // markdown via onChange) would re-render and reset the caret. This lets an AI
  // tweak or external change flow in while typing stays smooth.
  useEffect(() => {
    if (!ref.current) return
    if (markdown === lastEmitted.current) return
    ref.current.innerHTML = markdownToHtml(markdown)
    lastEmitted.current = markdown
  }, [markdown])

  // initial mount
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = markdownToHtml(markdown)
    // eslint-disable-line react-hooks/exhaustive-deps
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = () => {
    if (!ref.current) return
    const md = htmlToMarkdown(ref.current.innerHTML)
    lastEmitted.current = md
    onChange?.(md)
  }

  const format = (block) => {
    // formatBlock wants a tag name; toggle back to <p> when re-clicked
    exec('formatBlock', block)
    emit()
  }

  return (
    <div className="flex min-h-[50vh] flex-col">
      {/* toolbar */}
      <div role="toolbar" aria-label={t('richText.toolbar')} className="flex flex-wrap items-center gap-0.5 border-b border-border-soft px-2 py-1.5">
        <ToolbarButton onClick={() => format('h1')} title={t('richText.h1')}><span className="font-semibold">H1</span></ToolbarButton>
        <ToolbarButton onClick={() => format('h2')} title={t('richText.h2')}><span className="font-semibold">H2</span></ToolbarButton>
        <ToolbarButton onClick={() => format('h3')} title={t('richText.h3')}><span className="font-semibold">H3</span></ToolbarButton>
        <ToolbarButton onClick={() => format('p')} title={t('richText.paragraph')}><span className="text-label" aria-hidden>¶</span></ToolbarButton>
        <span role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px bg-border" />
        <ToolbarButton onClick={() => { exec('bold'); emit() }} title={t('richText.bold')}><span className="font-bold">B</span></ToolbarButton>
        <ToolbarButton onClick={() => { exec('italic'); emit() }} title={t('richText.italic')}><span className="italic">I</span></ToolbarButton>
        <ToolbarButton onClick={() => { exec('strikeThrough'); emit() }} title={t('richText.strike')}><span className="line-through">S</span></ToolbarButton>
        <span role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px bg-border" />
        <ToolbarButton onClick={() => { exec('insertUnorderedList'); emit() }} title={t('richText.bulletList')}><Icon.List size={15} /></ToolbarButton>
        <ToolbarButton onClick={() => { exec('insertOrderedList'); emit() }} title={t('richText.numberList')}><Icon.ListOrdered size={15} /></ToolbarButton>
        <ToolbarButton onClick={() => { format('blockquote') }} title={t('richText.quote')}><Icon.Quote size={15} /></ToolbarButton>
        <span role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px bg-border" />
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
      {/* editable surface — reuses the same prose styles as the rendered doc */}
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
        className="prose-chat prose-doc min-h-[50vh] flex-1 overflow-y-auto p-5 md:p-7"
      />
    </div>
  )
}
