// Thread reminders: per-thread reply-count baselines and counts since the thread was last opened,
// shared by the main process and the renderer. Nothing here marks a post read; a count only says how
// many new replies arrived (deleted ones included), never which ones.
import type { ReadError } from './api'
import type { Post, ReadingMode, ThreadId } from './forum'

/** 全串更新 / PO 追更 / 引用我的发言. Each kind is enabled per thread, independently. */
export type ReminderKind = 'all' | 'po' | 'quote'

/** Display order everywhere: 全串, PO, 引用. */
export const REMINDER_KINDS: readonly ReminderKind[] = ['all', 'po', 'quote']

/** Why a rule was last turned off; `null` while enabled or when never enabled. */
export type ReminderCloseReason = 'user' | 'unsubscribe' | 'sync-delete'

export interface ReminderRule {
  kind: ReminderKind
  enabled: boolean
  closedBy: ReminderCloseReason | null
  /** Disabled: null; enabled: pending until a successful baseline read, then ready. */
  baseline: 'pending' | 'ready' | null
}

export interface ThreadReminders {
  threadId: ThreadId
  rules: Record<ReminderKind, ReminderRule>
}

/**
 * Why a thread's reminders may be missing something (覆盖问题). Never counted, never shown in the bell.
 * - `read-failed`: a read failed in the latest check (`lastError` says why); counts and rules stay;
 * - `not-found`: the forum said the thread does not exist (串不存在); rules stay enabled;
 * - `rate-limited`: the latest check stopped for a rate limit or captcha before this thread finished;
 * - `incomplete`: quote pages are not all read yet (尚未补完); the next check resumes where it stopped;
 * - `count-decreased`: the reply count went down; the baseline was reset to it, nothing counted;
 * - `count-invalid`: the reply count was missing or malformed; the baseline was kept;
 * - `quote-unverified`: some new replies quote posts whose 饼干 ID could not be obtained (被引发言未能核实),
 *   never treated as "not mine" (`unverifiedQuotes` says how many since the thread was last opened).
 */
export type CoverageIssue =
  | 'read-failed'
  | 'not-found'
  | 'rate-limited'
  | 'incomplete'
  | 'count-decreased'
  | 'count-invalid'
  | 'quote-unverified'

/** One 提醒 row: a thread with at least one enabled kind. */
export interface ReminderThreadRow {
  threadId: ThreadId
  /** Main post as held on this machine (a check reading page 1 refreshes it); null when not held. */
  head: Post | null
  /** Last title kept for the thread; used when the head is not held. */
  title: string | null
  /** Latest reply count observed for the 全部 mode; null when unknown. */
  replyCount: number | null
  rules: Record<ReminderKind, ReminderRule>
  /** New replies per kind since the thread was last opened; always 0 for a disabled kind. Kinds overlap. */
  counts: Record<ReminderKind, number>
  /** Coverage issues, in no particular order; empty when the latest check had none. */
  issues: CoverageIssue[]
  /** The read failure behind `read-failed` / `not-found` / `rate-limited`; null otherwise. */
  lastError: ReadError | null
  /** New replies whose quoted posts could not be verified, since the thread was last opened. */
  unverifiedQuotes: number
  /**
   * Where opening goes when the thread has no reading position: the page of the first new reply after
   * the baseline, in `po` when only the PO count is non-zero, else in `all`. Null when nothing is counted.
   */
  firstNew: { mode: ReadingMode; page: number } | null
  /** Latest time any count of this thread grew; null when nothing is counted. */
  lastIncreasedAt: string | null
  /** Latest time any kind of this thread was enabled. */
  enabledAt: string
  /** Latest time a check finished reading this thread; null before the first check. */
  lastCheckedAt: string | null
}

export interface ReminderChecker {
  running: boolean
  /** Milliseconds until a manual check is accepted again (60 s after the last accepted check). */
  cooldownRemainingMs: number
  /** When the latest check ended (finished, cancelled or interrupted); null before the first one. */
  lastCheckedAt: string | null
  /** Next automatic retry while rate-limited; null when automatic checks are off or not backed off. */
  retryAt: string | null
  /** Current rate-limit episode; survives restarts, cleared only by a wholly successful check. */
  rateLimit: { id: string; dismissed: boolean } | null
}

export interface ReminderOverview {
  checker: ReminderChecker
  /**
   * Threads with an enabled kind: those with a non-zero count first, by latest increase (newest
   * first), then the rest by latest enable (newest first).
   */
  threads: ReminderThreadRow[]
  /** Threads with any non-zero count (the 提醒 bell); display through `formatReminderCount`. */
  badge: number
}

export type CheckRequestResult =
  | { accepted: true }
  | { accepted: false; reason: 'running' | 'cooldown' | 'storage'; retryAfterMs: number }

export type RemindersResult<T> = ({ ok: true } & T) | { ok: false; reason: 'storage' }

export interface RemindersApi {
  /** Rules of the given threads (at most 500); threads without rows report all kinds disabled. */
  getRules(input: { threadIds: ThreadId[] }): Promise<RemindersResult<{ threads: ThreadReminders[] }>>
  /**
   * Enabling schedules baseline initialization for this kind, sharing the checker and cooldown;
   * disabling deletes that kind's count and baseline. Initialization never counts older replies.
   */
  setRule(input: { threadId: ThreadId; kind: ReminderKind; enabled: boolean }): Promise<RemindersResult<{ thread: ThreadReminders }>>
  overview(): Promise<RemindersResult<{ overview: ReminderOverview }>>
  /** Manual check: shares the single-flight and the 60 s cooldown with cold start and reopen. */
  check(): Promise<CheckRequestResult>
  /** Stops the running check; counts and baselines already saved are kept. */
  cancel(): Promise<void>
  /**
   * Local half of an in-app unsubscribe / confirmed sync deletion when the user chose to close
   * reminders: disables every enabled kind of these threads, independent of the remote result.
   */
  closeForThreads(input: { threadIds: ThreadId[]; reason: 'unsubscribe' | 'sync-delete' }): Promise<RemindersResult<{ closed: ThreadId[] }>>
  /**
   * The user opened the thread (or switched to a tab showing it), or chose 清除提醒: every count of
   * the thread becomes 0. Reading position, visits and history are untouched.
   */
  clear(input: { threadId: ThreadId }): Promise<RemindersResult<object>>
  /** Acknowledge only this episode; a stale dismissal cannot hide a later one. */
  dismissRateLimit(input: { id: string }): Promise<RemindersResult<object>>
  /** Rules, counts or checker state changed. Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void
  /** A reminder notification was clicked: show the reminders list. */
  onOpenList(listener: () => void): () => void
}

/** Main → renderer event channels of `RemindersApi.onChanged` / `onOpenList`. */
export const REMINDERS_CHANGED_CHANNEL = 'reminders:changed'
export const REMINDERS_OPEN_CHANNEL = 'reminders:open-list'

/** Bell count: up to 99 as is, 100 and more as `99+`. */
export function formatReminderCount(count: number): string {
  return count >= 100 ? '99+' : String(count)
}
