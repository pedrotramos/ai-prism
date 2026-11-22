import { useT } from '../lib/i18n.tsx'

interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  image_output_tokens?: number
  total_tokens?: number
}

interface ModelPrice {
  in?: number
  out?: number
}

interface CostBadgeProps {
  usage?: Usage | null
  model?: string
  models?: unknown // the chat's model list; callers type it loosely
  className?: string
}

// Formats a USD estimate: never more than 2 decimals, sub-cent as "<$0.01".
// Every surface (chat footer, badges, taxímetro) goes through it so they all
// read the same. Exported for callers that only need the number formatted.
export function fmtCost(c: number) {
  if (c < 0.01) return '<$0.01'
  return '$' + c.toFixed(2)
}

// Computes the USD estimate for a token usage against a model's list prices, or
// null when the model is unpriced/unknown (so callers can render nothing rather
// than "$NaN"). Output = max(completion, total − prompt): Gemini and the image
// endpoint report reasoning/image tokens outside completion_tokens (same rule
// as the server's cost ledger, server/usage.js normalizeUsage).
export function estimateCost(usage?: Usage | null, meta?: ModelPrice | null): number | null {
  if (!usage || !meta || !Number.isFinite(meta.in) || !Number.isFinite(meta.out)) return null
  const pt = usage.prompt_tokens || 0
  const completion = (usage.completion_tokens || 0) + (usage.image_output_tokens || 0)
  const ct = Math.max(completion, usage.total_tokens ? usage.total_tokens - pt : 0)
  if (!pt && !ct) return null
  // in/out were checked finite above (isFinite takes unknown, so TS can't narrow)
  return (pt / 1e6) * (meta.in as number) + (ct / 1e6) * (meta.out as number)
}

// A small "~$cost" chip for LLM actions outside the main chat (studio tweaks,
// media transcription, image generation). `models` is the same list the chat
// uses (id → { in, out } list prices); `usage` is { prompt_tokens,
// completion_tokens, image_output_tokens? }. Renders nothing when the cost can't
// be estimated, so it's safe to drop in unconditionally.
export default function CostBadge({ usage, model, models, className = '' }: CostBadgeProps) {
  const t = useT()
  const meta = (models as Array<ModelPrice & { id: string }> | null | undefined)?.find((m) => m.id === model)
  const cost = estimateCost(usage, meta)
  if (cost == null) return null
  return (
    <span className={`text-[var(--faint)] tabular-nums ${className}`} title={t('message.estimatedCost')}>
      ~{fmtCost(cost)}
    </span>
  )
}
