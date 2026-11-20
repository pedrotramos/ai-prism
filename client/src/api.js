export async function getJSON(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

export async function patchJSON(url, body) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function putJSON(url, body) {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

export async function del(url) {
  const r = await fetch(url, { method: 'DELETE' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function postJSON(url, body) {
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
export async function postForm(url, formData) {
  const r = await fetch(url, { method: 'POST', body: formData })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

// Shared by every SSE-streaming endpoint: reads the response body, splits it
// into `data: {...}\n\n` frames, and calls onEvent(obj) for each one.
async function consumeSSE(res, onEvent) {
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
    let idx
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
export async function streamChat(formData, onEvent, signal) {
  const res = await fetch('/api/chat', { method: 'POST', body: formData, signal })
  await consumeSSE(res, onEvent)
}

/**
 * Generates the missing assistant reply for a session that ends on an
 * unanswered user message (server crashed / token expired mid-turn). Same SSE
 * event shape as streamChat.
 */
export async function streamContinue(sessionId, body, onEvent, signal) {
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
export async function streamRegenerate(sessionId, messageId, body, onEvent, signal) {
  const res = await fetch(`/api/sessions/${sessionId}/messages/${messageId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  await consumeSSE(res, onEvent)
}
