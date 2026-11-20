// Structured logger: every server log line is ONE JSON object with exactly
//   { ts, level, request_id, user_hash, route, status, duration_ms, msg }
// (null when unknown). Lines from inside a request pick up its id, route and
// user from the request context opened by middleware/requestId.js, so a deep
// warning can be joined to the request that caused it.
//
// Redaction is structural, not a convention:
// - only those eight keys are ever written; any other field passed in (prompt,
//   sql, token, body...) is dropped;
// - `msg` (and an `err` field folded into it) goes through redact(): e-mails,
//   bearer/PAT/JWT tokens, token query params and SQL statements are replaced;
// - an `email` field becomes `user_hash`, never a raw address.
// A log call never throws into the caller (a closed stdout or a circular value
// must not turn a warning into a 500).
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

// the fields a log call may pass; any other key is dropped by log() (see the header)
interface LogFields {
  err?: unknown
  request_id?: unknown
  user_hash?: unknown
  email?: unknown
  route?: unknown
  status?: unknown
  duration_ms?: unknown
  [other: string]: unknown
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const MAX_MSG = 1000

// the request context middleware/requestId.js opens; `req` is the Express request (only a few fields are read)
interface RequestContext {
  requestId?: string
  req?: LogRequest
}
interface LogRequest {
  route?: { path?: string }
  baseUrl?: string
  originalUrl?: string
  url?: string
  path?: string
  method?: string
  email?: string
}
const context = new AsyncLocalStorage<RequestContext>()

/** Runs fn inside a request context ({ requestId, req }). */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return context.run(ctx, fn)
}
export function currentRequestContext() {
  return context.getStore() || null
}

/** First 12 hex chars of sha256(lowercased e-mail); null without one. */
export function userHash(email?: unknown): string | null {
  if (!email || typeof email !== 'string') return null
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const PAT = /\bdapi[0-9a-f]{16,}(-\d+)?\b/gi
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g
const TOKEN_PARAM = /([?&](?:token|access_token|refresh_token|code|password|secret)=)[^&\s]+/gi
// a SQL statement from its keyword to the end of the text: the statement may
// carry customer values, so nothing after the keyword survives
const SQL =
  /\b(?:select\b[\s\S]{0,400}?\bfrom\b|select\s+1\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b|(?:create|alter|drop)\s+(?:table|index|schema|role|extension|view|function|database)\b|grant\s+[\s\S]{0,200}?\bon\b|revoke\s+[\s\S]{0,200}?\bfrom\b|with\s+\w+\s+as\s*\()[\s\S]*/gi

/** Strips e-mails, tokens and SQL out of free text. */
export function redact(text?: unknown): string {
  if (text == null) return ''
  let s = String(text)
  s = s.replace(SQL, '[sql]')
  s = s.replace(BEARER, 'Bearer [token]')
  s = s.replace(JWT, '[token]')
  s = s.replace(PAT, '[token]')
  s = s.replace(TOKEN_PARAM, '$1[token]')
  s = s.replace(EMAIL, '[email]')
  return s
}

function errText(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message
  return ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? redact(v).slice(0, 200) : null
}

function routeOf(req?: LogRequest | null): string | null {
  if (!req) return null
  // the matched pattern (`/api/sessions/:id`) when a route ran, else the path
  // (also for the SPA catch-all `*`); never the query string
  const pattern = req.route?.path && req.route.path !== '*' ? req.route.path : null
  const p = pattern ? `${req.baseUrl || ''}${pattern}` : String(req.originalUrl || req.url || req.path || '').split('?')[0]
  return p ? `${req.method || '?'} ${p}` : null
}

// stdout for debug/info, stderr for warn/error (the Apps log view shows both)
function defaultWriter(line: string, level?: string): void {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout
  stream.write(line + '\n')
}
type LogWriter = (line: string, level?: string) => void
let writer: LogWriter = defaultWriter

/** Swaps the line writer (tests); returns the previous one. */
export function setLogWriter(fn?: LogWriter | null): LogWriter {
  const prev = writer
  writer = fn || defaultWriter
  return prev
}

export function log(level: string, msg?: unknown, fields?: LogFields): void {
  try {
    const lvl = LEVELS.has(level) ? level : 'info'
    const f: LogFields = fields && typeof fields === 'object' ? fields : {}
    const ctx = context.getStore()
    let text = redact(msg)
    const e = errText(f.err)
    if (e) text = text ? `${text}: ${redact(e)}` : redact(e)
    if (text.length > MAX_MSG) text = text.slice(0, MAX_MSG - 1) + '…'
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      request_id: str(f.request_id) ?? ctx?.requestId ?? null,
      user_hash: str(f.user_hash) ?? userHash(f.email) ?? userHash(ctx?.req?.email) ?? null,
      route: str(f.route) ?? (ctx?.req ? str(routeOf(ctx.req)) : null),
      status: num(f.status),
      duration_ms: num(f.duration_ms),
      msg: text,
    }
    writer(JSON.stringify(line), lvl)
  } catch {
    // never into the caller
  }
}

export const logger = {
  debug: (msg?: unknown, fields?: LogFields) => log('debug', msg, fields),
  info: (msg?: unknown, fields?: LogFields) => log('info', msg, fields),
  warn: (msg?: unknown, fields?: LogFields) => log('warn', msg, fields),
  error: (msg?: unknown, fields?: LogFields) => log('error', msg, fields),
}

export { routeOf }

// Drop-in for the console-style `log` injection points (db/migrate.js, db/grants.js,
// db/pool.js, ensureReady.js): console-style variadic calls, one JSON line each.
function joinArgs(args: unknown[]): string {
  return args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeString(a))).join(' ')
}
function safeString(v: unknown): string {
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  } catch {
    return String(v)
  }
}
export const consoleLogger = {
  log: (...a: unknown[]) => log('info', joinArgs(a)),
  info: (...a: unknown[]) => log('info', joinArgs(a)),
  warn: (...a: unknown[]) => log('warn', joinArgs(a)),
  error: (...a: unknown[]) => log('error', joinArgs(a)),
  debug: (...a: unknown[]) => log('debug', joinArgs(a)),
}
