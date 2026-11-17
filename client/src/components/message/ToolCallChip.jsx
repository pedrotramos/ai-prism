import { useId, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import Markdown from './Markdown.jsx'
import { toolCallView } from './logic.js'

function ToolIcon({ name }) {
  if (name === 'execute_python') return <Icon.Terminal size={14} className="shrink-0" />
  if (name === 'generate_image') return <Icon.Image size={15} className="shrink-0 text-accent" />
  if (name?.startsWith('genie__')) return <Icon.GenieSpaces size={16} />
  if (name === 'ask_genie_one') return <Icon.GenieOne size={16} />
  if (name?.startsWith('vs__')) return <Icon.VectorSearch size={16} />
  // `mcp_` = current naming; `mcpext__` = tool calls persisted before the rename
  if (name?.startsWith('mcp_') || name?.startsWith('mcpext__')) return <Icon.McpExternal size={16} />
  return <Icon.UcFunctions size={16} />
}

const STATE_KEY = { running: 'message.tool.running', done: 'message.tool.done', failed: 'message.tool.failed' }

// One tool call in the narrative, where it happened. The header always says
// the state: running (spinner + live seconds), done (check + duration) or
// failed (warning + duration + the reason in one line, readable without
// expanding). Expanding shows the narration: what was asked and what came back.
export default function ToolCallChip({ tc }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const view = toolCallView(tc)
  const isPython = tc.name === 'execute_python'
  const isImageGen = tc.name === 'generate_image'
  const isGenie = tc.name?.startsWith('genie__') || tc.name === 'ask_genie_one'
  const failed = view.state === 'failed'
  const code = isPython ? tc.args?.code : null

  return (
    <div data-tool-state={view.state} className="rounded-control border border-border bg-surface-2 mb-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="tap-target w-full flex items-center gap-2 px-3 py-1.5 text-left text-label hover:bg-surface-3 transition-colors duration-fast"
      >
        <Icon.ChevronRight size={13} className={`shrink-0 text-faint transition-transform duration-fast ${open ? 'rotate-90' : ''}`} />
        <ToolIcon name={tc.name} />
        <span className="flex-1 min-w-0">
          <span className="block font-semibold leading-snug line-clamp-2 break-words">{tc.label || tc.name}</span>
          {failed && view.reason && <span className="block text-caption text-danger truncate">{view.reason}</span>}
        </span>
        <span className="sr-only">{t(STATE_KEY[view.state])}</span>
        {view.state === 'running' && (
          <>
            {view.seconds && <span className="text-faint shrink-0 tabular-nums">{view.seconds}</span>}
            <span aria-hidden className="block w-3 h-3 rounded-pill border-2 border-accent border-t-transparent animate-spin shrink-0" />
          </>
        )}
        {view.state !== 'running' && (
          <>
            {failed ? (
              <Icon.AlertTriangle size={14} className="text-danger shrink-0" />
            ) : (
              <Icon.Check size={14} className="text-success shrink-0" />
            )}
            {view.seconds && <span className="text-faint shrink-0 tabular-nums">{view.seconds}</span>}
          </>
        )}
      </button>
      {open && (
        <div id={bodyId} className="px-3 pb-3 pt-1 space-y-2 text-label">
          {code ? (
            <div className="prose-chat text-label [&_pre]:my-0">
              <Markdown text={'```python\n' + code + '\n```'} />
            </div>
          ) : isGenie && tc.args?.question ? (
            // Genie's question is natural language, often long: rendered in
            // full as rich text, not a truncated key: value line.
            <div className="rounded-control bg-surface border border-border p-2.5">
              <div className="text-caption uppercase tracking-wide text-faint mb-1">{t('message.question')}</div>
              <div className="prose-chat text-label">
                <Markdown text={tc.args.question} />
              </div>
            </div>
          ) : isImageGen ? null : (
            // (the image prompt is a model-facing detail; the image block is the output)
            tc.args &&
            Object.keys(tc.args).length > 0 && (
              <div className="rounded-control bg-surface border border-border p-2.5 space-y-1 font-mono">
                {Object.entries(tc.args).map(([k, v]) => (
                  <div key={k} className="break-words whitespace-pre-wrap">
                    <span className="text-faint">{k}:</span> {typeof v === 'string' ? v : JSON.stringify(v)}
                  </div>
                ))}
              </div>
            )
          )}
          {/* image-gen: the success text is a model-facing instruction; only an error is worth showing */}
          {tc.result != null && !(isImageGen && !failed) && (
            <div>
              <div className="text-caption uppercase tracking-wide text-faint mb-1">
                {failed ? t('message.error') : t('message.result')}
              </div>
              {failed || isPython ? (
                <pre
                  className={`rounded-control border p-2.5 overflow-x-auto whitespace-pre-wrap ${
                    failed ? 'bg-danger-soft border-border text-danger' : 'bg-surface border-border'
                  }`}
                >
                  {tc.result}
                </pre>
              ) : (
                // these tools answer in markdown (prose, tables, a SQL fence, links)
                <div className="prose-chat text-label rounded-control bg-surface border border-border p-2.5 overflow-x-auto">
                  <Markdown text={String(tc.result)} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
