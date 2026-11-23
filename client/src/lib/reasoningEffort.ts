// Per-turn reasoning effort (W3-7): a tiny in-memory store shared by the model
// picker (writes it) and the turn request (reads it). Deliberately not persisted:
// the effort is a per-turn choice, a new tab starts on "auto" and sends nothing.
//
// The effort is only ever SENT for a model whose catalog entry carries the
// `reasoning` flag (GET /api/models) and lists that level, so a stale choice
// never reaches a model that cannot take it. Pure helpers: reasoningEffort.test.ts.
import { useSyncExternalStore } from 'react'

export const EFFORT_LEVELS = ['low', 'medium', 'high']
/** What the picker offers: "auto" (send nothing, the model decides) then the levels. */
export const EFFORT_CHOICES = ['auto', ...EFFORT_LEVELS]

/** A model entry of GET /api/models, as far as the effort helpers read it. */
interface EffortModel {
  id?: string
  reasoning?: { levels?: string[]; [k: string]: unknown } | boolean | null
}

let current = 'auto'
const listeners = new Set<() => void>()

export function getReasoningEffort(): string {
  return current
}

export function setReasoningEffort(level: string): void {
  // 'default' is the pre-redesign name of 'auto'; both mean "send no effort"
  const next = EFFORT_LEVELS.includes(level) ? level : 'auto'
  if (next === current) return
  current = next
  listeners.forEach((fn) => fn())
}

export function useReasoningEffort(): string {
  return useSyncExternalStore(
    (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getReasoningEffort,
    getReasoningEffort
  )
}

/** The levels the model accepts: `[]` when it has no `reasoning` flag. */
export function effortLevelsOf(model: EffortModel | null | undefined): string[] {
  const reasoning = model?.reasoning
  const levels = typeof reasoning === 'object' && reasoning ? reasoning.levels : undefined
  if (!reasoning) return []
  return EFFORT_LEVELS.filter((l) => (Array.isArray(levels) ? levels.includes(l) : true))
}

/** The `reasoning_effort` to put in a turn body: undefined unless chosen AND accepted by `model`. */
export function reasoningEffortFor(models: EffortModel[] = [], modelId: string | undefined, effort: string = current): string | undefined {
  const model = models.find((m) => m.id === modelId)
  return effortLevelsOf(model).includes(effort) ? effort : undefined
}
