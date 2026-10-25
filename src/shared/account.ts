import type { ImportResult } from './identity'

export type AccountFailure = 'protection-unavailable' | 'storage' | 'expired' | 'cancelled' | 'network' | 'rate-limited' | 'unknown-structure' | 'blocked'
export interface AccountCookie {
  id: string
  publicId: string
  validUntil: string
  claimedAt: string
}
export type AccountResult<T> = { ok: true; value: T } | { ok: false; reason: AccountFailure }
export interface AccountOverview {
  available: boolean
  blocker: 'protection-unavailable' | 'storage' | null
  loggedIn: boolean
  expiresAt: string | null
}
export interface AccountApi {
  getOverview(): Promise<AccountOverview>
  /** Reuses a valid encrypted session, otherwise opens the isolated official login window. */
  login(): Promise<AccountResult<AccountCookie[]>>
  list(): Promise<AccountResult<AccountCookie[]>>
  importSelected(input: { ids: string[] }): Promise<AccountResult<Array<{ id: string; result: ImportResult }>>>
  /** Forgets only the local encrypted session; never calls the official logout endpoint. */
  forget(): Promise<AccountResult<null>>
}
