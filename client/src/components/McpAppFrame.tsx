import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import * as Icon from './Icons.tsx'
import { useT, useI18n } from '../lib/i18n.tsx'
import { getJSON, postJSON } from '../api.ts'
import { useModalDialog } from '../lib/useModalDialog.ts'
import { createViewHost, hostContextFor, variablesFromTokens, MCP_APP_LIMITS } from '../lib/mcpAppHost.ts'
import type { ToolCallRequest, ViewContext, ViewHost } from '../lib/mcpAppHost.ts'
import { primaryBtn, ghostBtn } from './projects/ui.tsx'

// An MCP App in the chat (W4-5): the tool call that declared a UI resource shows an inert placeholder; opening it loads the tool's own
// View in a sandboxed iframe that cannot reach this app, its API or the user's session. Design: docs/mcp-apps.md, ADR-0019.
//
//  - The iframe is `sandbox="allow-scripts allow-forms"` (never allow-same-origin): an opaque origin. Its document comes from
//    /api/mcp-apps/view/:id, whose CSP header lists only the origins the server declared.
//  - The bridge is connected BEFORE the frame navigates (src is set after), so the View's first message cannot be lost.
//  - A border and a label sit OUTSIDE the frame, so a View cannot pass as host UI.
//  - At most 3 Views are active per page.

export interface McpAppToolCall {
  id?: string | number
  hasUi?: boolean
  uiServiceName?: string
  uiToolCallId?: string
  uiCsp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] }
}

// ---- page-wide state: whether the feature is on, and how many Views are open ----------------------------------------
let statusPromise: Promise<boolean> | null = null
const loadStatus = (): Promise<boolean> => (statusPromise ??= getJSON<{ enabled?: boolean }>('/api/mcp-apps/status').then((r) => r?.enabled === true, () => false))

const active = new Set<string>()
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn))
const activeCount = () => active.size
const setActive = (key: string, on: boolean) => {
  if (on) active.add(key)
  else active.delete(key)
  listeners.forEach((l) => l())
}

// ---- the host's own confirmation dialog (outside the frame) ----------------------------------------------------------
interface ConfirmProps {
  title: string
  body: ReactNode
  detail: string
  confirmLabel: string
  onResult: (ok: boolean) => void
}
function HostConfirm({ title, body, detail, confirmLabel, onResult }: ConfirmProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  useModalDialog(ref, { onClose: () => onResult(false), initialFocus: (el) => el.querySelector<HTMLElement>('[data-cancel]') })
  return (
    <div className="fixed inset-0 z-modal grid place-items-center bg-scrim p-4">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="w-full max-w-lg rounded-card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-modal space-y-3">
        <h2 id={titleId} className="text-body font-semibold text-[var(--text)]">
          {title}
        </h2>
        <p id={bodyId} className="text-body text-[var(--muted)]">
          {body}
        </p>
        <pre tabIndex={0} className="max-h-60 overflow-auto rounded-control border border-[var(--border)] bg-[var(--surface-2)] p-2 text-label text-[var(--text)] whitespace-pre-wrap break-all">{detail}</pre>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" data-cancel onClick={() => onResult(false)} className={ghostBtn}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={() => onResult(true)} className={primaryBtn}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

type Pending = { kind: 'call'; req: ToolCallRequest; resolve: (ok: boolean) => void } | { kind: 'link'; url: string; resolve: (ok: boolean) => void }

function declaredDomains(csp: McpAppToolCall['uiCsp']): string[] {
  return [...new Set([...(csp?.connectDomains || []), ...(csp?.resourceDomains || []), ...(csp?.frameDomains || [])])]
}

export default function McpAppFrame({ tc }: { tc: McpAppToolCall }) {
  const t = useT()
  const { locale } = useI18n() as { locale: string }
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(240)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const hostRef = useRef<ViewHost | null>(null)
  const total = useSyncExternalStore(subscribe, activeCount, activeCount)
  const statusId = useId()

  // the frame's height follows what the View reports (clamped); set on the element, not as a render-time style
  useEffect(() => {
    if (iframeRef.current) iframeRef.current.style.height = `${height}px`
  }, [height, open])

  const serviceName = tc.uiServiceName || ''
  const id = tc.uiToolCallId
  const key = String(id ?? tc.id ?? '')

  useEffect(() => {
    let live = true
    loadStatus().then((v) => live && setEnabled(v))
    return () => {
      live = false
    }
  }, [])

  // open: build the host and connect the bridge, THEN point the frame at the view route
  useEffect(() => {
    if (!open || !id) return undefined
    const frame = iframeRef.current
    const win = frame?.contentWindow
    if (!frame || !win) return undefined
    let dead = false
    setActive(key, true)
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const context: Promise<ViewContext> = getJSON<ViewContext>(`/api/mcp-apps/${id}/context`)
    context.catch(() => !dead && setFailed(true))
    const host = createViewHost({
      window: win,
      context,
      hostContext: hostContextFor({ theme: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark', locale, variables: variablesFromTokens((tok) => cs.getPropertyValue(tok)) }),
      confirmToolCall: (req) => new Promise<boolean>((resolve) => setPending({ kind: 'call', req, resolve })),
      confirmOpenLink: (url) => new Promise<boolean>((resolve) => setPending({ kind: 'link', url, resolve })),
      openLink: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
      callTool: (name, args) => postJSON(`/api/mcp-apps/${id}/tools/call`, { name, arguments: args, serviceName }),
      // into the composer, never sent: the user reads it and presses Send
      onMessage: (text) => window.dispatchEvent(new CustomEvent('prism:composer-prefill', { detail: { text } })),
      onSize: (h) => !dead && setHeight(h),
    })
    hostRef.current = host
    host
      .connect()
      .then(() => {
        if (!dead) frame.setAttribute('src', `/api/mcp-apps/view/${id}`)
      })
      .catch(() => !dead && setFailed(true))
    return () => {
      dead = true
      hostRef.current = null
      setActive(key, false)
      void host.close()
    }
    // the frame is created once per open; locale/serviceName do not change while a View runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id])

  if (!tc.hasUi || !enabled) return null

  const domains = declaredDomains(tc.uiCsp)
  const atLimit = !open && total >= MCP_APP_LIMITS.maxActive
  const ready = !!id // a live tool call has no id until the answer is saved
  const answer = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  return (
    <div className="my-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-2" data-mcp-app-host="">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-label text-[var(--muted)]">
          <Icon.McpExternal size={14} className="mr-1 inline" />
          {t('mcpApps.label', { service: serviceName })}
        </p>
        {open && (
          <button type="button" onClick={() => setOpen(false)} className={ghostBtn} aria-label={t('mcpApps.close')}>
            {t('mcpApps.close')}
          </button>
        )}
      </div>
      {!open && (
        <div className="mt-1 space-y-1">
          <button type="button" onClick={() => setOpen(true)} disabled={!ready || atLimit} aria-describedby={statusId} className={ghostBtn}>
            {t('mcpApps.open', { service: serviceName })}
          </button>
          <p id={statusId} className="text-label text-[var(--muted)]">
            {!ready ? t('mcpApps.streaming') : atLimit ? t('mcpApps.limit') : domains.length ? t('mcpApps.domains', { domains: domains.join(', ') }) : t('mcpApps.noDomains')}
          </p>
        </div>
      )}
      {open && (
        <>
          <iframe
            ref={iframeRef}
            data-mcp-app=""
            title={t('mcpApps.frameTitle', { service: serviceName })}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            className="mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--surface)]"
          />
          {failed && (
            <p role="alert" className="mt-1 text-label text-[var(--danger)]">
              {t('mcpApps.loadFailed')}
            </p>
          )}
        </>
      )}
      {pending?.kind === 'call' && (
        <HostConfirm title={t('mcpApps.callTitle')} body={t('mcpApps.callBody', { service: pending.req.serviceName, tool: pending.req.toolName })} detail={pending.req.argumentsText} confirmLabel={t('mcpApps.allow')} onResult={answer} />
      )}
      {pending?.kind === 'link' && (
        <HostConfirm title={t('mcpApps.linkTitle')} body={t('mcpApps.linkBody', { service: serviceName })} detail={pending.url} confirmLabel={t('mcpApps.openLink')} onResult={answer} />
      )}
    </div>
  )
}
