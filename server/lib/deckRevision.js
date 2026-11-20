// N6: optimistic concurrency on a deck write (save and AI edit).
//
// The client names the revision it based the write on: `If-Match` header (a quoted or
// bare integer) or the body field `baseRevision`. The header wins when both are sent.
// A write whose base is not the deck's current revision is 409 deck_conflict and carries
// the current deck, so the studio can offer "reload theirs" / "keep mine". A write with
// no base (a tab opened before this shipped) is accepted and logged, so a deploy does not
// break open tabs; it still bumps the revision.
import { logger } from '../log.ts'

export const DECK_CONFLICT = 'deck_conflict'
export const DECK_BUSY = 'deck_busy'
export const DECK_REVISION_INVALID = 'deck_revision_invalid'

/**
 * Reads the base revision of a request. Returns { base: number } | { base: null } (none sent)
 * | { invalid: true } (sent but not a positive integer).
 */
export function readBaseRevision(req) {
  const hdr = req.get?.('if-match')
  const raw = hdr != null && String(hdr).trim() !== '' ? String(hdr).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1') : req.body?.baseRevision
  if (raw === undefined || raw === null || raw === '') return { base: null }
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n >= 1 ? { base: n } : { invalid: true }
}

/** 400 for a malformed base. Returns true so a route can `if (refuseBadRevision(res, r)) return`. */
export function refuseBadRevision(res, parsed) {
  if (!parsed.invalid) return false
  res.status(400).json({ error: DECK_REVISION_INVALID, code: DECK_REVISION_INVALID, message: 'revisão base inválida' })
  return true
}

/** The save carried no base revision: accepted, but worth knowing about while old tabs are open. */
export function warnMissingBase(route) {
  logger.warn(`deck_revision_missing: ${route} had no base revision (a client from before the revision check)`)
}

/** Sends 409 deck_conflict with the current deck (already owner/member-scoped by getDeck). */
export function sendDeckConflict(res, current) {
  res.status(409).json({
    error: DECK_CONFLICT,
    code: DECK_CONFLICT,
    message: 'este deck foi alterado em outra aba ou por outra sessão',
    revision: current.revision,
    deck: current,
  })
}

/**
 * Sends 409 deck_busy: another AI edit holds the deck (it is running, or its process died and
 * the lease has not lapsed yet). Sent BEFORE any model call, so nothing is spent. No deck content.
 */
export function sendDeckBusy(res) {
  res.status(409).json({
    error: DECK_BUSY,
    code: DECK_BUSY,
    message: 'outra edição com IA está em andamento neste deck; tente de novo em instantes',
  })
}
