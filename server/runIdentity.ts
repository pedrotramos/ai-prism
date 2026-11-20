// Who a run acts as, for code far below the runtime that must not have to be
// passed it (2.3.0, row 4A). A scheduled run acts as the app's service
// principal (runAs 'app_sp') but still carries the owner's email for
// ownership and attribution, so any store keyed by user_email would hand it
// the owner's personal secrets. Every per-user credential lookup calls
// assertUserCredentialsAllowed() first: under app_sp it fails closed with
// [sp_no_user_credentials]. AsyncLocalStorage follows the run through awaits,
// timers and fetches, so no layer in between can forget it.
import { AsyncLocalStorage } from 'node:async_hooks'

type RunAs = 'user' | 'app_sp'

const als = new AsyncLocalStorage<{ runAs: RunAs }>()

/**
 * run `fn` with { runAs } as the current run identity. app_sp is sticky: code
 * already inside an app_sp run can't downgrade it (a nested runGraph with the
 * default runAs 'user', a missing identity)
 */
export function withRunIdentity<T>(identity: { runAs?: RunAs } | null | undefined, fn: () => T): T {
  const runAs: RunAs = currentRunAs() === 'app_sp' ? 'app_sp' : identity?.runAs || 'user'
  return als.run({ runAs }, fn)
}

/** 'user' | 'app_sp' | null (not inside a run: a plain request) */
export function currentRunAs(): RunAs | null {
  return als.getStore()?.runAs || null
}

export const SP_NO_USER_CREDENTIALS = 'sp_no_user_credentials'

/** throws { code: 'sp_no_user_credentials' } (via `makeError`) inside an app_sp run */
export function assertUserCredentialsAllowed(
  what: string,
  makeError: (code: string, message: string) => unknown = (code, message) => Object.assign(new Error(message), { code })
): void {
  if (currentRunAs() !== 'app_sp') return
  throw makeError(
    SP_NO_USER_CREDENTIALS,
    `[${SP_NO_USER_CREDENTIALS}] ${what} usa a credencial pessoal de um usuário (Minhas conexões), e uma execução agendada roda como o app: ela nunca usa credenciais de usuários.`
  )
}
