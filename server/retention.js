// Retention sweep (W2-5, migration 0007; docs/operations.md §6.7).
//
// When an admin sets retention_days = N (0 = off, the default), a daily sweep
// deletes every chat session whose LAST ACTIVITY (chat_sessions.updated_at) is
// older than N days, with everything that hangs off it (messages, tool calls,
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
import { recordAdminAction, SYSTEM_ACTOR } from './audit.js'
import { deleteImageFile } from './imageStore.js'
import { turnLock } from './turnLock.js'
import { logger } from './log.js'

// pg advisory lock key of the sweep (migrations use 0x41505231, "APR1")
export const RETENTION_LOCK_KEY = 0x41505232 // "APR2"
export const SWEEP_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000
export const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000
export const SCHEDULER_FIRST_DELAY_MS = 5 * 60 * 1000
const FILE_DELETE_CONCURRENCY = 4

async function deleteFiles(paths, deleteFile) {
  let deleted = 0
  let failed = 0
  const queue = [...paths]
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift()
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
  busySessionIds = () => turnLock.heldKeys(),
  deleteFile = (p) => deleteImageFile(null, p),
  afterLock = null,
  log = logger,
} = {}) {
  const started = now()
  const result = await withTx('', null, async (c) => {
    await c.query(`SELECT set_config('app.maintenance', 'on', true)`)
    const lock = await c.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [RETENTION_LOCK_KEY])
    if (!lock.rows[0].ok) return { status: 'skipped', reason: 'locked' }
    if (afterLock) await afterLock()

    const settings = await readAppSettings(c)
    if (!settings.retentionDays) return { status: 'skipped', reason: 'off' }
    const last = settings.retentionLastSweepAt ? Date.parse(settings.retentionLastSweepAt) : NaN
    if (!force && Number.isFinite(last) && started - last < SWEEP_MIN_INTERVAL_MS) return { status: 'skipped', reason: 'recent' }

    const busy = (busySessionIds() || []).map(String).filter((id) => /^\d{1,19}$/.test(id))
    const r = await c.query(
      `WITH gone AS (
         DELETE FROM chat_sessions s
          WHERE s.updated_at < aip_retention_cutoff() AND NOT (s.id = ANY($1::bigint[]))
          RETURNING s.id, s.user_email
       )
       SELECT (SELECT count(*)::int FROM gone) AS sessions,
              (SELECT count(DISTINCT user_email)::int FROM gone) AS users,
              (SELECT coalesce(array_agg(i.volume_path), '{}') FROM chat_images i WHERE i.session_id IN (SELECT id FROM gone)) AS paths`,
      [busy]
    )
    const { sessions, users, paths } = r.rows[0]
    await c.query(
      `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ('retention_last_sweep_at', to_jsonb($1::text), $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
      [new Date(started).toISOString(), SYSTEM_ACTOR]
    )
    const counts = { sessions, users, images: paths.length, retentionDays: settings.retentionDays, skippedBusy: busy.length }
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
      `files_deleted=${out.filesDeleted} files_failed=${out.filesFailed} retention_days=${out.retentionDays}`,
    fields
  )
  if (files.failed) log.warn(`retention sweep: ${files.failed} volume file(s) could not be deleted (orphaned)`, fields)
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
  run = () => runRetentionSweep(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = SCHEDULER_INTERVAL_MS,
  firstDelayMs = SCHEDULER_FIRST_DELAY_MS,
  log = logger,
} = {}) {
  if (String(env.RETENTION_SWEEP || '').toLowerCase() === 'off') return null
  let handle = null
  let stopped = false
  const schedule = (ms) => {
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
