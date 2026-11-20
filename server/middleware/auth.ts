import type { Request, Response, NextFunction } from 'express'
import { openUsageScope } from '../usage.ts'
import { requestIdentity } from '../requestIdentity.ts'
import { bindIdentity } from '../identityBinding.js'

// ---- auth (on-behalf-of the signed-in Databricks user) ----
// identity rules (Apps runtime vs local dev) live in requestIdentity.js
export function auth(req: Request, res: Response, next: NextFunction): unknown {
  const { email, token } = requestIdentity(req)
  if (!token) {
    return res.status(401).json({ error: 'Token de usuário não encontrado (OAuth do app).' })
  }
  if (!email) {
    return res.status(401).json({ error: 'Identidade do usuário não encontrada (x-forwarded-email).' })
  }
  // the identity is carried on the request object (no global Express augmentation)
  const authed = req as Request & { email?: string; token?: string }
  authed.email = email
  authed.token = token
  // the e-mail header must belong to the forwarded token (identityBinding.js);
  // then every gateway call made while serving this request is attributed to
  // this user in the cost ledger (taxímetro) — see server/usage.js
  bindIdentity(req, res, () => openUsageScope(authed as Parameters<typeof openUsageScope>[0], res, next))
}
