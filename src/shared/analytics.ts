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
}

export type AnalyticsChoiceResult =
  | { result: 'saved'; state: AnalyticsState }
  /** The choice applies to this run only; the next start reads `state.saved`. */
  | { result: 'not-saved'; state: AnalyticsState }
  /** Not changed. `protection-unavailable`: no OS secret storage. */
  | { result: 'refused'; reason: 'unavailable' | 'protection-unavailable'; state: AnalyticsState }

export interface AnalyticsApi {
  getState(): Promise<AnalyticsState>
  setChoice(choice: 'on' | 'off'): Promise<AnalyticsChoiceResult>
}

/** The stored record (settings key `analytics`). The token is OS-protected ciphertext, base64. */
export interface AnalyticsRecord {
  choice: AnalyticsChoice
  identity: { instanceId: string; protectedToken: string } | null
  /** Statistics day (as the service reported it) of the last accepted activity report. */
  reportedDay: string | null
}

export const EMPTY_ANALYTICS_RECORD: AnalyticsRecord = { choice: 'unset', identity: null, reportedDay: null }

const CHOICES: readonly string[] = ['unset', 'off', 'on']
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** A stored value read back; anything unreadable is the empty record (never answered, off). */
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
  const reportedDay = typeof input.reportedDay === 'string' && ANALYTICS_STAT_DAY_PATTERN.test(input.reportedDay) ? input.reportedDay : null
  return { choice, identity, reportedDay }
}
