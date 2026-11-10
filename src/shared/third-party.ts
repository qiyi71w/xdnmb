import type { AnalyticsState } from './analytics'

export type ThirdPartyService = 'updates' | 'search' | 'analytics'
export interface ThirdPartyChoices {
  updates: boolean
  search: boolean
  analytics: boolean
}

/** Statistics keep their existing choice/identity record; this records the new disclosure and other permissions. */
export interface ThirdPartyRecord {
  version: 1
  updates: boolean
  search: boolean
}

export interface ThirdPartyState {
  /** This disclosure was answered, on disk or (after a failed rejection save) for this run only. */
  acknowledged: boolean
  updates: boolean
  search: boolean
  analytics: AnalyticsState
}

export type ThirdPartyResult =
  | { result: 'saved' | 'not-saved'; state: ThirdPartyState }
  | { result: 'refused'; reason: 'unavailable' | 'protection-unavailable' | 'disclosure-required'; state: ThirdPartyState }

export const THIRD_PARTY_CHANGED_CHANNEL = 'xidao:third-party-changed'

export interface ThirdPartyApi {
  getState(): Promise<ThirdPartyState>
  /** First disclosure only. All three choices are explicit; no legacy choice is inherited. */
  complete(choices: ThirdPartyChoices): Promise<ThirdPartyResult>
  /** Later, change just this permission. Does not grant other services. */
  setChoice(service: ThirdPartyService, allowed: boolean): Promise<ThirdPartyResult>
  onChanged(listener: () => void): () => void
}

export function isThirdPartyChoices(value: unknown): value is ThirdPartyChoices {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 3 && typeof input.updates === 'boolean' && typeof input.search === 'boolean' && typeof input.analytics === 'boolean'
}

/** Missing, corrupt or unknown disclosures never authorize a request. */
export function thirdPartyRecord(value: unknown): ThirdPartyRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  return input.version === 1 && typeof input.updates === 'boolean' && typeof input.search === 'boolean'
    ? { version: 1, updates: input.updates, search: input.search }
    : null
}
