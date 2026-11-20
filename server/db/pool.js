// Connection identity, pooling and the SP grants for Lakebase, moved out of
// server/db.js unchanged so the schema runner (server/db/migrate.js) and the
// feature query modules (server/db/<feature>.js) share one entry point:
// withTx (every query) / withSchemaClient (the migration runner). server/db.js
// re-exports the public names from here.
import fs from 'node:fs'
import pg from 'pg'
import { logger, consoleLogger } from '../log.ts'

const { Client, Pool } = pg

// ---- connection identity ----------------------------------------------------
// Preferred: the APP's service principal (Databricks Apps inject
// DATABRICKS_CLIENT_ID/SECRET). One PG role serves every signed-in user — this
// is what makes the app truly multi-user (workspace users don't get Lakebase PG
// roles of their own) and what lets admins publish global templates every user
// can read. Per-user isolation is enforced BY THE DATABASE (W2-1, migration
// 0003): FORCE ROW LEVEL SECURITY on every app table, and withTx below sets the
// caller's identity (app.user_email) and the admin flag (app.is_admin) for each
// transaction. The SP owns no table and has no BYPASSRLS. The user_email WHERE
// clauses stay in the queries as defence in depth. Requires the SP's Postgres role to exist:
// the deploy job (bundle/auto_config.py) creates it on the Lakebase "Autoscaling"
// product via the databricks_auth extension —
//   SELECT databricks_create_role('<DATABRICKS_CLIENT_ID>', 'SERVICE_PRINCIPAL')
// — and `node scripts/migrate.mjs grants` (server/db/grants.js), run by the
// deploying identity, gives it least-privilege DML on the ai_prism schema.
// Fallback: the caller's own identity + OBO token as password, ONLY when the SP
// cannot log in or reach the database. A failed SP login only disables the SP
// path temporarily (never a permanent latch). A "permission denied" (42501) on
// the SP is NOT a login problem: it keeps the SP identity (see spErrorAction).
const SP_RETRY_MS = 5 * 60 * 1000
let spToken = { value: null, exp: 0 }

function oidcHost() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

async function spAccessToken() {
  if (spToken.value && Date.now() < spToken.exp - 120_000) return spToken.value
  const res = await fetch(`${oidcHost()}/oidc/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'all-apis',
      client_id: process.env.DATABRICKS_CLIENT_ID,
      client_secret: process.env.DATABRICKS_CLIENT_SECRET,
    }),
  })
  if (!res.ok) throw new Error(`sp token: HTTP ${res.status}`)
  const d = await res.json()
  spToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 }
  return spToken.value
}

// ---- Lakebase host resolution (cloud-agnostic, no hardcoded PGHOST) ----------
// The app learns its Lakebase host from the `lakebase` app resource: the runtime
// injects the endpoint PATH as PG_ENDPOINT (value_from: lakebase in app.yaml /
// databricks.yml). We resolve that path -> host once via the REST API using the
// SP token, and cache it for the process. Local dev can still set PGHOST directly.
//
// Why not just an env host? A nested bundle ref (${...status.hosts.host}) does NOT
// resolve into app config, and a hardcoded host silently points the app at the
// wrong cloud's Lakebase (login fails with SQLSTATE 28000). The endpoint path,
// injected by the platform, is the reliable per-workspace handle.
let resolvedPgHost = null
async function lakebaseHost() {
  // explicit override wins: PGHOST is set directly for local dev, and is ALSO
  // auto-injected by the `lakebase` app resource — so in production this returns
  // immediately without an API call. The PG_ENDPOINT path below is the fallback.
  if (process.env.PGHOST) return process.env.PGHOST
  if (resolvedPgHost) return resolvedPgHost
  // endpoint path from the injected app resource, or derived from defaults the
  // bundle creates (project = app name; default branch "production"; endpoint
  // "primary" — see databricks.yml postgres_projects/postgres_endpoints).
  let endpointPath = process.env.PG_ENDPOINT
  if (!endpointPath) {
    const proj = process.env.DATABRICKS_APP_NAME || 'ai-prism'
    endpointPath = `projects/${proj}/branches/production/endpoints/primary`
  }
  const token = await spAccessToken()
  const res = await fetch(`${oidcHost()}/api/2.0/postgres/${endpointPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`lakebase endpoint lookup ${endpointPath}: HTTP ${res.status}`)
  const d = await res.json()
  const host = d?.status?.hosts?.host
  if (!host) throw new Error(`lakebase endpoint ${endpointPath}: no status.hosts.host`)
  resolvedPgHost = host
  return host
}

// The APP's own OAuth token (service principal, all-apis scope). Used for
// app-owned storage that must not depend on a per-user OAuth scope/consent —
// notably the generated-image UC Volume (see imageStore.js). Returns null when
// the app isn't running with SP credentials (local dev without them), so the
// caller can fall back to the user's OBO token. Per-user ISOLATION is NOT the
// storage identity's job here: the image rows that point at the files are
// owner-scoped by row-level security (see the module header).
export async function appServiceToken() {
  if (!process.env.DATABRICKS_CLIENT_ID || !process.env.DATABRICKS_CLIENT_SECRET) return null
  try {
    return await spAccessToken()
  } catch {
    return null
  }
}

// TLS to Postgres (SECURITY.md, "TLS para o Postgres"). Default: encrypted but
// NOT verified (rejectUnauthorized false), the historical behavior. Turning
// verification on for everyone needs the Lakebase chain confirmed against the
// runtime's Node trust store (G-live), so it stays opt-in:
//   PG_SSL_VERIFY=1              verifies the chain (Node's trust store, or PG_SSL_CA)
//   PG_SSL_CA                    PEM of the CA (inline, or a path to the file);
//                                pinning a CA turns verification on by default
//   PG_SSL_REJECT_UNAUTHORIZED   legacy alias of PG_SSL_VERIFY
// An explicit off ('0') in either switch wins over everything (diagnostics).
const ON = ['1', 'true', 'yes', 'on']
const OFF = ['0', 'false', 'no', 'off']
export function pgSslOptions(env = process.env) {
  const sslMode = String(env.PGSSLMODE || 'require').toLowerCase()
  if (['disable', 'disabled', 'false', '0'].includes(sslMode)) return false
  const value = String(env.PG_SSL_CA || '')
  const trimmed = value.trim()
  const ca = !trimmed ? null : trimmed.startsWith('-----BEGIN') ? value : fs.readFileSync(trimmed, 'utf8')
  const knobs = [env.PG_SSL_VERIFY, env.PG_SSL_REJECT_UNAUTHORIZED].map((k) => String(k ?? '').trim().toLowerCase()).filter(Boolean)
  const rejectUnauthorized = knobs.some((k) => OFF.includes(k)) ? false : knobs.some((k) => ON.includes(k)) || Boolean(ca)
  return ca ? { ca, rejectUnauthorized } : { rejectUnauthorized }
}

// ---- schema ------------------------------------------------------------------
// The app's tables live in the dedicated `ai_prism` schema (migration 0002);
// pgvector stays in `public`, so the path is `ai_prism, public`. Set ONCE per
// physical connection (pool 'connect' hook / one-shot client), never per query,
// and as a plain SET rather than the `options` startup parameter, which some
// Postgres poolers reject. Before 0002 runs the `ai_prism` schema does not exist
// and the same path resolves to `public`.
export const APP_SCHEMA = 'ai_prism'
export const APP_SEARCH_PATH = 'ai_prism, public'
const SET_SEARCH_PATH = `SET search_path TO ${APP_SEARCH_PATH}`

export async function setAppSearchPath(client) {
  await client.query(SET_SEARCH_PATH)
}

function withAppSearchPath(pool, label) {
  // node-postgres queues queries per client, so this SET runs before the first
  // query of whoever acquired the new connection
  pool.on('connect', (client) => {
    client.query(SET_SEARCH_PATH).catch((e) => logger.warn(`${label}: could not set search_path`, { err: e }))
  })
  return pool
}

async function connInfo(user, password) {
  return {
    host: await lakebaseHost(),
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'databricks_postgres',
    user,
    password,
    ssl: pgSslOptions(),
    // keep the handshake snappy; fail loud if Lakebase is unreachable
    connectionTimeoutMillis: 15000,
    // 60s: the Settings template list ships whole mined asset libraries (MBs
    // of jsonb) — comfortably fast in-region, but a remote dev laptop pays
    // the cross-region transfer inside the query and 30s wasn't enough
    query_timeout: 60000,
  }
}

// ---- connection pooling ------------------------------------------------------
// The Lakebase handshake (TLS + auth) costs ~2s in-region, and a single chat
// turn runs ~10 DB operations. Opening a fresh Client per op (the original
// design) serialized ~20s of pure handshake onto every turn. Pooling reuses
// warm sockets: only the FIRST op of a cold pool pays the handshake.
//
// Token rotation (the reason pooling was originally avoided) is handled two
// ways: (1) `password` is passed as an async FUNCTION — node-postgres calls it
// for each NEW physical connection, so a fresh SP token is fetched at connect
// time; and (2) an already-open socket doesn't re-authenticate (Postgres only
// checks credentials at connect), so a mid-flight token expiry can't break a
// live connection. Idle connections are reaped after `idleTimeoutMillis`, and
// `maxLifetime` caps how long any socket lives so we never sit on an ancient
// one. A per-connection error (e.g. server-side termination) just removes it
// from the pool; the next acquire opens a fresh one.
//
// Scale to zero: the pool drains to zero sockets (`min: 0`) PG_POOL_IDLE_TIMEOUT_MS
// after the last query (default 2 min, was 5 min), well inside the Lakebase
// suspend timeout (databricks.yml lakebase_suspend_timeout, 600 s). An idle
// app therefore stops holding the endpoint up. The cost is one ~2 s handshake
// for the first query after a quiet spell — keepAlive below is what keeps a
// tab in use from paying it. Token rotation is unaffected: connections still
// authenticate through the async `password` function above.
export const PG_POOL_IDLE_TIMEOUT_DEFAULT_MS = 2 * 60 * 1000
/** PG_POOL_IDLE_TIMEOUT_MS: 1 s..30 min; the default when unset or invalid. */
export function pgPoolIdleTimeoutMs(value = process.env.PG_POOL_IDLE_TIMEOUT_MS) {
  const ms = Number(value ?? PG_POOL_IDLE_TIMEOUT_DEFAULT_MS)
  return Number.isSafeInteger(ms) && ms >= 1000 ? Math.min(ms, 30 * 60 * 1000) : PG_POOL_IDLE_TIMEOUT_DEFAULT_MS
}

const POOL_OPTS = {
  max: 8,
  min: 0,
  idleTimeoutMillis: pgPoolIdleTimeoutMs(),
  maxLifetimeSeconds: 30 * 60,
  allowExitOnIdle: true,
}

// SP pool: one shared identity for the whole app, so a single pool serves every
// user. `password` is a function → each new connection gets a fresh SP token.
let spPool = null
async function getSpPool() {
  if (!spPool) {
    spPool = withAppSearchPath(
      new Pool({
        ...(await connInfo(process.env.DATABRICKS_CLIENT_ID, () => spAccessToken())),
        ...POOL_OPTS,
      }),
      'lakebase SP pool'
    )
    // a broken idle socket must never crash the process — pg emits 'error' on
    // the pool for backend-terminated idle clients; drop it and move on.
    spPool.on('error', (e) => logger.warn('lakebase SP pool: idle client error (dropped)', { err: e }))
  }
  return spPool
}

// Per-user pools, keyed by email — ONLY when the password is stable across the
// process (PGPASSWORD, i.e. local dev with a generated DB credential). With a
// rotating OBO token as password we can't safely pool (a reaped+reopened
// connection would use a stale token), so that path stays one-shot below.
const userPools = new Map()
async function getUserPool(userEmail, password) {
  let p = userPools.get(userEmail)
  if (!p) {
    // A normal local Postgres role is stable and deliberately independent of
    // the app-level test email. Lakebase keeps the historical email-as-role
    // behavior when PGUSER is absent.
    p = withAppSearchPath(
      new Pool({ ...(await connInfo(process.env.PGUSER || userEmail, password)), ...POOL_OPTS }),
      `lakebase user pool (${userEmail})`
    )
    p.on('error', (e) => logger.warn('lakebase user pool: idle client error (dropped)', { err: e, email: userEmail }))
    userPools.set(userEmail, p)
  }
  return p
}

// Runs fn(client) with a pooled connection, releasing it back afterward.
async function withPool(pool, fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

// What a failure on the SP connection means for the request:
//   'demote' the SP cannot log in / reach the database → the caller's identity
//   'policy' a row-level security policy refused a write (42501, "row-level
//            security"): the database did its job → surface the error, keep the
//            identity, no grants run (it is not a privilege problem)
//   'grants' 42501, the SP is in but lacks a privilege: its grants are missing
//            or stale → keep the identity, ask for a grants run, surface the error
//   'throw'  a real query error
const SP_DEMOTE_RE = /password authentication|role .* does not exist|sp token|external authorization|ECONNREFUSED|ETIMEDOUT/i
const RLS_RE = /row-level security/i
export function spErrorAction(e) {
  const message = e?.message || ''
  if (RLS_RE.test(message)) return 'policy'
  if (e?.code === '42501' || /permission denied/i.test(message)) return 'grants'
  return SP_DEMOTE_RE.test(message) ? 'demote' : 'throw'
}

/**
 * At most one run of `run` per interval, started in the background: the caller
 * never awaits it, and a failure only warns. Returns whether a run started.
 */
export function createGrantsRetry({ run, intervalMs = SP_RETRY_MS, now = Date.now, log = consoleLogger }) {
  let last = -Infinity
  let running = false
  return function request(reason) {
    const t = now()
    if (running || t - last < intervalMs) return false
    last = t
    running = true
    Promise.resolve()
      .then(() => run(reason))
      .catch((e) => log.warn('lakebase: app grants run failed:', e.message))
      .finally(() => {
        running = false
      })
    return true
  }
}

// per-user fallback: the OBO token is the Postgres password. Local dev:
// workspace CLI tokens are NOT accepted by Lakebase, so a dedicated
// credential (databricks database generate-database-credential) can be
// supplied via PGPASSWORD without affecting API bearer usage.
async function userPath(userEmail, userToken, fn) {
  const stablePassword = process.env.PGPASSWORD
  if (stablePassword) {
    // stable password across the process → safe to pool by user
    return await withPool(await getUserPool(userEmail, stablePassword), fn)
  }
  // rotating OBO token as password: can't pool safely, so keep the original
  // fresh-client-per-op behavior (always uses a currently-valid token).
  const client = new Client(await connInfo(userEmail, userToken))
  await client.connect()
  try {
    await setAppSearchPath(client)
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * withClient, built from its dependencies so the fallback rules can be tested
 * without a database (server/spFallback.test.js).
 */
export function createWithClient({ env = process.env, now = Date.now, log = consoleLogger, getSpPool: spPoolFn, userPath: userFn, requestGrants }) {
  let spDisabledUntil = 0
  return async function withClient(userEmail, userToken, fn) {
    if (env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET && now() >= spDisabledUntil) {
      try {
        return await withPool(await spPoolFn(), fn)
      } catch (e) {
        const action = spErrorAction(e)
        if (action === 'throw' || action === 'policy') throw e
        if (action === 'grants') {
          const started = requestGrants('42501')
          log.warn(
            `lakebase: permission denied for the service principal (${e.message}); identity unchanged, ` +
              (started ? 'app grants run requested' : 'app grants run already requested') +
              ' — if it persists, run `node scripts/migrate.mjs grants` as the table owner (docs/operations.md §6.4)'
          )
          throw e
        }
        spDisabledUntil = now() + SP_RETRY_MS
        log.warn('lakebase: service-principal login unavailable, using per-user identity:', e.message)
      }
    }
    return userFn(userEmail, userToken, fn)
  }
}

// App grants from inside the app: only meaningful when the app connects as an
// identity that is NOT the app role (e.g. local dev with the owner's database
// credential and DATABRICKS_CLIENT_ID naming the SP). On a deployed app the
// connection IS the SP, which cannot grant to itself: a no-op by design, the
// real run is `migrate.mjs grants` by the deploying identity.
export async function runAppGrantsFromApp(userEmail, userToken, { env = process.env, log = consoleLogger } = {}) {
  const role = env.DATABRICKS_CLIENT_ID
  if (!role) return { skipped: 'no app role (DATABRICKS_CLIENT_ID unset)' }
  if (env.DATABRICKS_CLIENT_SECRET) return { skipped: 'the app connects as the app role itself' }
  const { applyAppGrants } = await import('./grants.js')
  const r = await userPath(userEmail, userToken, (c) => applyAppGrants(c, { role, env }))
  log.log('lakebase: app grants applied for', role)
  return r
}

// the owner identity of the boot/42501 grants run, remembered from the first request
let grantsCaller = null
export function rememberGrantsCaller(userEmail, userToken) {
  if (!grantsCaller) grantsCaller = { userEmail, userToken }
}
const requestAppGrants = createGrantsRetry({
  run: async () => {
    if (!grantsCaller) return
    const r = await runAppGrantsFromApp(grantsCaller.userEmail, grantsCaller.userToken)
    if (r?.skipped) logger.warn(`lakebase: app grants run skipped (${r.skipped}); run \`node scripts/migrate.mjs grants\` as the table owner`)
  },
})

// Not for queries: every app query path goes through withTx (identity + admin
// flag per transaction). The only other caller is withSchemaClient, below, for
// the migration runner (DDL only after 0003, see server/db/migrate.js).
export const withClient = createWithClient({ getSpPool, userPath, requestGrants: requestAppGrants })

/**
 * A connection for the schema runner (server/db/migrate.js), which opens and
 * commits its own transactions per migration and so cannot run inside withTx.
 * Same identity and pooling rules as withTx; no identity is set (migrations do
 * not read user rows; a data migration that must, runs as the owner).
 */
export function withSchemaClient(userEmail, userToken, fn) {
  return withClient(userEmail, userToken, fn)
}

// ---- identity per transaction (row-level security, migration 0003) -----------
// The two settings the policies read, as set_config(..., true) parameters: the
// SET LOCAL of the design, but parameterised (SET cannot take bind parameters).
// The admin flag is 'on' ONLY for a real boolean true handed over by server
// code that checked authz.isAdmin (or requireAdmin): a string from a header or
// a body ('true', 'on', 1) is 'off'. No email = '' = no row matches: the
// policies read the setting through NULLIF(..., ''), so even a row whose owner
// column is '' is not "owned" by a transaction without an identity.
export function txIdentity(userEmail, { admin = false } = {}) {
  return [typeof userEmail === 'string' ? userEmail : '', admin === true ? 'on' : 'off']
}

const SET_IDENTITY = `SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true), set_config('app.user_groups', $3, true)`

// The caller's workspace (SCIM) groups, for project membership through a group
// (migration 0005, ai_prism.aip_project_rank reads app.user_groups). Resolved per
// transaction by a resolver registered by server/db/projects.js (server/access.js:
// cached, and FAIL CLOSED: any SCIM error is no groups). No resolver, no e-mail,
// or a resolver that throws or answers anything but strings → '[]', so a group
// never grants what could not be proven.
let txGroupsResolver = null
/** Registers the groups resolver; returns the previous one (tests swap it). */
export function setTxGroupsResolver(fn) {
  const previous = txGroupsResolver
  txGroupsResolver = typeof fn === 'function' ? fn : null
  return previous
}

/** The app.user_groups value: a JSON array of non-empty strings, '[]' on anything else. */
export function txGroupsSetting(groups) {
  if (!Array.isArray(groups)) return '[]'
  return JSON.stringify(groups.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim().toLowerCase()))
}

async function resolveTxGroups(userEmail, userToken, opts) {
  if (Array.isArray(opts.groups)) return txGroupsSetting(opts.groups)
  if (!txGroupsResolver || typeof userEmail !== 'string' || !userEmail) return '[]'
  try {
    return txGroupsSetting(await txGroupsResolver(userEmail, userToken))
  } catch {
    return '[]'
  }
}

/**
 * BEGIN, the caller's identity (transaction-local), fn(client), COMMIT; ROLLBACK
 * when fn throws (the error is rethrown). The settings end with the
 * transaction, so nothing is left on a pooled connection. fn must not COMMIT or
 * ROLLBACK itself: that would end the identity with it.
 */
export async function runInIdentityTx(c, userEmail, opts, fn, groupsSetting = txGroupsSetting(opts?.groups)) {
  await c.query('BEGIN')
  try {
    await c.query(SET_IDENTITY, [...txIdentity(userEmail, opts), groupsSetting])
    const result = await fn(c)
    await c.query('COMMIT')
    return result
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
}

// Runs fn(client) inside one transaction on the same connection, as the caller:
// app.user_email = userEmail, app.is_admin per `opts.admin` (see txIdentity) and
// app.user_groups (opts.groups, else the registered resolver; see above).
// COMMIT when fn resolves, ROLLBACK when it throws (the error is rethrown). Same
// identity and pooling rules as withClient. EVERY query path goes through here
// (a lint test in server/rls.test.js keeps withClient( inside this file).
// fn can run TWICE: an SP login/connection failure (spErrorAction → 'demote')
// rolls back and re-runs fn under the caller's database identity. A "permission
// denied" or an RLS refusal does not. The database side is clean (ROLLBACK), so
// keep non-database side effects (gateway calls, file writes) out of fn.
export async function withTx(userEmail, userToken, fn, opts = {}) {
  // resolved before a connection is taken: a slow SCIM call never holds a pooled socket
  const groups = await resolveTxGroups(userEmail, userToken, opts)
  return withClient(userEmail, userToken, (c) => runInIdentityTx(c, userEmail, opts, fn, groups))
}
