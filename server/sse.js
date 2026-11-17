// Server-Sent Events for the turn routes (chat, continue, regenerate): one
// place for the response headers and the event writer, so the three routes
// stream identically.

// Switches the response to an SSE stream. Buffering is disabled end to end
// (no-transform for compressing proxies, X-Accel-Buffering for nginx-style
// ones) so each token reaches the browser as it is produced.
export function openSse(res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

// Returns send(obj): writes one `data:` event, and is a no-op once the
// response has ended (client gone, or the route already closed the stream).
export function makeSend(res) {
  return (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
}
