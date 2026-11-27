import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import Markdown from './Markdown.tsx'
import { extractSql, formatSeconds, stepKind, stepsSummary, stripSqlFence, toolCallView, toolKindCounts } from './logic.ts'
import type { StepKind, ToolCallState } from './logic.ts'

export interface StepToolCall extends ToolCallState {
  id?: string | number
  name?: string
  label?: string
  args?: Record<string, unknown> | null
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

export const KIND_LABEL: Record<StepKind, string> = {
  genie: 'message.kind.genie',
  genieOne: 'message.kind.genieOne',
  python: 'message.kind.python',
  vector: 'message.kind.vector',
  mcp: 'message.kind.mcp',
  web: 'message.kind.web',
  image: 'message.kind.image',
  uc: 'message.kind.uc',
}

function StepIcon({ kind }: { kind: StepKind }) {
  if (kind === 'python') return <Icon.Terminal size={14} className="shrink-0" />
  if (kind === 'web')
    return (
      <span data-tool-icon="globe" className="inline-flex shrink-0">
        <Icon.Globe2 size={15} />
      </span>
    )
  if (kind === 'image') return <Icon.Image size={15} className="shrink-0 text-accent" />
  if (kind === 'genie') return <Icon.GenieSpaces size={16} />
  if (kind === 'genieOne') return <Icon.GenieOne size={16} />
  if (kind === 'vector') return <Icon.VectorSearch size={16} />
  if (kind === 'mcp') return <Icon.McpExternal size={16} />
  return <Icon.UcFunctions size={16} />
}

const STATE_KEY = { running: 'message.tool.running', done: 'message.tool.done', failed: 'message.tool.failed' } as const

// One step of the timeline: a tool call. The title always says the state
// (dot, screen-reader text, time). Genie's question stays visible as the
// detail; the generated SQL, the Python source or the raw call and result sit
// behind one reveal link.
function Step({ tc }: { tc: StepToolCall }) {
  const t = useT() as Translate
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const view = toolCallView(tc)
  const kind = stepKind(tc.name)
  const failed = view.state === 'failed'
  const isImage = kind === 'image'
  const isGenie = kind === 'genie' || kind === 'genieOne'
  const code = kind === 'python' ? (tc.args?.code as string | undefined) : undefined
  const question = isGenie ? (tc.args?.question as string | undefined) : undefined
  const sql = isGenie && !failed ? extractSql(tc.result) : null
  const resultText = sql ? stripSqlFence(tc.result) : tc.result != null ? String(tc.result) : ''
  const argEntries = !code && !question && !isImage && tc.args ? Object.entries(tc.args) : []
  // the image tool's success text is a model-facing instruction; only an error is worth showing
  const showResult = tc.result != null && resultText !== '' && !(isImage && !failed)
  const hasReveal = Boolean(code || sql || argEntries.length > 0 || showResult)
  const revealKey = code ? 'reasoning.viewCode' : sql ? 'reasoning.viewSql' : 'reasoning.viewDetails'

  return (
    <li data-tool-state={view.state} className="step">
      <span className="step-dot" aria-hidden />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-label font-medium text-fg flex-wrap">
          <StepIcon kind={kind} />
          <span className="break-words min-w-0">{tc.label || tc.name}</span>
          <span className="sr-only">{t(STATE_KEY[view.state])}</span>
        </div>
        {failed && view.reason && <p className="text-caption text-danger mt-0.5 break-words">{view.reason}</p>}
        {question && <p className="mt-0.5 text-body text-muted line-clamp-3 break-words">{question}</p>}
        {hasReveal && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="tap-target inline-flex items-center gap-1.5 text-caption font-medium text-accent-text hover:underline rounded-badge"
          >
            {code || sql ? <Icon.Terminal size={12} className="shrink-0" /> : <Icon.ChevronRight size={12} className={`shrink-0 transition-transform duration-fast ${open ? 'rotate-90' : ''}`} />}
            {open ? t('reasoning.hide') : t(revealKey)}
          </button>
        )}
        {hasReveal && open && (
          <div id={bodyId} className="mt-1 space-y-2 text-label">
            {code && (
              <div className="prose-chat text-label [&_pre]:my-0">
                <Markdown text={'```python\n' + code + '\n```'} />
              </div>
            )}
            {sql && (
              <div className="prose-chat text-label [&_pre]:my-0">
                <Markdown text={'```sql\n' + sql + '\n```'} />
              </div>
            )}
            {argEntries.length > 0 && (
              <div className="rounded-control bg-sunk border border-border-soft p-2.5 space-y-1 font-mono text-caption">
                {argEntries.map(([k, v]) => (
                  <div key={k} className="break-words whitespace-pre-wrap">
                    <span className="text-faint">{k}:</span> {typeof v === 'string' ? v : JSON.stringify(v)}
                  </div>
                ))}
              </div>
            )}
            {showResult && (
              <div>
                <div className="text-caption uppercase tracking-wide text-faint mb-1">{failed ? t('message.error') : t('message.result')}</div>
                {failed || kind === 'python' ? (
                  <pre
                    className={`rounded-control border p-2.5 overflow-x-auto whitespace-pre-wrap text-caption ${
                      failed ? 'bg-danger-soft border-border text-danger' : 'bg-sunk border-border-soft'
                    }`}
                  >
                    {resultText as ReactNode}
                  </pre>
                ) : (
                  // these tools answer in markdown (prose, tables, links)
                  <div className="prose-chat text-label rounded-control bg-sunk border border-border-soft p-2.5 overflow-x-auto">
                    <Markdown text={resultText} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <span className="step-time tabular-nums">
        {view.state === 'failed' && <Icon.AlertTriangle size={13} className="text-danger inline mr-1 align-middle" />}
        {view.seconds}
      </span>
    </li>
  )
}

interface ReasoningCardProps {
  /** The model's native reasoning, when the turn has it (the lead card only). */
  reasoning?: string | null
  calls: StepToolCall[]
  /** The turn is still working in this card: it opens by itself and shows the sweep. */
  active?: boolean
}

// The "reasoning card": one collapsible card per run of steps, spectrum sweep
// on the top edge while the turn is working, the steps as a timeline. It opens
// by itself while it is the live tail of the turn and folds once the answer
// moves on; a click by the user wins over that.
export default function ReasoningCard({ reasoning, calls, active = false }: ReasoningCardProps) {
  const t = useT() as Translate
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual == null ? active : manual
  const bodyId = useId()
  const reasoningRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open && reasoningRef.current) reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight
  }, [reasoning, open])

  const sum = stepsSummary(calls)
  const count = sum.count + (reasoning ? 1 : 0)
  const running = active
  const time = formatSeconds(sum.totalMs)
  const stepsText = count === 1 ? t('reasoning.stepsOne') : t('reasoning.stepsMany', { count })
  const label = running
    ? t('reasoning.thinking')
    : calls.length === 0
      ? t('reasoning.done')
      : time
        ? t('reasoning.analyzed', { time, steps: stepsText })
        : t('reasoning.analyzedNoTime', { steps: stepsText })
  const kinds = toolKindCounts(calls)

  return (
    <div data-reasoning-card data-running={running ? 'true' : 'false'} data-open={open ? 'true' : 'false'} className="reason">
      <button type="button" onClick={() => setManual(!open)} aria-expanded={open} aria-controls={bodyId} className="reason-head tap-target">
        <Icon.Sparkle size={14} className="shrink-0 text-faint" />
        <span className="reason-label">{label}</span>
        {kinds.length > 0 && (
          <span className="reason-tools" aria-hidden>
            {kinds.map((k) => (
              <span key={k.kind} className="tchip">
                {t(KIND_LABEL[k.kind])}
              </span>
            ))}
          </span>
        )}
        {!running && time && calls.length > 0 && <span className="reason-time tabular-nums">{time}</span>}
        <Icon.ChevronDown size={14} className="shrink-0 text-faint chev" />
      </button>
      <div id={bodyId} className="reason-body">
        <div>
          <ol className="steps">
            {reasoning && (
              <li data-tool-state={running && calls.length === 0 ? 'running' : 'done'} className="step">
                <span className="step-dot" aria-hidden />
                <div className="min-w-0">
                  <div className="text-label font-medium text-fg">{t('reasoning.step.thought')}</div>
                  <div
                    ref={reasoningRef}
                    tabIndex={0}
                    role="region"
                    aria-label={t('reasoning.step.thought')}
                    className="mt-0.5 max-h-48 overflow-y-auto text-body text-muted whitespace-pre-wrap rounded-badge"
                  >
                    {reasoning}
                  </div>
                </div>
                <span className="step-time" />
              </li>
            )}
            {calls.map((tc, i) => (
              <Step key={tc.id ?? i} tc={tc} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}
