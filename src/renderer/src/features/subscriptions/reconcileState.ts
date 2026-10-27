import type {
  SubscriptionChoice,
  SubscriptionContext,
  SubscriptionDifference,
  SubscriptionFailure,
  SubscriptionItemChoice,
  SubscriptionMergeSource,
  SubscriptionPlan,
  SubscriptionPreview,
  SubscriptionSource
} from '../../../../shared/subscriptions'

export type ReconcileMode = SubscriptionPreview['mode']

/** Choice per difference ID; every difference of the preview has one. */
export type ChoiceMap = ReadonlyMap<string, SubscriptionChoice>

export type ExecuteOutcome =
  | { type: 'plan'; plan: SubscriptionPlan }
  /** Refused before any durable plan existed (invalid-selection, cancelled, busy…); `stale` re-previews instead. */
  | { type: 'refused'; reason: SubscriptionFailure }
  /** The IPC call itself rejected: whether anything was written is unknown until history is read. */
  | { type: 'failed' }

/** Why a preview is shown again: the previous one changed before execution and nothing was written. */
export type PreviewNotice = 'stale' | null

/**
 * The one sync or merge the user is working on, app-wide. A preview lives only in this process
 * and is consumed by one execution; nothing here survives a restart or is ever resumed.
 */
export type ReconcileTask =
  | {
      phase: 'previewing'
      mode: ReconcileMode
      mergeSource: SubscriptionMergeSource | null
      operationId: string
      stopRequested: boolean
      notice: PreviewNotice
    }
  | { phase: 'preview-failed'; mode: ReconcileMode; mergeSource: SubscriptionMergeSource | null; reason: SubscriptionFailure | 'internal' }
  | { phase: 'preview'; preview: SubscriptionPreview; mergeSource: SubscriptionMergeSource | null; choices: ChoiceMap; notice: PreviewNotice }
  | {
      phase: 'executing'
      preview: SubscriptionPreview
      mergeSource: SubscriptionMergeSource | null
      choices: ChoiceMap
      operationId: string
      stopRequested: boolean
    }
  | {
      phase: 'finished'
      preview: SubscriptionPreview
      mergeSource: SubscriptionMergeSource | null
      choices: ChoiceMap
      stopRequested: boolean
      outcome: ExecuteOutcome
    }

/** A preview being read or a plan being executed: no other subscription write may start meanwhile. */
export function busyTask(task: ReconcileTask | null): boolean {
  return task !== null && (task.phase === 'previewing' || task.phase === 'executing')
}

export function taskMode(task: ReconcileTask): ReconcileMode {
  return task.phase === 'previewing' || task.phase === 'preview-failed' ? task.mode : task.preview.mode
}

/** Identity combination a preview was made for; any difference makes it unusable. */
export function contextKey(context: SubscriptionContext): string {
  return [context.generation, context.appCredentialId ?? '-', context.webCredentialId ?? '-'].join('|')
}

/** Whether the current UUID / binding is still the one the preview fixed. */
export function previewCurrent(preview: SubscriptionPreview, current: SubscriptionContext | null): boolean {
  return current !== null && contextKey(current) === contextKey(preview.context)
}

/** Each difference starts at the choice the evidence suggests. */
export function defaultChoices(preview: SubscriptionPreview): Map<string, SubscriptionChoice> {
  return new Map(preview.items.map((item) => [item.id, item.defaultChoice]))
}

/** Sets `choice` on the given differences; ones that do not offer it keep theirs. */
export function withChoice(preview: SubscriptionPreview, choices: ChoiceMap, ids: readonly string[], choice: SubscriptionChoice): Map<string, SubscriptionChoice> {
  const next = new Map(choices)
  const wanted = new Set(ids)
  for (const item of preview.items) if (wanted.has(item.id) && item.choices.includes(choice)) next.set(item.id, choice)
  return next
}

export function choiceOf(item: SubscriptionDifference, choices: ChoiceMap): SubscriptionChoice {
  return choices.get(item.id) ?? item.defaultChoice
}

/** What execution sends: every difference that writes, in the preview's order (the execution order). */
export function planChoices(preview: SubscriptionPreview, choices: ChoiceMap): SubscriptionItemChoice[] {
  return preview.items.flatMap((item) => {
    const choice = choiceOf(item, choices)
    return choice === 'skip' ? [] : [{ itemId: item.id, choice }]
  })
}

/** Writes the choices would make: 两端都订阅 adds on the missing side, 两端都取消 removes on the present one. */
export function writeCounts(preview: SubscriptionPreview, choices: ChoiceMap): { add: number; remove: number } {
  let add = 0
  let remove = 0
  for (const item of preview.items) {
    const choice = choiceOf(item, choices)
    if (choice === 'both') add++
    else if (choice === 'none') remove++
  }
  return { add, remove }
}

/** The side a difference is missing from. */
export function missingSide(item: SubscriptionDifference): SubscriptionSource {
  return item.presentOn === 'app' ? 'web' : 'app'
}

export interface DifferenceGroup {
  presentOn: SubscriptionSource
  items: SubscriptionDifference[]
}

/** Sync: only on the web first, then only in the App; merge has one group. Empty groups are left out. */
export function differenceGroups(preview: SubscriptionPreview): DifferenceGroup[] {
  const order: SubscriptionSource[] = preview.mode === 'merge' ? ['app'] : ['web', 'app']
  return order
    .map((presentOn) => ({ presentOn, items: preview.items.filter((item) => item.presentOn === presentOn) }))
    .filter((group) => group.items.length > 0)
}

export interface PlanCounts {
  /** Confirmed writes by action. */
  added: number
  removed: number
  failed: number
  unknown: number
  /** Not run: skipped after a stop, or still pending in a plan that ended. */
  notRun: number
}

/** What a plan did, item by item; for the one-line result and the history. */
export function planCounts(plan: SubscriptionPlan): PlanCounts {
  const counts: PlanCounts = { added: 0, removed: 0, failed: 0, unknown: 0, notRun: 0 }
  for (const item of plan.items) {
    if (item.state === 'confirmed') {
      if (item.candidate.action === 'add') counts.added++
      else counts.removed++
    } else if (item.state === 'failed') counts.failed++
    else if (item.state === 'unknown') counts.unknown++
    else if (item.state === 'skipped' || plan.state !== 'running') counts.notRun++
  }
  return counts
}

/** The item a running plan is working on: the first one still pending. */
export function currentItemIndex(plan: SubscriptionPlan): number {
  if (plan.state !== 'running') return -1
  return plan.items.findIndex((item) => item.state === 'pending')
}

export function newestPlansFirst(plans: SubscriptionPlan[]): SubscriptionPlan[] {
  return [...plans].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}
