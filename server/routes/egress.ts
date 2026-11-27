// Admin allowlist of remote asset origins (md-exfil T2, decision D42).
//
//   GET /api/admin/egress/settings   { origins, envOrigins, effective, mode }   admin
//   PUT /api/admin/egress/settings   body { origins: string[] }                  admin; audited ('egress.settings'), live on this replica at once
//                                                                                and on the others within the 15 s TTL
//
//   origins    what the admin saved            envOrigins  the EXTERNAL_ASSET_ORIGINS floor (read-only here)
//   effective  env floor ∪ origins, what the CSP and /api/me carry
//   mode       'enforce' | 'report' from CSP_EGRESS: env-only, never a click (turning the protection off is a deploy decision)
//
// A PUT with any entry the policy refuses (wildcard, http, IP literal, path/query, userinfo, the app/workspace/Databricks hosts, more
// than 32) is a 400 {error:'invalid_origin', rejected:[…]} and nothing is written. Every origin added can receive whatever the model
// writes into an image URL: the admin card (T3) says so.
import type { Express, Request, RequestHandler, Response } from 'express'
import { authed } from './authed.ts'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.ts'
import { readExternalAssetOrigins, writeExternalAssetOrigins } from '../db/egressSettings.ts'
import { withTx } from '../db/pool.ts'
import { createEgressSetting, hostsFromEnv, invalidateExternalAssetOrigins, mergeOrigins, refreshExternalAssetOrigins, currentExternalAssetOrigins } from '../egressSetting.ts'
import { egressModeOf } from '../securityHeaders.ts'
import { parseAllowedOrigins } from '../../shared/urlEgressPolicy.js'
import { logger } from '../log.ts'

type Env = Record<string, string | undefined>

/** The slice of server/db/egressSettings.ts the routes use (injectable for tests). */
export interface EgressDb {
  read(email: string, token: string | null): Promise<string[]>
  write(email: string, token: string | null, origins: readonly string[], opts: { admin: boolean }): Promise<void>
}

export interface EgressRouteDeps {
  auth?: RequestHandler
  requireAdmin?: RequestHandler
  env?: Env
  db?: EgressDb
  /** the allowlist source the header reads (default: the process-wide one) */
  setting?: Pick<ReturnType<typeof createEgressSetting>, 'invalidate' | 'refresh' | 'current'>
  hosts?: (req: Request) => { appHost?: string; workspaceHost?: string }
}

const defaultDb: EgressDb = {
  read: (email, token) => withTx(email, token, (c) => readExternalAssetOrigins(c)),
  write: writeExternalAssetOrigins,
}
const defaultSetting = { invalidate: invalidateExternalAssetOrigins, refresh: refreshExternalAssetOrigins, current: currentExternalAssetOrigins }

const MAX_ENTRIES = 32
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export default function registerEgressRoutes(app: Express, deps: EgressRouteDeps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const env = deps.env || process.env
  const db = deps.db || defaultDb
  const setting = deps.setting || defaultSetting
  const hostsOf =
    deps.hosts ||
    ((req: Request) => {
      const fromEnv = hostsFromEnv(env)
      return { appHost: fromEnv.appHost || String(req.get('host') || ''), workspaceHost: fromEnv.workspaceHost }
    })

  const payload = (origins: readonly string[]) => ({
    origins: [...origins],
    envOrigins: mergeOrigins(env, []),
    effective: mergeOrigins(env, origins),
    mode: egressModeOf(env),
  })
  const fail = (res: Response, what: string, e: unknown) => {
    // codes only: a driver message can carry SQL or identifiers
    const code = (e as { code?: unknown } | null)?.code
    logger.warn(`${what} failed code=${typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'unknown'}`)
    return res.status(500).json({ error: 'internal_error', code: 'internal_error' })
  }

  app.get('/api/admin/egress/settings', auth, requireAdmin, async (req, res) => {
    try {
      const stored = await db.read(authed(req).email, authed(req).token)
      // what the CSP uses is validated on read (egressSetting); show the admin the same view of the stored list
      res.json(payload(parseAllowedOrigins(stored, hostsOf(req)).allowed.map((a) => a.origin)))
    } catch (e) {
      fail(res, 'egress settings read', e)
    }
  })

  app.put('/api/admin/egress/settings', auth, requireAdmin, async (req, res) => {
    try {
      const body = req.body
      if (!isObj(body) || Object.keys(body).length !== 1 || !Array.isArray(body.origins) || body.origins.length > MAX_ENTRIES || !body.origins.every((o) => typeof o === 'string')) {
        return res.status(400).json({ error: 'invalid_setting', code: 'invalid_setting' })
      }
      const { allowed, rejected } = parseAllowedOrigins(body.origins as string[], hostsOf(req))
      if (rejected.length) return res.status(400).json({ error: 'invalid_origin', code: 'invalid_origin', rejected })
      const origins = allowed.map((a) => a.origin)
      await db.write(authed(req).email, authed(req).token, origins, { admin: true }) // requireAdmin already checked the flag; RLS checks it again
      // live on this replica now; the others pick it up within the TTL
      setting.invalidate()
      await setting.refresh()
      res.json(payload(origins))
    } catch (e) {
      fail(res, 'egress settings write', e)
    }
  })
}
