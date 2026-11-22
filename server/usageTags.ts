// The gateway usage_context tags of an unattended run (W4-4b). A leaf module on purpose: server/llm.ts stamps every
// gateway call with them, and server/usage.ts (which opens the run's scope) already depends on llm.ts through
// serving.ts, so the tags cannot live in usage.ts without an import cycle. usage.ts re-exports currentUsageTags.
import { AsyncLocalStorage } from 'node:async_hooks'

type Tags = Readonly<Record<string, string>>

const tagsStore = new AsyncLocalStorage<Tags | null>()

/** run `fn` with the run's tags as the current ones (null = none) */
export function withUsageTags<T>(tags: Tags | null, fn: () => T): T {
  return tagsStore.run(tags, fn)
}

/** { ai_prism_run_kind, ai_prism_agent_id, ai_prism_agent_run_id } inside an unattended run (never an e-mail), else null */
export function currentUsageTags(): Tags | null {
  return tagsStore.getStore() ?? null
}
