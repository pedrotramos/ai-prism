// Per-turn reasoning effort (W3-7): a tiny in-memory store shared by the model
// picker (writes it) and the turn request (reads it). Deliberately not persisted:
// the effort is a per-turn choice, a new tab starts on "default" and sends nothing.
//
// The effort is only ever SENT for a model whose catalog entry carries the
// `reasoning` flag (GET /api/models) and lists that level, so a stale choice
// never reaches a model that cannot take it. Pure helpers: reasoningEffort.test.js.
import { useSyncExternalStore } from 'react'

export const EFFORT_LEVELS = ['low', 'medium', 'high']

let current = 'default'
const listeners = new Set()

export function getReasoningEffort() {
  return current
}

export function setReasoningEffort(level) {
  const next = EFFORT_LEVELS.includes(level) ? level : 'default'
  if (next === current) return
  current = next
  listeners.forEach((fn) => fn())
}

export function useReasoningEffort() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getReasoningEffort,
    getReasoningEffort
  )
}

/** The levels the model accepts: `[]` when it has no `reasoning` flag. */
export function effortLevelsOf(model) {
  const levels = model?.reasoning?.levels
  if (!model?.reasoning) return []
  return EFFORT_LEVELS.filter((l) => (Array.isArray(levels) ? levels.includes(l) : true))
}

/** The `reasoning_effort` to put in a turn body: undefined unless chosen AND accepted by `model`. */
export function reasoningEffortFor(models = [], modelId, effort = current) {
  const model = models.find((m) => m.id === modelId)
  return effortLevelsOf(model).includes(effort) ? effort : undefined
}
