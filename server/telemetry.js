// OpenTelemetry spans for the two calls that explain a slow or failed turn:
//   llm.call  {gen_ai.request.model, gen_ai.usage.input_tokens,
//              gen_ai.usage.output_tokens, cost_usd, status}
//   tool.call {tool.name, tool.kind, duration_ms, status}
//
// App code uses the OTel API only. The exporter is AppKit's: it registers a
// tracer provider with the OTLP exporter only when OTEL_EXPORTER_OTLP_ENDPOINT
// is set (the Apps telemetry destination writes them to the UC `otel_spans`
// table). Without it, and always in the legacy boot (APPKIT_BOOT=0), the API
// returns non-recording spans: nothing is exported and the cost is a few object
// allocations per call, off the token path.
//
// Attributes never carry prompt text, tool arguments, e-mails or SQL.
import { trace, SpanStatusCode } from '@opentelemetry/api'

const TRACER = 'ai-prism'

function tracer() {
  return trace.getTracer(TRACER)
}

/** Starts a span (child of the active one, if any). The caller must end() it. */
export function startSpan(name, attributes = {}) {
  return tracer().startSpan(name, { attributes })
}

/** Marks the span ok/error with the `status` attribute and the span status. */
export function finishSpan(span, error) {
  try {
    if (error) {
      span.setAttribute('status', 'error')
      // the error message can quote the request: only its class goes on the span
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.name || 'Error' })
    } else {
      span.setAttribute('status', 'ok')
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end()
  } catch {
    // telemetry never breaks the call it observes
  }
}

/** Runs fn(span) inside a span; returns its result or rethrows its error unchanged. */
export async function withSpan(name, attributes, fn) {
  const span = startSpan(name, attributes)
  try {
    const out = await fn(span)
    finishSpan(span, null)
    return out
  } catch (e) {
    finishSpan(span, e)
    throw e
  }
}

// ---- llm.call ------------------------------------------------------------------

export function startLlmSpan(model) {
  return startSpan('llm.call', { 'gen_ai.request.model': String(model || '') })
}

// Token counts as the cost ledger bills them (server/usage.js): output is
// max(completion, total − prompt), since Gemini and the image endpoints report
// reasoning/image tokens only inside total_tokens.
export function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.prompt_tokens ?? usage.input_tokens) || 0
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0
  const total = Number(usage.total_tokens) || 0
  return { input, output: Math.max(completion, total - input) }
}

/** Usage and price of one gateway call onto its llm.call span. */
export function recordLlmUsage(span, usage, costUsd) {
  if (!span) return
  try {
    const t = usageTokens(usage)
    if (t) {
      span.setAttribute('gen_ai.usage.input_tokens', t.input)
      span.setAttribute('gen_ai.usage.output_tokens', t.output)
    }
    if (typeof costUsd === 'number' && Number.isFinite(costUsd)) span.setAttribute('cost_usd', costUsd)
  } catch {
    // never into the call
  }
}

// ---- tool.call -----------------------------------------------------------------

/** Runs a tool invocation inside a tool.call span. */
export async function withToolSpan(resolver, fn) {
  const started = performance.now()
  const span = startSpan('tool.call', {
    'tool.name': String(resolver?.toolName || ''),
    'tool.kind': String(resolver?.kind || ''),
  })
  const duration = () => span.setAttribute('duration_ms', Math.round((performance.now() - started) * 10) / 10)
  try {
    const out = await fn()
    duration()
    // a tool that answers with an ERROR: text (an MCP connection that failed to
    // load, no search tool) did not do its job, even though it did not throw
    const failed = typeof out?.resultText === 'string' && out.resultText.startsWith('ERROR:')
    finishSpan(span, failed ? new Error('tool returned an error') : null)
    return out
  } catch (e) {
    duration()
    finishSpan(span, e)
    throw e
  }
}
