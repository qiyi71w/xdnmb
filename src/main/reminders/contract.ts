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
  /** The check that owns this write; used for the final, post-correction notification decision. */
  roundId?: string
  baseline?: number
  /**
   * 全串／PO: the baseline this check compared page 1 with. When a reader's read has advanced the
   * stored baseline since, only growth past the stored baseline is counted.
   */
  countedFrom?: number | null
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

/** One local reply in one 全串／PO rule generation. */
export interface LocalReplyKey {
  publicationId: number
  kind: 'all' | 'po'
  generation: number
}

/**
 * A confirmed local reply a check may still read one page for: pending, with a pre-send count and
 * no proof yet, its follow-up read not sent, and the growth since its pre-send count so far only
 * uncleared check growth, so that finding it can still lead to a deduction.
 */
export interface ReminderFollowUp extends LocalReplyKey {
  threadId: ThreadId
  postId: PostId
  beforeCount: number
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
  /** Local replies of the thread a check may read one more page for. */
  reminderFollowUps(threadId: ThreadId): Promise<ReminderFollowUp[]>
  /**
   * Their follow-up read is about to go out: those still qualifying are marked sent, so no later
   * check reads one for them, and returned. None returned: the request is not needed.
   */
  claimReminderFollowUps(keys: LocalReplyKey[]): Promise<LocalReplyKey[]>
  /** Claimed, but the request never went out: a later check may read their page after all. */
  releaseReminderFollowUps(keys: LocalReplyKey[]): Promise<void>
  /** Their follow-up page did not hold them: still pending without proof, they become unprovable. */
  missReminderFollowUps(keys: LocalReplyKey[]): Promise<void>
  /** Threads with an uncleared, unexcluded increment from this check, in current generations. */
  reminderIncreasedThreads(roundId: string): Promise<ThreadId[]>
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
