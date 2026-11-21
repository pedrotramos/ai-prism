// What the Welcome screen offers. Pure functions so the rules are unit-tested
// (suggestions.test.js) and Welcome.jsx only renders them.
//
// Rules, and the practical reason for each:
// - 4 to 6 starters (Hick's law): enough to show the range — slides,
//   spreadsheets, documents, governed data, images — without a menu to read.
// - Only what this installation can do: the data starter needs a data tool the
//   admin allows and the user has on; the image starter needs an image model and
//   the image tool. A starter that leads to "tool not available" is a dead end.
// - Exactly one primary (Von Restorff): the most valuable first step is visibly
//   different, the rest are equal alternatives. With a data tool, that is asking
//   the company's data a question; otherwise a slide deck.

export const SUGGESTION_IDS = ['data', 'deck', 'sheet', 'doc', 'image', 'write']

// Tool kinds that answer questions about the company's data (see ToolsPicker).
export const DATA_TOOL_KINDS = ['genie-one', 'genie', 'uc', 'vector-search']

const allowed = (policy: Record<string, boolean> | undefined, kind: string): boolean => policy?.[kind] !== false

/**
 */
export function welcomeCapabilities({
  enabledTools,
  toolPolicy,
  imageModels,
}: {
  enabledTools?: { kind: string }[]
  toolPolicy?: Record<string, boolean>
  imageModels?: unknown[]
} = {}): { data: boolean; image: boolean } {
  const on = (enabledTools || []).filter((tool) => tool && allowed(toolPolicy, tool.kind))
  return {
    data: on.some((tool) => DATA_TOOL_KINDS.includes(tool.kind)),
    image: on.some((tool) => tool.kind === 'image-gen') && Array.isArray(imageModels) && imageModels.length > 0,
  }
}

/**
 * Ordered starters for the given capabilities; the primary one comes first.
 */
export function buildSuggestions({ data = false, image = false }: { data?: boolean; image?: boolean } = {}): { id: string; primary: boolean }[] {
  const list = [data && 'data', 'deck', 'sheet', 'doc', image && 'image', 'write'].filter(Boolean) as string[]
  return list.map((id, i) => ({ id, primary: i === 0 }))
}

/** 'morning' (05–11), 'afternoon' (12–17) or 'evening', in the user's local time. */
export function greetingKey(date = new Date()) {
  const h = date.getHours()
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  return 'evening'
}

// first.last, first_last or first-middle.last: the first token is a name only
// when the local part is split by '.' or '_' and the token is letters only.
// Service, test and single-token accounts (svc-1234, e2e-user, pedro) get the
// greeting without a name rather than a wrong one.
const NAME_TOKEN = /^\p{L}{2,}$/u

/** Capitalised first name from a corporate e-mail, or null when unsure. */
export function firstNameFromEmail(email: unknown): string | null {
  const local = String(email || '').split('@')[0]!
  if (!/[._]/.test(local)) return null
  const first = local.split(/[._-]/)[0]!
  if (!NAME_TOKEN.test(first)) return null
  const lower = first.toLocaleLowerCase()
  return lower[0]!.toLocaleUpperCase() + lower.slice(1)
}
