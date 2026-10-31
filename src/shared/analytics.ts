// Voluntary usage statistics as the desktop client sees them. The wire protocol to the receiving
// service is in `analytics-protocol.ts`; this file is the main ↔ renderer contract and the shape
// of the local record.

import { ANALYTICS_INSTANCE_ID_PATTERN, ANALYTICS_STAT_DAY_PATTERN } from './analytics-protocol'

/** `unset`: never answered; counts as off. Only `on` lets anything be sent. */
export type AnalyticsChoice = 'unset' | 'off' | 'on'

/**
 * Why statistics cannot run in this build or on this run. `available` is the only state in which
 * the first-run question is asked or the choice can be changed.
 */
export type AnalyticsAvailability =
  | 'available'
  /** Only Windows and macOS are part of the statistics. */
  | 'unsupported-platform'
  /** This build has no receiving service configured. */
  | 'not-configured'
  /** The local database is read-only or failed to open: no choice can be kept. */
  | 'storage-unavailable'

export interface AnalyticsState {
  availability: AnalyticsAvailability
  /** What this run does. After a failed save it differs from `saved`. */
  choice: AnalyticsChoice
  /** What the next start will read. */
  saved: AnalyticsChoice
  /** A statistics identity exists on this device, so the service may hold records linked to it. */
  hasIdentity: boolean
  /** A requested deletion has not been confirmed by the service; statistics stay off until it is. */
  deletionPending: boolean
  /** Host name of the receiving service, for the disclosure; `null` when not configured. */
  receiver: string | null
}

export type AnalyticsChoiceResult =
  | { result: 'saved'; state: AnalyticsState }
  /** The choice applies to this run only; the next start reads `state.saved`. */
  | { result: 'not-saved'; state: AnalyticsState }
  /** Not changed. `deletion-pending`: finish the deletion first; `protection-unavailable`: no OS secret storage. */
  | { result: 'refused'; reason: 'unavailable' | 'deletion-pending' | 'protection-unavailable'; state: AnalyticsState }

export type AnalyticsDeletionFailure =
  /** No answer: offline, timed out or refused connection. */
  | 'network'
  /** The service is busy (rate limited) or failed; nothing was deleted. */
  | 'service'
  /** The service did not accept this device's credentials. */
  | 'rejected'
  /** The credentials cannot be read without OS secret storage. */
  | 'protection-unavailable'
  /** The deletion could not be recorded locally first, so it was not sent. */
  | 'storage'

export type AnalyticsDeletionResult =
  | { result: 'deleted'; state: AnalyticsState }
  | { result: 'failed'; reason: AnalyticsDeletionFailure; state: AnalyticsState }

export interface AnalyticsApi {
  getState(): Promise<AnalyticsState>
  setChoice(choice: 'on' | 'off'): Promise<AnalyticsChoiceResult>
  /** Stops statistics, then asks the service to delete the records linked to this device. */
  deleteData(): Promise<AnalyticsDeletionResult>
}

/** The stored record (settings key `analytics`). The token is OS-protected ciphertext, base64. */
export interface AnalyticsRecord {
  choice: AnalyticsChoice
  identity: { instanceId: string; protectedToken: string } | null
  deletionPending: boolean
  /** Statistics day (as the service reported it) of the last accepted activity report. */
  reportedDay: string | null
}

export const EMPTY_ANALYTICS_RECORD: AnalyticsRecord = { choice: 'unset', identity: null, deletionPending: false, reportedDay: null }

const CHOICES: readonly string[] = ['unset', 'off', 'on']
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * A stored value read back; anything unreadable is the empty record (never answered, off). A
 * pending deletion keeps its identity and forces `off`, so no reading can turn it back on.
 */
export function analyticsRecord(value: unknown): AnalyticsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY_ANALYTICS_RECORD
  const input = value as Record<string, unknown>
  const choice = typeof input.choice === 'string' && CHOICES.includes(input.choice) ? (input.choice as AnalyticsChoice) : 'unset'
  const rawIdentity = input.identity
  let identity: AnalyticsRecord['identity'] = null
  if (typeof rawIdentity === 'object' && rawIdentity !== null && !Array.isArray(rawIdentity)) {
    const { instanceId, protectedToken } = rawIdentity as Record<string, unknown>
    if (typeof instanceId === 'string' && ANALYTICS_INSTANCE_ID_PATTERN.test(instanceId) &&
        typeof protectedToken === 'string' && protectedToken.length <= 4096 && BASE64.test(protectedToken)) {
      identity = { instanceId, protectedToken }
    }
  }
  const deletionPending = input.deletionPending === true && identity !== null
  const reportedDay = typeof input.reportedDay === 'string' && ANALYTICS_STAT_DAY_PATTERN.test(input.reportedDay) ? input.reportedDay : null
  return { choice: deletionPending ? 'off' : choice, identity, deletionPending, reportedDay }
}
