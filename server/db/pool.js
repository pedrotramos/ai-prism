// Connection identity and pooling for Lakebase (moved out of server/db.js so
// the schema runner (server/db/migrate.js) and feature query modules
// (server/db/<feature>.js) share one entry point: withClient / withTx).
// server/db.js re-exports everything public from here under the same names.
import fs from 'node:fs'
import pg from 'pg'

const { Client, Pool } = pg

// ---- connection identity ----------------------------------------------------
// Preferred: the APP's service principal (Databricks Apps inject
// DATABRICKS_CLIENT_ID/SECRET). One PG role serves every signed-in user and
// per-user isolation is enforced app-level by the user_email WHERE clauses —
// this is what makes the app truly multi-user (workspace users don't get
// Lakebase PG roles of their own) and what lets admins publish global
// templates every user can read. Requires the SP's Postgres role to exist:
// the deploy job (bundle/auto_config.py) creates it on the Lakebase "Autoscaling"
// product via the databricks_auth extension —
//   SELECT databricks_create_role('<DATABRICKS_CLIENT_ID>', 'SERVICE_PRINCIPAL')
// — and ensureSpGrants (server/db.js) applies the table GRANTs at runtime.
// Fallback: the caller's own identity + OBO token as password (works for the
// table owner even without the SP role). A failed SP login only disables the SP
// path temporarily (never a permanent latch).
const SP_RETRY_MS = 5 * 60 * 1000
let spToken = { value: null, exp: 0 }
let spDisabledUntil = 0

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
// storage identity's job here: it's enforced app-level by the user_email WHERE
// clauses (same trust model as every other artifact — see the module header).
export async function appServiceToken() {
  if (!process.env.DATABRICKS_CLIENT_ID || !process.env.DATABRICKS_CLIENT_SECRET) return null
  try {
    return await spAccessToken()
  } catch {
    return null
  }
}

// TLS to Postgres (SECURITY.md, "TLS para o Postgres"). Default: encrypted but
// NOT verified (rejectUnauthorized false), the historical behavior. Two opt-in
// knobs pin the trust anchor:
//   PG_SSL_CA                    PEM of the CA (inline, or a path to the file)
//   PG_SSL_REJECT_UNAUTHORIZED   '1' verifies the chain, '0' does not
// With PG_SSL_CA set and no explicit knob the chain is verified: a pinned CA
// that is not verified would be decorative.
export function pgSslOptions(env = process.env) {
  const sslMode = String(env.PGSSLMODE || 'require').toLowerCase()
  if (['disable', 'disabled', 'false', '0'].includes(sslMode)) return false
  const value = String(env.PG_SSL_CA || '')
  const trimmed = value.trim()
  const ca = !trimmed ? null : trimmed.startsWith('-----BEGIN') ? value : fs.readFileSync(trimmed, 'utf8')
  const knob = String(env.PG_SSL_REJECT_UNAUTHORIZED ?? '').trim().toLowerCase()
  const rejectUnauthorized = knob ? ['1', 'true', 'yes'].includes(knob) : Boolean(ca)
  return ca ? { ca, rejectUnauthorized } : { rejectUnauthorized }
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
    spPool = new Pool({
      ...(await connInfo(process.env.DATABRICKS_CLIENT_ID, () => spAccessToken())),
      ...POOL_OPTS,
    })
    // a broken idle socket must never crash the process — pg emits 'error' on
    // the pool for backend-terminated idle clients; drop it and move on.
    spPool.on('error', (e) => console.warn('lakebase SP pool: idle client error (dropped):', e.message))
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
    p = new Pool({ ...(await connInfo(process.env.PGUSER || userEmail, password)), ...POOL_OPTS })
    p.on('error', (e) => console.warn(`lakebase user pool (${userEmail}): idle client error (dropped):`, e.message))
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

export async function withClient(userEmail, userToken, fn) {
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET && Date.now() >= spDisabledUntil) {
    try {
      return await withPool(await getSpPool(), fn)
    } catch (e) {
      // only auth/connection/authorization failures demote to the per-user
      // path; real query errors (thrown inside fn) must surface, not be
      // silently retried. "permission denied" means the SP role exists but
      // its GRANTs haven't been applied yet (see ensureSpGrants) — degrading
      // to the caller's own identity keeps the table owner working meanwhile.
      // "external authorization failed" (SQLSTATE 28000) is Lakebase rejecting
      // the login — also an auth failure, so demote rather than 500 the app.
      if (!/password authentication|role .* does not exist|sp token|permission denied|external authorization|ECONNREFUSED|ETIMEDOUT/i.test(e.message || '')) throw e
      spDisabledUntil = Date.now() + SP_RETRY_MS
      console.warn('lakebase: service-principal login unavailable, using per-user identity:', e.message)
    }
  }
  // per-user fallback: the OBO token is the Postgres password. Local dev:
  // workspace CLI tokens are NOT accepted by Lakebase, so a dedicated
  // credential (databricks database generate-database-credential) can be
  // supplied via PGPASSWORD without affecting API bearer usage.
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
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

// Keep-alive for scale to zero: a visible tab pings GET /api/keepalive every few
// minutes, and this runs one `SELECT 1` so the endpoint doesn't suspend under a
// user who is still looking at the app. Throttled per process: at most one query
// per DB_KEEPALIVE_MIN_INTERVAL_MS however many tabs ping. Returns whether a
// query ran. Uses the same pool/identity as every other query (token rotation

// Runs fn(client) inside one transaction on the same connection: COMMIT when
// fn resolves, ROLLBACK when it throws (the error is rethrown). Same identity
// and pooling rules as withClient. This is the entry point feature query
// modules use for multi-statement writes; it is also where per-transaction
// session settings (SET LOCAL) will live.
export async function withTx(userEmail, userToken, fn) {
  return withClient(userEmail, userToken, async (c) => {
    await c.query('BEGIN')
    try {
      const result = await fn(c)
      await c.query('COMMIT')
      return result
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}

// ensureSpGrants (server/db.js) calls this once the SP's GRANTs are in place:
// the SP path comes back right away instead of after SP_RETRY_MS.
export function reenableSpPath() {
  spDisabledUntil = 0
}

// For the few owner-identity paths that must bypass the pools (GRANTs).
export { Client, connInfo }
