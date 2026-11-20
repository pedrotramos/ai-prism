import { openUsageScope } from '../usage.ts'
import { requestIdentity } from '../requestIdentity.ts'
import { bindIdentity } from '../identityBinding.ts'

// ---- auth (on-behalf-of the signed-in Databricks user) ----
// identity rules (Apps runtime vs local dev) live in requestIdentity.js
export function auth(req, res, next) {
  const { email, token } = requestIdentity(req)
  if (!token) {
    return res.status(401).json({ error: 'Token de usuário não encontrado (OAuth do app).' })
  }
  if (!email) {
    return res.status(401).json({ error: 'Identidade do usuário não encontrada (x-forwarded-email).' })
  }
  req.email = email
  req.token = token
  // the e-mail header must belong to the forwarded token (identityBinding.js);
  // then every gateway call made while serving this request is attributed to
  // this user in the cost ledger (taxímetro) — see server/usage.js
  bindIdentity(req, res, () => openUsageScope(req, res, next))
}
