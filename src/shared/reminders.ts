// Thread reminders, bounded catch-up checks and their notifications, shared by the main process
// and the renderer. Checks, notification attempts and reading are separate records: nothing here
// marks a post read, and a notification never stands for "all new replies".
import type { ReadError } from './api'
import type { PostId, ReadingMode, ThreadId } from './forum'

/** 全串更新 / PO 追更 / 引用我的发言. Each kind is enabled per thread, independently. */
export type ReminderKind = 'all' | 'po' | 'quote'

export const REMINDER_KINDS: readonly ReminderKind[] = ['all', 'po', 'quote']

/** Why a rule was last turned off; `null` while enabled or when never enabled. */
export type ReminderCloseReason = 'user' | 'unsubscribe' | 'sync-delete'

export interface ReminderRule {
  kind: ReminderKind
  enabled: boolean
  /**
   * Start (提醒起点) of the current enable, or of the last one while disabled; `null` when never
   * enabled. Set when the user enables the rule; failed or offline checks never move it.
   */
  startedAt: string | null
  closedBy: ReminderCloseReason | null
}

export interface ThreadReminders {
  threadId: ThreadId
  rules: Record<ReminderKind, ReminderRule>
}

/** Effective check triggers. Focus, wake, enabling rules and adding own IDs are not triggers. */
export type CheckTrigger = 'cold-start' | 'reopen' | 'manual'

/**
 * Per-thread result of the latest checking state:
 * - `baseline-pending`: an enabled rule cannot yet prove any reply newer than its start (待建立基线);
 * - `checking`: part of the running round and not finished yet;
 * - `done`: reached this round's frozen target without coverage issues (no confirmed news is not
 *   the same as "everything checked": see `issues` and `uncertainCount`);
 * - `incomplete`: stopped before the frozen target, or no verifiable target yet (尚未补完);
 * - `failed`: the thread could not be read this round (`lastError`);
 * - `uncertain`: reached the target, but coverage has issues (覆盖不确定).
 */
export type ThreadCheckState = 'baseline-pending' | 'checking' | 'done' | 'incomplete' | 'failed' | 'uncertain'

/**
 * - `shifted`: a re-checked page sequence changed, coverage restarted from page 1;
 * - `gaps`: pages between 1 and the target were not obtained;
 * - `count-mismatch`: ReplyCount differs from the obtained replies;
 * - `target-unverified`: the bounded tail probe found no last page + empty successor;
 * - `boundary-uncertain`: some matching replies can be proven neither before nor after the start.
 */
export type CoverageIssue = 'shifted' | 'gaps' | 'count-mismatch' | 'target-unverified' | 'boundary-uncertain'

/** One reminder per post, whichever rules it matched. */
export interface ReminderEvent {
  postId: PostId
  threadId: ThreadId
  kinds: ReminderKind[]
  /** Where it was observed; a navigation hint, not a permanent location. */
  mode: ReadingMode
  page: number
  /** Short plain-text snapshot taken when the event was recorded. */
  excerpt: string
  /** Server `now` text as provided (timezone unverified), or `null`. */
  createdAt: string | null
  /** Own post IDs this reply explicitly quotes (`quote` kind), ascending. */
  quotedOwnIds: PostId[]
  discoveredAt: string
}

export interface ThreadReminderGroup {
  threadId: ThreadId
  /** Title or short text of the main post when stored; `null` when unknown. */
  title: string | null
  rules: Record<ReminderKind, ReminderRule>
  state: ThreadCheckState
  issues: CoverageIssue[]
  lastError: ReadError | null
  lastCheckedAt: string | null
  /** Matching replies with an unprovable start boundary; never counted as events. */
  uncertainCount: number
  /** Confirmed events. Display through `formatReminderCount`. */
  eventCount: number
  /** Newest first; at most `MAX_EVENTS_PER_GROUP`. */
  events: ReminderEvent[]
}

export const MAX_EVENTS_PER_GROUP = 200

export type RoundState = 'running' | 'finished' | 'cancelled' | 'interrupted'
/** `crash`: found `running` at the next start. */
export type RoundStopReason = 'user' | 'rate-limited' | 'quit' | 'crash'

export interface CheckRound {
  id: number
  trigger: CheckTrigger
  startedAt: string
  finishedAt: string | null
  state: RoundState
  stopReason: RoundStopReason | null
  threadsTotal: number
  threadsDone: number
  threadsFailed: number
  /** Events first recorded in this round. */
  newEvents: number
}

/** `complete` only when every thread of the round reached its frozen target without issues. */
export type NotificationCoverage = 'complete' | 'partial' | 'interrupted' | 'failed-some'
/** `registered`: stored before the attempt; `unknown`: the app ended before the attempt settled. */
export type NotificationState = 'registered' | 'shown' | 'unavailable' | 'failed' | 'unknown'

export interface ReminderNotificationRecord {
  id: number
  roundId: number
  eventCount: number
  threadCount: number
  coverage: NotificationCoverage
  state: NotificationState
  registeredAt: string
}

export interface ReminderOverview {
  checker: { running: boolean; cooldownRemainingMs: number }
  currentRound: CheckRound | null
  lastRound: CheckRound | null
  lastNotification: ReminderNotificationRecord | null
  /** Threads with an enabled rule or recorded events, most recent event first. */
  threads: ThreadReminderGroup[]
}

export type CheckRequestResult =
  | { accepted: true; roundId: number }
  | { accepted: false; reason: 'running' | 'cooldown' | 'storage'; retryAfterMs: number }

export type RemindersResult<T> = ({ ok: true } & T) | { ok: false; reason: 'storage' }

export interface RemindersApi {
  /** Rules of the given threads (at most 500); threads without rows report all kinds disabled. */
  getRules(input: { threadIds: ThreadId[] }): Promise<RemindersResult<{ threads: ThreadReminders[] }>>
  /** Enabling sets a new start; disabling keeps start, events and coverage. Never triggers a check. */
  setRule(input: { threadId: ThreadId; kind: ReminderKind; enabled: boolean }): Promise<RemindersResult<{ thread: ThreadReminders }>>
  overview(): Promise<RemindersResult<{ overview: ReminderOverview }>>
  /** Manual check: shares the single-flight and the 60 s cooldown with cold start and reopen. */
  check(): Promise<CheckRequestResult>
  /** Stops the running round; confirmed results and gaps are kept. */
  cancel(): Promise<void>
  /**
   * Local half of an in-app unsubscribe / confirmed sync deletion when the user chose to close
   * reminders: disables every enabled kind of these threads, independent of the remote result.
   */
  closeForThreads(input: { threadIds: ThreadId[]; reason: 'unsubscribe' | 'sync-delete' }): Promise<RemindersResult<{ closed: ThreadId[] }>>
  /** Rules, progress or events changed. Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void
  /** A reminder notification was clicked: show the reminders list. */
  onOpenList(listener: () => void): () => void
}

/** Main → renderer event channels of `RemindersApi.onChanged` / `onOpenList`. */
export const REMINDERS_CHANGED_CHANNEL = 'reminders:changed'
export const REMINDERS_OPEN_CHANNEL = 'reminders:open-list'

/** Confirmed counts: up to 99 as is, 100 and more as `99+`. Unknown coverage is shown separately. */
export function formatReminderCount(count: number): string {
  return count >= 100 ? '99+' : String(count)
}
