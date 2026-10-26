import type { ReadError } from '../../shared/api'
import type { PostId, ThreadId } from '../../shared/forum'
import type { CoverageIssue, ReminderCloseReason, ReminderKind, ReminderOverview, ThreadReminders } from '../../shared/reminders'

/** An enabled kind as a check found it; a write carrying an older generation is dropped. */
export interface RuleSnapshot {
  threadId: ThreadId
  kind: ReminderKind
  generation: number
}

/** What a check needs from an enabled kind's stored state (absent before its first check). */
export interface ReminderKindState {
  threadId: ThreadId
  kind: ReminderKind
  /** Last reply count of the kind's mode (quote: replies whose quotes are checked); null until set. */
  baseline: number | null
  /** Quote kind: highest reply ID whose quotes are checked; null until the first check sets it. */
  checkedPostId: PostId | null
  issues: CoverageIssue[]
}

/**
 * One write for one kind, applied only while the rule still has `generation` (enabled). Omitted
 * fields stay as stored; `issues` and `lastError` replace the stored ones together.
 */
export interface ReminderUpdate {
  threadId: ThreadId
  kind: ReminderKind
  generation: number
  at: string
  baseline?: number
  checkedPostId?: PostId
  /** New replies counted by this write. */
  add?: number
  /** Page of this write's first new reply; kept only when the count was 0 before. */
  firstPage?: number
  /** New replies whose quotes could not be verified. */
  unverified?: number
  issues?: CoverageIssue[]
  lastError?: ReadError | null
  /** The check finished reading this kind (sets its last-checked time). */
  checked?: boolean
}

/** Whether a quoted post is the user's: a confirmed own publication, or its 饼干 ID as held locally. */
export interface QuoteSource {
  postId: PostId
  own: boolean
  cookieId: string | null
}

export interface ReminderBackoff {
  minutes: number
  episodeId: string | null
  notified: boolean
  dismissed: boolean
}

export type ReminderStoredOverview = Omit<ReminderOverview, 'checker'> & { lastCheckedAt: string | null }

/** Short worker transactions only. Network requests and notification attempts never run in SQLite. */
export interface ReminderStore {
  getReminderRules(threadIds: ThreadId[]): Promise<ThreadReminders[]>
  setReminderRule(threadId: ThreadId, kind: ReminderKind, enabled: boolean, at: string): Promise<ThreadReminders>
  closeReminderThreads(threadIds: ThreadId[], reason: ReminderCloseReason, at: string): Promise<ThreadId[]>
  reminderRuleSnapshots(): Promise<RuleSnapshot[]>
  /** Stored state of the enabled kinds. */
  reminderStates(): Promise<ReminderKindState[]>
  /** Distinct known 饼干 IDs of the imported cookies, sorted. */
  reminderCookieIds(): Promise<string[]>
  reminderQuoteSources(postIds: PostId[]): Promise<QuoteSource[]>
  /** `false` when the rule was disabled or re-enabled since the snapshot: nothing was written. */
  updateReminderState(update: ReminderUpdate): Promise<boolean>
  /** Every count of the thread becomes 0; `false` when there was nothing to clear. */
  clearReminderCounts(threadId: ThreadId): Promise<boolean>
  finishReminderCheck(at: string): Promise<void>
  loadReminderBackoff(): Promise<ReminderBackoff>
  saveReminderBackoff(value: ReminderBackoff): Promise<void>
  reminderOverview(): Promise<ReminderStoredOverview>
}

export interface ReminderNotifier {
  /** `false`: unsupported/unavailable; a throw: the attempt failed. Either way nothing else changes. */
  show(message: { title: string; body: string }): boolean
}
