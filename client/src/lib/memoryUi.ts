// Pure helpers behind the Memory section (W3-3). The React parts live in
// components/MemorySection.jsx; everything with a rule worth testing lives here.

/**
 * One request to /api/memory. Never throws on an HTTP error: the caller needs
 * the status AND the server's error code (api.ts helpers only keep the code in
 * the message). A network failure is status 0 / code 'network'.
 */
interface MemoryResult {
  ok: boolean
  status: number
  code: string | null
  // Server JSON body: shape depends on the endpoint, consumers narrow it.
  data: any
}

export async function memoryRequest(
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<MemoryResult> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  let r: Response
  try {
    r = await fetchImpl(path, init)
  } catch {
    return { ok: false, status: 0, code: 'network', data: null }
  }
  let data = null
  if (r.status !== 204) data = await r.json().catch(() => null)
  return { ok: !!r.ok, status: r.status, code: r.ok ? null : data?.error || `http_${r.status}`, data }
}

/** Catalog key (settings.js, `memory.err.*`) of the message that explains a failed call. */
export function memoryErrorKey({ status, code }: { status: number; code?: string | null }): string {
  if (status === 409 && code === 'memory_duplicate') return 'memory.err.duplicate'
  if (status === 409 && code === 'memory_limit') return 'memory.err.limit'
  if (status === 400) return 'memory.err.invalid'
  if (status === 404) return 'memory.err.notFound'
  if (status === 403) return 'memory.err.disabled'
  if (status === 0) return 'memory.err.network'
  return 'memory.err.generic'
}

export const isSensitiveCategory = (category: string, sensitiveCategories: string[] = []): boolean => sensitiveCategories.includes(category)

/**
 * The category <option>s of the edit form. A sensitive category is disabled
 * until the entry's own "Include sensitive topics" is on, except the one the
 * entry already has (so opening an existing sensitive entry never shows a
 * disabled selected option).
 */
export function categoryOptions(
  categories: string[],
  sensitiveCategories: string[],
  { optIn, current }: { optIn?: boolean; current?: string }
): { value: string; disabled: boolean }[] {
  return categories.map((value) => ({
    value,
    disabled: isSensitiveCategory(value, sensitiveCategories) && !optIn && value !== current,
  }))
}

/** Body for POST/PATCH. sensitiveOptIn is true only for a sensitive category with the opt-in on. */
export function buildPayload(
  { content, category, optIn }: { content: unknown; category: string; optIn?: boolean },
  sensitiveCategories: string[]
): { content: string; category: string; sensitiveOptIn: boolean } {
  return {
    content: String(content).trim(),
    category,
    sensitiveOptIn: !!optIn && isSensitiveCategory(category, sensitiveCategories),
  }
}
