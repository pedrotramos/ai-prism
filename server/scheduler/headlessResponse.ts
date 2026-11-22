// The synthetic request/response of an unattended turn (W4-4b). The turn engine (server/turn.ts) was written around an
// Express res that streams Server-Sent Events: it writes `data: <json>\n\n` events and stops when `writableEnded`.
// A scheduled run has no browser, so this res turns each written event back into an object for `onEvent` and never
// reaches a socket. Nothing here reads a header or a status: the run's result comes from runTurnHeadless, not from
// the response. `req.token` of the synthetic request is the SERVICE PRINCIPAL's token, never a user's.
export interface HeadlessRes {
  writableEnded: boolean
  writableFinished: boolean
  headersSent: boolean
  statusCode: number
  setHeader(name: string, value: string): unknown
  flushHeaders(): void
  write(chunk: string): boolean
  status(code: number): HeadlessRes
  json(body?: unknown): HeadlessRes
  on(event: string, cb: () => void): HeadlessRes
  end(): HeadlessRes
}

export interface HeadlessReq {
  id: string
  email: string
  /** the app service principal's token: what the gateway and the tools are called with */
  token: string
  usageScope: unknown
  body: Record<string, never>
  params: Record<string, never>
  files: never[]
}

export function createHeadlessRequest(o: { email: string; token: string; requestId: string; usageScope: unknown }): HeadlessReq {
  return { id: o.requestId, email: o.email, token: o.token, usageScope: o.usageScope, body: {}, params: {}, files: [] }
}

/** `onEvent` gets every event the turn would have streamed ({ type, ... }); a throwing listener never breaks the turn. */
export function createHeadlessResponse(onEvent?: (e: { type: string }) => void): HeadlessRes {
  const res: HeadlessRes = {
    writableEnded: false,
    writableFinished: false,
    headersSent: true, // the stream is "open" from the start: a failure is an `error` event, never a 500
    statusCode: 200,
    setHeader: () => res,
    flushHeaders: () => {},
    write(chunk: string) {
      if (res.writableEnded || !onEvent) return true
      for (const frame of String(chunk).split('\n\n')) {
        const line = frame.trim()
        if (!line.startsWith('data:')) continue
        try {
          onEvent(JSON.parse(line.slice(5).trim()))
        } catch {
          // a listener (or a frame) that fails costs only itself
        }
      }
      return true
    },
    status(code: number) {
      res.statusCode = code
      return res
    },
    json: () => res,
    on: () => res, // no socket: nothing closes underneath the turn
    end() {
      res.writableEnded = true
      res.writableFinished = true
      return res
    },
  }
  return res
}
