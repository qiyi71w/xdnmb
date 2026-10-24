import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionCandidate,
  SubscriptionContext,
  SubscriptionFailure,
  SubscriptionMergeSource,
  SubscriptionPlan,
  SubscriptionPreview,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { threadLabel } from './subscriptionText'
import type { ReminderLinkage } from '../reminders/ReminderLinkage'

export type ReconcileMode = SubscriptionPreview['mode']

export type ExecuteOutcome =
  | { type: 'plan'; plan: SubscriptionPlan }
  /** Refused before any durable plan existed (stale, invalid-selection, cancelled, busy…). */
  | { type: 'refused'; reason: SubscriptionFailure }
  /** The IPC call itself rejected: whether anything was written is unknown until history is read. */
  | { type: 'failed' }

/**
 * The one sync or merge the user is working on, app-wide. A preview lives only in this process
 * and is consumed by one execution; nothing here survives a restart or is ever resumed.
 */
export type ReconcileTask =
  | { phase: 'previewing'; mode: ReconcileMode; mergeSource: SubscriptionMergeSource | null; operationId: string; stopRequested: boolean }
  | { phase: 'preview-failed'; mode: ReconcileMode; mergeSource: SubscriptionMergeSource | null; reason: SubscriptionFailure | 'internal' }
  | { phase: 'preview'; preview: SubscriptionPreview; mergeSource: SubscriptionMergeSource | null; selected: ReadonlySet<string> }
  | {
      phase: 'executing'
      preview: SubscriptionPreview
      mergeSource: SubscriptionMergeSource | null
      selectedIds: readonly string[]
      operationId: string
      stopRequested: boolean
      /** Reminder choice for the selected removals, applied locally before the plan. */
      reminders: ReminderLinkage | null
    }
  | {
      phase: 'finished'
      preview: SubscriptionPreview
      mergeSource: SubscriptionMergeSource | null
      selectedIds: readonly string[]
      stopRequested: boolean
      outcome: ExecuteOutcome
      reminders: ReminderLinkage | null
    }

/** A preview being read or a plan being executed: no other subscription write may start meanwhile. */
export function busyTask(task: ReconcileTask | null): boolean {
  return task !== null && (task.phase === 'previewing' || task.phase === 'executing')
}

/** Identity combination a preview was made for; any difference makes it unusable. */
export function contextKey(context: SubscriptionContext): string {
  return [context.generation, context.appCredentialId ?? '-', context.webCredentialId ?? '-'].join('|')
}

/** Whether the current UUID / binding is still the one the preview fixed. */
export function previewCurrent(preview: SubscriptionPreview, current: SubscriptionContext | null): boolean {
  return current !== null && contextKey(current) === contextKey(preview.context)
}

/** Fixed label of the collection a candidate writes to. Merge always writes to the current App (right). */
export function targetLabel(preview: SubscriptionPreview, target: SubscriptionSource): string {
  if (preview.mode === 'merge') return preview.rightLabel
  return target === 'app' ? preview.leftLabel : preview.rightLabel
}

/** Fixed label of the collection a candidate is compared against. */
export function otherLabel(preview: SubscriptionPreview, target: SubscriptionSource): string {
  if (preview.mode === 'merge') return preview.leftLabel
  return target === 'app' ? preview.rightLabel : preview.leftLabel
}

export interface CandidateGroup {
  /** The first candidate's ID: unique even when the same effect appears in several runs. */
  key: string
  action: SubscriptionAction
  target: SubscriptionSource
  items: SubscriptionCandidate[]
}

/**
 * Consecutive candidates with the same effect, in the given order. Never regroups across the list:
 * a plan executes in the preview's order, so what the user reads must follow that order too.
 */
export function groupCandidates(items: readonly SubscriptionCandidate[]): CandidateGroup[] {
  const groups: CandidateGroup[] = []
  for (const item of items) {
    const last = groups.at(-1)
    if (last !== undefined && last.action === item.action && last.target === item.target) last.items.push(item)
    else groups.push({ key: item.id, action: item.action, target: item.target, items: [item] })
  }
  return groups
}

/** Additions start checked; deletion candidates never do. */
export function defaultSelection(preview: SubscriptionPreview): Set<string> {
  return new Set(preview.items.filter((item) => item.action === 'add').map((item) => item.id))
}

/** Selected IDs in the preview's own order, which is the order the plan executes in. */
export function selectedInOrder(preview: SubscriptionPreview, selected: ReadonlySet<string>): string[] {
  return preview.items.filter((item) => selected.has(item.id)).map((item) => item.id)
}

/** Thread names from either observation, for rows that would otherwise be bare numbers. */
export function threadLabels(preview: SubscriptionPreview): Map<ThreadId, string> {
  const labels = new Map<ThreadId, string>()
  for (const observation of [preview.left, preview.right]) {
    for (const page of observation.pages) {
      for (const thread of page.threads) if (!labels.has(thread.head.id)) labels.set(thread.head.id, threadLabel(thread))
    }
  }
  return labels
}

export function countByAction(preview: SubscriptionPreview, ids: Iterable<string>): { add: number; remove: number } {
  const chosen = new Set(ids)
  let add = 0
  let remove = 0
  for (const item of preview.items) {
    if (!chosen.has(item.id)) continue
    if (item.action === 'add') add++
    else remove++
  }
  return { add, remove }
}

/** The item a running plan is working on: the first one still pending. */
export function currentItemIndex(plan: SubscriptionPlan): number {
  if (plan.state !== 'running') return -1
  return plan.items.findIndex((item) => item.state === 'pending')
}

export function newestPlansFirst(plans: SubscriptionPlan[]): SubscriptionPlan[] {
  return [...plans].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}
