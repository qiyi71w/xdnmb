import type { ContentNode } from './forum'

export const ANNOUNCEMENT_URL = 'https://nmb.ovear.info/nmb-notice.json'
export const MAX_ANNOUNCEMENT_LENGTH = 128 * 1024

/** The full upstream version and exact body; neither is a timestamp or a hash. */
export interface AnnouncementIdentity {
  date: string | number
  content: string
}

export interface Announcement extends AnnouncementIdentity {
  enable: boolean
  fetchedAt: string
  nodes: ContentNode[]
}

export interface AnnouncementRecord {
  latest: AnnouncementIdentity & { enable: boolean; fetchedAt: string } | null
  suppressed: AnnouncementIdentity | null
}

export interface AnnouncementState {
  latest: Announcement | null
  source: 'current' | 'cached' | 'none'
  outcome: 'ready' | 'disabled' | 'invalid' | 'network-error' | 'not-fetched'
  /** A successful read can still fail to persist; it remains usable for this run. */
  saved: boolean
  storageAvailable: boolean
}

export interface AnnouncementsApi {
  /** Waits for the one cold-start read; never initiates another read. */
  getState(): Promise<AnnouncementState>
  refresh(): Promise<AnnouncementState>
  /** Main grants at most one automatic presentation per process, only in the foreground. */
  takeAutomatic(): Promise<Announcement | null>
  suppress(identity: AnnouncementIdentity): Promise<{ saved: boolean }>
}

export function isAnnouncementIdentity(value: unknown): value is AnnouncementIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return ((typeof item.date === 'string' && item.date.length > 0 && item.date.length <= MAX_ANNOUNCEMENT_LENGTH) ||
    (typeof item.date === 'number' && Number.isSafeInteger(item.date))) &&
    typeof item.content === 'string' && item.content.trim().length > 0 && item.content.length <= MAX_ANNOUNCEMENT_LENGTH
}

export function sameAnnouncement(left: AnnouncementIdentity | null, right: AnnouncementIdentity | null): boolean {
  return left !== null && right !== null && left.date === right.date && left.content === right.content
}

export function announcementRecord(value: unknown): AnnouncementRecord {
  const empty: AnnouncementRecord = { latest: null, suppressed: null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty
  const record = value as Record<string, unknown>
  const latest = record.latest
  if (isAnnouncementIdentity(latest) && 'enable' in latest && typeof latest.enable === 'boolean' &&
      'fetchedAt' in latest && typeof latest.fetchedAt === 'string' && Number.isFinite(Date.parse(latest.fetchedAt))) {
    empty.latest = { date: latest.date, content: latest.content, enable: latest.enable, fetchedAt: latest.fetchedAt }
  }
  if (isAnnouncementIdentity(record.suppressed)) empty.suppressed = { date: record.suppressed.date, content: record.suppressed.content }
  return empty
}
