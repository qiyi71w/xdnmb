import type { ReadError } from '../../shared/api'
import type { Post, PostId, ReadingMode, ThreadId } from '../../shared/forum'
import type {
  CheckRound, CheckTrigger, CoverageIssue, NotificationCoverage, ReminderCloseReason, ReminderKind,
  ReminderNotificationRecord, ReminderOverview, ThreadCheckState, ThreadReminders
} from '../../shared/reminders'

export interface RuleSnapshot {
  threadId: ThreadId
  kind: ReminderKind
  generation: number
  startedAt: string
  watermarkPostId: PostId | null
}
export interface ReminderCheckpoint {
  page: number
  pageIds: PostId[]
  prevIds: PostId[]
  complete: boolean
}
export type ReminderUncertainty = Partial<Record<ReminderKind, { generation: number; postIds: PostId[] }>>
export interface ReminderCoverage {
  threadId: ThreadId
  mode: ReadingMode
  checkpoint: ReminderCheckpoint | null
  probe: { page: number; direction: 'forward' | 'backward' } | null
  state: ThreadCheckState
  issues: CoverageIssue[]
  lastError: ReadError | null
  lastRoundId: number | null
  updatedAt: string | null
  uncertainCount: number
  uncertainty: ReminderUncertainty
  quoteOwnRevision: string | null
}
export interface ReminderObservation {
  page: number
  replyIds: PostId[]
  skippedItems: number
  posts: Array<Post | null>
}
export interface EvaluationInput {
  roundId: number
  threadId: ThreadId
  mode: ReadingMode
  target: PostId | null
  rules: RuleSnapshot[]
  at: string
}
export interface EvaluationResult {
  newEvents: number
  uncertainCount: number
  uncertainty: ReminderUncertainty
  baselinePending: boolean
}
export type ReminderStoredOverview = Omit<ReminderOverview, 'checker'>

/** Short worker transactions only. Network requests and notification attempts never run in SQLite. */
export interface ReminderStore {
  firstProvenNewPost(since: string): Promise<PostId | null>
  getReminderRules(threadIds: ThreadId[]): Promise<ThreadReminders[]>
  setReminderRule(threadId: ThreadId, kind: ReminderKind, enabled: boolean, at: string): Promise<ThreadReminders>
  closeReminderThreads(threadIds: ThreadId[], reason: ReminderCloseReason, at: string): Promise<ThreadId[]>
  reminderRuleSnapshots(): Promise<RuleSnapshot[]>
  getReminderCoverage(threadId: ThreadId, mode: ReadingMode): Promise<ReminderCoverage>
  saveReminderCoverage(coverage: ReminderCoverage): Promise<void>
  getReminderObservations(threadId: ThreadId, mode: ReadingMode): Promise<ReminderObservation[]>
  reminderOwnRevision(): Promise<string>
  evaluateReminders(input: EvaluationInput): Promise<EvaluationResult>
  createReminderRound(trigger: CheckTrigger, at: string, threadsTotal: number): Promise<CheckRound>
  saveReminderRound(round: CheckRound): Promise<void>
  recoverReminders(at: string): Promise<void>
  registerReminderNotification(roundId: number, coverage: NotificationCoverage, at: string): Promise<ReminderNotificationRecord | null>
  settleReminderNotification(id: number, state: 'shown' | 'unavailable' | 'failed'): Promise<void>
  reminderOverview(): Promise<ReminderStoredOverview>
}

export interface ReminderNotifier {
  /**
   * `false`: unsupported/unavailable; a throw: the attempt failed synchronously. `true` only means
   * the attempt was handed to the system: `settle` later reports the system's own `shown` / `failed`
   * signal (at most once). Without a signal the record stays `registered`, never claimed shown.
   */
  show(message: { title: string; body: string }, settle: (state: 'shown' | 'failed') => void): boolean
}
