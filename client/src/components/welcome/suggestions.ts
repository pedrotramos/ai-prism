// What the Welcome screen offers. Pure functions so the rules are unit-tested
// (suggestions.test.ts) and Welcome.tsx only renders them.
//
// Three start cards (the identity decision for 2.0): one for each way people
// begin: ask the company's data, create an artifact, search documents. Each
// prefills the composer; the user finishes the sentence and sends.

export const SUGGESTION_IDS = ['data', 'artifact', 'docs'] as const
export type SuggestionId = (typeof SUGGESTION_IDS)[number]

/** The start cards, in display order. */
export function buildSuggestions(): { id: SuggestionId }[] {
  return SUGGESTION_IDS.map((id) => ({ id }))
}

/** Compact "time ago" bucket for a recent chat: today, yesterday or a date. */
export function recencyBucket(updatedAt: string | number | Date, now = new Date()): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(updatedAt)
  if (Number.isNaN(d.getTime())) return 'earlier'
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return 'earlier'
}

/** At most `max` recent chats, newest first, skipping untitled/invalid rows. */
export function pickRecents<T extends { title: string; updatedAt: string }>(rows: T[] | undefined, max = 3): T[] {
  return (rows || [])
    .filter((r) => r && String(r.title || '').trim() && !Number.isNaN(new Date(r.updatedAt).getTime()))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, max)
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
