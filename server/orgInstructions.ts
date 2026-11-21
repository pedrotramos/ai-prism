// Org instructions (W2-5): the text an admin sets in app_settings.org_instructions
// reaches every turn as ONE system message, through the turn context-provider
// registry (registerTurnContextProvider, server/turn.js) — never by editing
// the prompt at each call site. The registry runs providers on all three turn
// routes (chat / continue / regenerate), after the skills message and before
// the history replay. Empty text = no message.
//
// The settings read is cached per process for ORG_INSTRUCTIONS_TTL_MS; a save
// on this instance invalidates it at once, other instances pick it up within
// the TTL. A failed read costs only this message, never the turn.
import { registerTurnContextProvider } from './turn.js'
import { getAppSettings } from './db/admin.ts'
import { logger } from './log.ts'

export const ORG_INSTRUCTIONS_TTL_MS = 60 * 1000

/** The system message for `text`, or null when there is nothing to say. */
export function orgInstructionsMessage(text?: unknown): string | null {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return null
  return (
    "Organization instructions, set by this workspace's administrators for every conversation. " +
    'Follow them unless they conflict with the law or with safety:\n' +
    `<org_instructions>\n${t}\n</org_instructions>`
  )
}

// every provider's cache, so a save drops them all
const caches = new Set<() => void>()

/** A context provider with its own TTL cache (load/now injectable for tests). */
// the request fields the settings read needs (an Express request in the app)
interface OrgReq {
  email: string
  token?: string | null
}
interface OrgProviderOptions {
  load?: (req: OrgReq) => Promise<{ orgInstructions?: string } | null | undefined>
  now?: () => number
  ttlMs?: number
}

export function createOrgInstructionsProvider({ load = (req) => getAppSettings(req.email, req.token), now = Date.now, ttlMs = ORG_INSTRUCTIONS_TTL_MS }: OrgProviderOptions = {}) {
  let cache: { at: number; text: string } | null = null
  const provider = async ({ req }: { req: OrgReq }): Promise<string[]> => {
    try {
      if (!cache || now() - cache.at >= ttlMs) {
        const s = await load(req)
        cache = { at: now(), text: s?.orgInstructions || '' }
      }
    } catch (e) {
      logger.warn('org instructions: settings read failed', { err: e })
      return []
    }
    const msg = orgInstructionsMessage(cache.text)
    return msg ? [msg] : []
  }
  const invalidate = () => {
    cache = null
  }
  caches.add(invalidate)
  return Object.assign(provider, { invalidate })
}

let installed: ReturnType<typeof createOrgInstructionsProvider> | null = null

/** Registers the provider once per process. Returns the provider. */
export function installOrgInstructions({ register = registerTurnContextProvider, force = false }: { register?: (provider: ReturnType<typeof createOrgInstructionsProvider>) => unknown; force?: boolean } = {}) {
  if (installed && !force) return installed
  const provider = createOrgInstructionsProvider()
  register(provider)
  installed = provider
  return provider
}

/** Drops this instance's cache (called after a settings save). */
export function invalidateOrgInstructions() {
  for (const drop of caches) drop()
}
