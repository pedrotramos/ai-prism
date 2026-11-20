// Retention sweep (W2-5, migration 0007; docs/operations.md §6.7).
//
// When an admin sets retention_days = N (0 = off, the default), a daily sweep
// deletes every chat session whose LAST ACTIVITY is older than N days. Last
// activity is the newest of chat_sessions.updated_at (every message write
// moves it, server/ownerScopedWrites.js insertOwnedMessage), its messages'
// created_at and its decks' / spreadsheets' / documents' updated_at: the row
// checks also keep sessions whose updated_at went stale before W2-5, when no
// message write refreshed it (QA W2-5 round 1), with everything that hangs off it (messages, tool calls,
// embeddings, compactions, Genie threads, decks, spreadsheets, documents,
// images: ON DELETE CASCADE; the usage_ledger cost rows stay, detached by ON
// DELETE SET NULL), and then the UC-volume files of the deleted images.
//
// Identity: a transaction with NO user identity (withTx('')), in which this
// module, and only this module, sets app.maintenance = 'on' with
// set_config(..., true): the flag ends with the transaction and never stays on
// a pooled connection. The aipr_* policies of 0007 let that identity see and
// delete only sessions that are already expired under the current setting, and
// read their image paths; nothing else. Any transaction that carries a user
// (every request) never matches those policies (server/settingsAudit.test.js,
// AC-S1).
//
// One sweep at a time, across every app instance: pg_try_advisory_xact_lock
// inside the sweep's transaction. A second trigger while one runs is skipped
// ('locked'), it never waits; the lock is released by COMMIT/ROLLBACK, so a
// crashed sweep cannot leave it held (a session-level pg_advisory_lock on a
// pooled socket could). Once a day: the run is stamped in app_settings
// (retention_last_sweep_at) under the same lock, and a run less than
// SWEEP_MIN_INTERVAL_MS after the stamp is skipped ('recent') unless forced.
//
// A live turn: sessions this process's turnLock holds are left out of the
// DELETE. The expiry test is inside the DELETE itself (no select-then-delete),
// so a session another instance's turn touched (updated_at = NOW()) after the
// cutoff no longer matches when the DELETE reaches its row. The sweep never
// takes the turn lock and a turn holds no row lock while it streams (its
// answer is one short transaction at the end, server/db/turnCommit.js), so the
// two cannot deadlock; at worst a turn on a session the sweep just deleted
// fails its commit, which is the retention policy doing its job.
//
// Files: the paths are read in the same statement as the DELETE, and deleted
// after COMMIT, best effort. A failed file delete is counted and logged, never
// retried (the row is gone): an orphan file on the volume, never a row that
// points at a missing file.
import { withTx } from './db/pool.js'
import { readAppSettings } from './db/admin.js'
import { recordAdminAction, SYSTEM_ACTOR } from './audit.ts'
import { deleteImageFile } from './imageStore.ts'
import { turnLock } from './turnLock.ts'
import { EPHEMERAL_IDLE_MS } from './db/ephemeral.js'
import { logger } from './log.ts'

// pg advisory lock key of the sweep (migrations use 0x41505231, "APR1")
export const RETENTION_LOCK_KEY = 0x41505232 // "APR2"
// the ephemeral rule's own lock: it runs hourly and independent of the daily stamp
export const EPHEMERAL_LOCK_KEY = 0x41505233 // "APR3"
export const SWEEP_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000
export const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000
export const SCHEDULER_FIRST_DELAY_MS = 5 * 60 * 1000
const FILE_DELETE_CONCURRENCY = 4

// the transaction client withTx hands over (only `query` is used here); pg rows are untyped
interface SweepClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}
type Logger = { info(msg: string, fields?: Record<string, unknown>): unknown; warn(msg: string, fields?: Record<string, unknown>): unknown }

// `s` is expired: the session row and every activity row hanging off it are
// older than the cutoff. $1 = the session ids a live turn holds (spared).
// Under the maintenance identity only rows of updated_at-expired sessions are
// visible (aipr_maint_read, 0007), which is exactly the set checked here.
const EXPIRED_SESSION = `s.updated_at < aip_retention_cutoff()
  AND NOT (s.id = ANY($1::bigint[]))
  AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.created_at >= aip_retention_cutoff())
  AND NOT EXISTS (SELECT 1 FROM chat_decks d WHERE d.session_id = s.id AND d.updated_at >= aip_retention_cutoff())
  AND NOT EXISTS (SELECT 1 FROM chat_spreadsheets x WHERE x.session_id = s.id AND x.updated_at >= aip_retention_cutoff())
  AND NOT EXISTS (SELECT 1 FROM chat_documents o WHERE o.session_id = s.id AND o.updated_at >= aip_retention_cutoff())`
// Sessions per DELETE statement, and statements per run: each statement stays
// well inside the pool's 60 s query_timeout even on the first sweep of a large
// backlog; a backlog beyond SWEEP_BATCH_SIZE x SWEEP_MAX_BATCHES is finished
// by the next daily runs (the result says `capped`).
export const SWEEP_BATCH_SIZE = 500
export const SWEEP_MAX_BATCHES = 200

async function deleteFiles(paths: string[], deleteFile: (p: string) => unknown) {
  let deleted = 0
  let failed = 0
  const queue = [...paths]
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift() as string // the loop condition guarantees an entry
      let ok = false
      try {
        ok = (await deleteFile(p)) !== false
      } catch {
        ok = false
      }
      if (ok) deleted++
      else failed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(FILE_DELETE_CONCURRENCY, paths.length) }, worker))
  return { deleted, failed }
}

/**
 * One sweep. Resolves { status: 'done', sessions, users, images, filesDeleted,
 * filesFailed, retentionDays } or { status: 'skipped', reason: 'locked' |
 * 'off' | 'recent' }. Options are for tests: `force` ignores the daily stamp,
 * `afterLock` runs while the lock is held.
 */
export async function runRetentionSweep({
  force = false,
  now = Date.now,
  busySessionIds = (): unknown[] => turnLock.heldKeys(),
  deleteFile = (p: string) => deleteImageFile(null as unknown as string, p), // null token: the app's own identity, as before
  afterLock = null,
  log = logger,
  batchSize = SWEEP_BATCH_SIZE,
  maxBatches = SWEEP_MAX_BATCHES,
}: {
  force?: boolean
  now?: () => number
  busySessionIds?: () => unknown[]
  deleteFile?: (p: string) => unknown
  afterLock?: (() => unknown) | null
  log?: Logger
  batchSize?: number
  maxBatches?: number
} = {}) {
  const started = now()
  const result = await withTx('', null, async (c: SweepClient) => {
    await c.query(`SELECT set_config('app.maintenance', 'on', true)`)
    const lock = await c.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [RETENTION_LOCK_KEY])
    if (!lock.rows[0].ok) return { status: 'skipped', reason: 'locked' }
    if (afterLock) await afterLock()

    const settings = await readAppSettings(c)
    if (!settings.retentionDays) return { status: 'skipped', reason: 'off' }
    const last = settings.retentionLastSweepAt ? Date.parse(settings.retentionLastSweepAt) : NaN
    if (!force && Number.isFinite(last) && started - last < SWEEP_MIN_INTERVAL_MS) return { status: 'skipped', reason: 'recent' }

    const busy = (busySessionIds() || []).map(String).filter((id) => /^\d{1,19}$/.test(id))
    let sessions = 0
    let capped = false
    const owners = new Set() // only counted, never logged or stored
    const paths: string[] = []
    for (let batch = 0; ; batch++) {
      if (batch >= maxBatches) {
        // capped means work is left, not merely that the batch budget ran out
        const more = await c.query(`SELECT EXISTS (SELECT 1 FROM chat_sessions s WHERE ${EXPIRED_SESSION}) AS more`, [busy])
        capped = more.rows[0].more === true
        break
      }
      // the expiry test is in the DELETE itself; the images subquery sees the
      // statement's snapshot, i.e. the rows of the sessions this DELETE removes
      const r = await c.query(
        `WITH victims AS (
           SELECT s.id FROM chat_sessions s WHERE ${EXPIRED_SESSION} ORDER BY s.id LIMIT $2
         ), gone AS (
           -- updated_at re-checked on the row being deleted: a message or studio
           -- save committed meanwhile has moved it (READ COMMITTED re-evaluates the
           -- target row). Those writes refresh the session row BEFORE touching
           -- their own row, so they hold it while the DELETE waits; a re-check of
           -- the child rows here could not help, because the cascade's wait comes
           -- after this predicate (QA W2-5 r2)
           DELETE FROM chat_sessions s USING victims v
            WHERE s.id = v.id AND s.updated_at < aip_retention_cutoff()
            RETURNING s.id, s.user_email
         )
         SELECT (SELECT coalesce(array_agg(user_email), '{}') FROM gone) AS owners,
                (SELECT count(*)::int FROM gone) AS n,
                (SELECT coalesce(array_agg(i.volume_path), '{}') FROM chat_images i WHERE i.session_id IN (SELECT id FROM gone)) AS paths`,
        [busy, batchSize]
      )
      const row = r.rows[0]
      sessions += row.n
      for (const o of row.owners) owners.add(o)
      paths.push(...row.paths)
      if (row.n < batchSize) break
    }
    const users = owners.size
    await c.query(
      `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ('retention_last_sweep_at', to_jsonb($1::text), $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
      [new Date(started).toISOString(), SYSTEM_ACTOR]
    )
    const counts = { sessions, users, images: paths.length, retentionDays: settings.retentionDays, skippedBusy: busy.length, capped }
    await recordAdminAction(c, SYSTEM_ACTOR, { action: 'retention.sweep', target: 'chat_sessions', details: counts })
    return { status: 'done', ...counts, paths }
  })

  if (result.status !== 'done') {
    if (result.reason !== 'off') log.info(`retention sweep: skipped (${result.reason})`, { reason: result.reason })
    return result
  }
  const { paths, ...counts } = result
  const files = await deleteFiles(paths, deleteFile)
  const out = { ...counts, filesDeleted: files.deleted, filesFailed: files.failed }
  const fields = { ...out, durationMs: now() - started }
  // the JSON logger keeps only its fixed fields, so the counts go in the message too
  log.info(
    `retention sweep: done sessions=${out.sessions} users=${out.users} images=${out.images} ` +
      `files_deleted=${out.filesDeleted} files_failed=${out.filesFailed} retention_days=${out.retentionDays}` +
      (out.capped ? ' capped=true (the rest goes in the next runs)' : ''),
    fields
  )
  if (files.failed) log.warn(`retention sweep: ${files.failed} volume file(s) could not be deleted (orphaned)`, fields)
  return out
}

/**
 * The ephemeral rule (W3-6, migration 0011): deletes every temporary chat idle
 * for more than EPHEMERAL_IDLE_MS (24 h; the database policy floors it there),
 * whatever the retention setting says: the safety net for a tab that died
 * before its delete reached the server. Last activity = chat_sessions.updated_at
 * (every message write moves it). Same identity as the sweep (no user,
 * app.maintenance on, the aipr_* policies), its own advisory lock, no daily
 * stamp (the scheduler's hourly tick runs it), a session a live turn holds is
 * spared. Resolves { status: 'done', sessions, images, filesDeleted, filesFailed }
 * or { status: 'skipped', reason: 'locked' }. The only audit written is a count.
 */
export async function runEphemeralSweep({
  now = Date.now,
  busySessionIds = (): unknown[] => turnLock.heldKeys(),
  deleteFile = (p: string) => deleteImageFile(null as unknown as string, p), // null token: the app's own identity, as before
  idleMs = EPHEMERAL_IDLE_MS,
  log = logger,
  batchSize = SWEEP_BATCH_SIZE,
  maxBatches = SWEEP_MAX_BATCHES,
}: {
  now?: () => number
  busySessionIds?: () => unknown[]
  deleteFile?: (p: string) => unknown
  idleMs?: number
  log?: Logger
  batchSize?: number
  maxBatches?: number
} = {}) {
  const started = now()
  const cutoff = new Date(started - idleMs).toISOString()
  const result = await withTx('', null, async (c: SweepClient) => {
    await c.query(`SELECT set_config('app.maintenance', 'on', true)`)
    const lock = await c.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [EPHEMERAL_LOCK_KEY])
    if (!lock.rows[0].ok) return { status: 'skipped', reason: 'locked' }
    const busy = (busySessionIds() || []).map(String).filter((id) => /^\d{1,19}$/.test(id))
    let sessions = 0
    const paths: string[] = []
    for (let batch = 0; batch < maxBatches; batch++) {
      const r = await c.query(
        `WITH victims AS (
           SELECT s.id FROM chat_sessions s
            WHERE s.ephemeral AND s.updated_at < $3::timestamptz AND NOT (s.id = ANY($1::bigint[]))
            ORDER BY s.id LIMIT $2
         ), gone AS (
           DELETE FROM chat_sessions s USING victims v
            WHERE s.id = v.id AND s.ephemeral AND s.updated_at < $3::timestamptz
            RETURNING s.id
         )
         SELECT (SELECT count(*)::int FROM gone) AS n,
                (SELECT coalesce(array_agg(i.volume_path), '{}') FROM chat_images i WHERE i.session_id IN (SELECT id FROM gone)) AS paths`,
        [busy, batchSize, cutoff]
      )
      const row = r.rows[0]
      sessions += row.n
      paths.push(...row.paths)
      if (row.n < batchSize) break
    }
    if (sessions) {
      await recordAdminAction(c, SYSTEM_ACTOR, { action: 'retention.ephemeral', target: 'chat_sessions', details: { sessions, images: paths.length } })
    }
    return { status: 'done', sessions, images: paths.length, paths }
  })
  if (result.status !== 'done') return result
  const { paths, ...counts } = result
  const files = await deleteFiles(paths, deleteFile)
  const out = { ...counts, filesDeleted: files.deleted, filesFailed: files.failed }
  if (out.sessions) log.info(`ephemeral sweep: done sessions=${out.sessions} images=${out.images} files_failed=${out.filesFailed}`, out)
  if (files.failed) log.warn(`ephemeral sweep: ${files.failed} volume file(s) could not be deleted (orphaned)`, out)
  return out
}

/**
 * Checks hourly (first check SCHEDULER_FIRST_DELAY_MS after boot) and runs the
 * sweep; the daily stamp and the advisory lock make N instances sweep once a
 * day in total. RETENTION_SWEEP=off disables it (kill switch). The timer is
 * unref'd: it never keeps the process alive. Returns stop(), or null when off.
 */
export function startRetentionScheduler({
  env = process.env,
  run = async () => {
    // the ephemeral rule is independent of the retention setting: one failing
    // must not stop the other
    const settled = await Promise.allSettled([runRetentionSweep(), runEphemeralSweep()])
    const failed = settled.find((x) => x.status === 'rejected')
    if (failed) throw failed.reason
    return (settled[0] as PromiseFulfilledResult<unknown>).value // no rejection survived the check above
  },
  setTimer = setTimeout as (fn: () => unknown, ms: number) => ReturnType<typeof setTimeout>,
  clearTimer = clearTimeout as (h: ReturnType<typeof setTimeout>) => unknown,
  intervalMs = SCHEDULER_INTERVAL_MS,
  firstDelayMs = SCHEDULER_FIRST_DELAY_MS,
  log = logger,
}: {
  env?: Record<string, string | undefined>
  run?: () => Promise<unknown>
  setTimer?: (fn: () => unknown, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => unknown
  intervalMs?: number
  firstDelayMs?: number
  log?: Logger
} = {}) {
  if (String(env.RETENTION_SWEEP || '').toLowerCase() === 'off') return null
  let handle: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const schedule = (ms: number) => {
    if (stopped) return
    handle = setTimer(tick, ms)
    handle?.unref?.()
  }
  async function tick() {
    try {
      await run()
    } catch (e) {
      log.warn('retention sweep failed', { err: e })
    } finally {
      schedule(intervalMs)
    }
  }
  schedule(firstDelayMs)
  return () => {
    stopped = true
    if (handle) clearTimer(handle)
  }
}
