import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode, ReactElement, ComponentPropsWithoutRef } from 'react'
import type { Options } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.tsx'
import { safeMessageMarkdown } from './safeMessageMarkdown.ts'

// Plugin lists are module constants so a memoised segment re-renders only when
// its own text changes (a fresh array per render would defeat memo).
const REMARK = [remarkGfm]
const REHYPE_FINAL = [rehypeHighlight]
const REHYPE_NONE: Options['rehypePlugins'] = []

// Flattens a React node tree to plain text: after rehype-highlight the code is
// nested in <span> tokens, and copy needs the raw source back.
function nodeToText(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  // a React element (the highlighted <span> tokens); any other object has no text
  const el = node as ReactElement<{ children?: ReactNode }>
  if (el.props) return nodeToText(el.props.children)
  return ''
}

// `language-xxx` from react-markdown's class on the <code> of a fenced block.
function langFromClass(className: string | undefined): string {
  const m = /language-([\w+-]+)/.exec(className || '')
  return m ? m[1]! : ''
}

const WrapIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4M3 18h7" />
    <path d="m16 16-2 2 2 2" />
  </svg>
)

// A fenced code block: language label, a wrap toggle for long lines and a copy
// button over the highlighted code, like an IDE snippet.
function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const [wrap, setWrap] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const codeEl = (Array.isArray(children) ? children[0] : children) as ReactElement<{ className?: string }> | null | undefined
  const lang = langFromClass(codeEl?.props?.className)
  const raw = nodeToText(codeEl).replace(/\n$/, '')
  return (
    <div className={`code-block${wrap ? ' code-block--wrap' : ''}`}>
      <div className="code-block-header">
        <span className="code-block-lang">{lang || t('message.codePlain')}</span>
        <span className="code-block-actions">
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            className="code-block-copy"
            aria-pressed={wrap}
            aria-label={t('message.codeWrap')}
            title={t('message.codeWrap')}
          >
            <WrapIcon size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(raw)
              setDone(true)
              clearTimeout(timer.current)
              timer.current = setTimeout(() => setDone(false), 1400)
            }}
            className="code-block-copy"
            aria-label={t('message.copyCode')}
            title={t('message.copyCode')}
          >
            {done ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
            <span aria-hidden>{done ? t('message.copied') : t('message.copy')}</span>
          </button>
        </span>
      </div>
      {/* focusable: a long line scrolls from the keyboard too */}
      <pre tabIndex={0}>{children}</pre>
    </div>
  )
}

// Markdown tables get their own scroll container (wide tables scroll inside
// the bubble, the header stays visible); focusable and named so keyboard
// users can scroll it too.
function MarkdownTable({ node, children, ...rest }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  const t = useT()
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={t('message.tableRegion')}>
      <table {...rest}>{children}</table>
    </div>
  )
}

const COMPONENTS = { pre: CodeBlock, table: MarkdownTable }

/**
 * Chat markdown — the one renderer for answer prose, tool questions and tool
 * results, so every message path is neutralised by safeMessageMarkdown (raw
 * HTML escaped, script-bearing links turned into "#", code untouched) before
 * ReactMarkdown sees it. Syntax highlighting re-runs over the whole code block on
 * every render, so it is skipped while streaming (O(n²) for nobody's benefit)
 * and applied once the answer is final. Memoised: while one answer streams,
 * only its last segment's text changes, so earlier segments are not re-parsed
 * on every frame.
 */
const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={streaming ? REHYPE_NONE : REHYPE_FINAL} components={COMPONENTS}>
      {safeMessageMarkdown(text)}
    </ReactMarkdown>
  )
})

export default Markdown
