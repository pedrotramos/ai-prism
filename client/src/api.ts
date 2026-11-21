/** One `data: {...}` frame of an SSE stream (the server always sets `type`). */
interface SseEvent {
  type?: string
  [key: string]: unknown
}

// Response bodies are parsed JSON whose shape the caller owns: `T` defaults to
// unknown so a typed caller must say what it expects (r.json() itself is `any`).
export async function getJSON<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

export async function patchJSON<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function putJSON<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

export async function del<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url, { method: 'DELETE' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function postJSON<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const payload = await r.json().catch(() => ({}))
    // `code` (+ `limit`) lets a caller show its own localized copy; `error` stays the fallback
    throw Object.assign(new Error(payload.error || `HTTP ${r.status}`), { status: r.status, code: payload.code, limit: payload.limit })
  }
  return r.json()
}

// multipart POST (file uploads) — the browser sets the boundary header itself,
// so we don't set Content-Type
export async function postForm<T = unknown>(url: string, formData: FormData): Promise<T> {
  const r = await fetch(url, { method: 'POST', body: formData })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

// Shared by every SSE-streaming endpoint: reads the response body, splits it
// into `data: {...}\n\n` frames, and calls onEvent(obj) for each one.
async function consumeSSE(res: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`
    try {
      msg = (await res.json()).error || msg
    } catch {}
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      try {
        onEvent(JSON.parse(data))
      } catch {}
    }
  }
}

/**
 * POST a chat turn as multipart and consume the SSE stream.
 * Calls onEvent(obj) for each {type,...} event. Returns when the stream ends.
 */
export async function streamChat(formData: FormData, onEvent: (event: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/chat', { method: 'POST', body: formData, signal })
  await consumeSSE(res, onEvent)
}

/**
 * Generates the missing assistant reply for a session that ends on an
 * unanswered user message (server crashed / token expired mid-turn). Same SSE
 * event shape as streamChat.
 */
export async function streamContinue(sessionId: string | number, body: unknown, onEvent: (event: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  await consumeSSE(res, onEvent)
}

/**
 * Regenerates one assistant message in place — same SSE event shape as
 * streamChat, plus a final `variant` event with the newly created message id.
 */
export async function streamRegenerate(
  sessionId: string | number,
  messageId: string | number,
  body: unknown,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages/${messageId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  await consumeSSE(res, onEvent)
}
