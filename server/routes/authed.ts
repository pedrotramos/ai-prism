import type { Request } from 'express'

// auth() / requireAdmin() carry the caller's identity on the request object (no
// global Express augmentation, see server/middleware/auth.ts); a handler that
// runs behind them reads it through authed(req). Identity at runtime, a cast in types.
export type AuthedRequest = Request & { email: string; token: string; isAdmin?: boolean }

export function authed(req: Request): AuthedRequest {
  return req as AuthedRequest
}
