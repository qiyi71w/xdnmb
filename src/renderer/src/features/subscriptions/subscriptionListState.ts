import type {
  SubscriptionAction,
  SubscriptionContext,
  SubscriptionFailure,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { completeSubscriptionObservation } from '../../../../shared/subscriptions'
import type { ThreadId, ThreadSummary } from '../../../../shared/forum'
import { needsReconcile, sourceBlocker } from './subscriptionText'
import type { ActiveWrite, ChangeRequest, WriteNotice } from './useSubscriptions'

/** Leaving a result's page clears only that same successful notice, never an unsettled or newer write. */
export function clearSuccessfulWriteOnLeave(current: WriteNotice | null, displayed: WriteNotice | null): WriteNotice | null {
  if (current === null || current !== displayed || current.outcome.type !== 'done') return current
  const operation = current.outcome.operation
  return operation.reportError?.kind !== 'rate-limited' && !needsReconcile(operation) ? null : current
}

/**
 * The last result line once `closed` was dismissed: dropped only when it is that entry's own result
 * (the recorded entry itself, or the orphan intent of the same change: source, thread, action and
 * identity generation). Any other result, e.g. a newer 核对 of the same thread elsewhere, stays.
 */
export function noticeAfterDismiss(current: WriteNotice | null, closed: SubscriptionOperation): WriteNotice | null {
  if (current === null) return null
  const { write, outcome } = current
  if (outcome.type === 'done') return outcome.operation.id === closed.id ? null : current
  const orphan =
    write.kind === 'change' &&
    (outcome.type === 'failed' || outcome.reason === 'result-storage') &&
    write.source === closed.source &&
    write.threadId === closed.threadId &&
    write.action === closed.action &&
    write.generation === closed.context.generation
  return orphan ? null : current
}

/** Local reference of the remote collection a source writes to: the App UUID ref or the web sync credential. */
export function sourceObjectRef(context: SubscriptionContext, source: SubscriptionSource): string | null {
  return source === 'app' ? context.appCredentialId : context.webCredentialId
}

/**
 * Identity of one remote collection as read: its source, the identity generation and both local
 * references. Evidence and reads of one key never show for another, and App and 网页 never share one.
 */
export function collectionKey(source: SubscriptionSource, context: SubscriptionContext): string {
  return [source, context.generation, context.appCredentialId ?? '-', context.webCredentialId ?? '-'].join('|')
}

export function observationKey(observation: SubscriptionObservation): string {
  return collectionKey(observation.source, observation.context)
}

/**
 * One remote collection in this window, shared by every view of it and owned by the app, not by a
 * view: leaving a view never cancels its read. The read task, the last complete display snapshot and
 * the latest evidence are kept apart. A failed, cancelled or partial read never replaces the
 * snapshot; only a contiguous read that reached the end candidate does.
 */
export interface CollectionState {
  /** The stored snapshot and latest observation, read from local storage once per collection (`idle`: not asked yet). */
  local: 'idle' | 'loading' | 'loaded' | 'failed'
  /** Last complete observation: what the list shows while a newer read runs or after it failed. */
  snapshot: SubscriptionObservation | null
  /** Newest observation, stored, read here or a write's readback, whatever its end: the latest evidence and read state. */
  latest: SubscriptionObservation | null
  /** Newest observation with any page: shown, as not read to the end, while there is no snapshot. */
  partial: SubscriptionObservation | null
  /** A read round of this collection is running. */
  reading: boolean
  /** 停止读取 was requested for the running round: no further page starts. */
  stopRequested: boolean
  /** The last round ended because 停止读取 was requested (not a failure, not a timeout). */
  stopped: boolean
  /** The last round was refused before any request (unconfigured, locked, busy…). */
  refusal: SubscriptionFailure | null
  /** The last round's local call rejected (IPC failure). */
  internalError: boolean
}

export const unloadedCollection: CollectionState = {
  local: 'idle',
  snapshot: null,
  latest: null,
  partial: null,
  reading: false,
  stopRequested: false,
  stopped: false,
  refusal: null,
  internalError: false
}

export type CollectionEvent =
  | { type: 'load' }
  | { type: 'local'; snapshot: SubscriptionObservation | null; latest: SubscriptionObservation | null }
  | { type: 'local-failed' }
  | { type: 'start' }
  | { type: 'stop-requested' }
  | { type: 'observed'; observation: SubscriptionObservation }
  /** A write's readback or 核对 read of this collection, from the journal; also of dismissed entries. */
  | { type: 'evidence'; observation: SubscriptionObservation }
  | { type: 'refused'; reason: SubscriptionFailure }
  | { type: 'internal' }
  | { type: 'end' }

/**
 * Takes an observation wherever it is not older than what it would replace, so arrival order (a
 * slow local read, a write's readback, a running round) never puts older evidence over newer.
 * Another state of the same observation replaces it only by progress: a stored or journal copy
 * (`live` false) only with more pages, so a late copy never undoes pages read since or the stop or
 * error that ended the running read; a page result of this window's round (`live`) also with as many
 * (its failure, cancellation or later success at the same page count). Returns `state` itself when
 * nothing changes.
 */
function absorb(state: CollectionState, observation: SubscriptionObservation | null, live: boolean): CollectionState {
  if (observation === null) return state
  const later = (current: SubscriptionObservation | null) => {
    if (current === null) return true
    if (current.id !== observation.id || current.startedAt !== observation.startedAt) return observation.startedAt >= current.startedAt
    return live ? observation.pages.length >= current.pages.length : observation.pages.length > current.pages.length
  }
  const latest = later(state.latest) ? observation : state.latest
  const partial = observation.pages.length > 0 && later(state.partial) ? observation : state.partial
  const snapshot = completeSubscriptionObservation(observation) && later(state.snapshot) ? observation : state.snapshot
  return latest === state.latest && partial === state.partial && snapshot === state.snapshot ? state : { ...state, latest, partial, snapshot }
}

export function collectionReducer(state: CollectionState, event: CollectionEvent): CollectionState {
  switch (event.type) {
    case 'load':
      return { ...state, local: 'loading' }
    case 'local':
      // A round or readback that already landed here may be newer than what storage held.
      return absorb(
        completeSubscriptionObservation(event.snapshot) ? absorb({ ...state, local: 'loaded' }, event.snapshot, false) : { ...state, local: 'loaded' },
        event.latest,
        false
      )
    case 'local-failed':
      return { ...state, local: 'failed' }
    case 'start':
      return { ...state, reading: true, stopRequested: false, stopped: false, refusal: null, internalError: false }
    case 'stop-requested':
      return state.reading ? { ...state, stopRequested: true } : state
    case 'observed':
      return absorb(state, event.observation, true)
    case 'evidence':
      return absorb(state, event.observation, false)
    case 'refused':
      // A refusal caused by the requested stop is the stop itself.
      return state.stopRequested && event.reason === 'cancelled' ? state : { ...state, refusal: event.reason }
    case 'internal':
      return { ...state, internalError: true }
    case 'end':
      return { ...state, reading: false, stopped: state.stopRequested, stopRequested: false }
  }
}

/**
 * What a list shows: the last complete snapshot, kept whole until a newer round reads to the end;
 * without one, the pages obtained so far, never presented as complete.
 */
export function collectionDisplay(state: CollectionState): { observation: SubscriptionObservation | null; complete: boolean } {
  if (state.snapshot !== null) return { observation: state.snapshot, complete: true }
  return { observation: state.partial, complete: false }
}

/** The newest confirmed write of a thread to `key`'s collection, still undecided by a list read at or after it. */
function confirmedWrites(operations: readonly SubscriptionOperation[], key: string): Map<ThreadId, SubscriptionOperation> {
  const writes = new Map<ThreadId, SubscriptionOperation>()
  const seen = new Set<ThreadId>()
  for (const operation of operations) {
    if (operation.state !== 'settled' || operation.report === 'rejected' || seen.has(operation.threadId)) continue
    if (collectionKey(operation.source, operation.context) !== key) continue
    seen.add(operation.threadId)
    if (operation.verification === 'present' || operation.verification === 'absent-supported') writes.set(operation.threadId, operation)
  }
  return writes
}

/**
 * Threads a list shows: those of the displayed observation, with confirmed writes made after it was
 * read applied (an added thread from its readback, a confirmed removal dropped). The snapshot itself
 * never confirms a write; the write's own readback does. `operations` are newest first.
 */
export function listedThreads(
  observation: SubscriptionObservation | null,
  operations: readonly SubscriptionOperation[],
  key: string
): ThreadSummary[] {
  const seen = new Map<ThreadId, ThreadSummary>()
  for (const page of observation?.pages ?? []) for (const thread of page.threads) if (!seen.has(thread.head.id)) seen.set(thread.head.id, thread)
  const since = observation?.startedAt ?? ''
  const added: ThreadSummary[] = []
  for (const [threadId, operation] of confirmedWrites(operations, key)) {
    if (operation.createdAt <= since) continue
    if (operation.verification === 'absent-supported') {
      seen.delete(threadId)
      continue
    }
    if (seen.has(threadId)) continue
    const thread = operation.after?.pages.flatMap((page) => page.threads).find((item) => item.head.id === threadId)
    if (thread !== undefined) added.push(thread)
  }
  return [...added, ...seen.values()]
}

/**
 * Whether an unresolved journal entry blocks a new write to the same thread of the same remote
 * collection. Only the source's own reference counts: a generation bump caused by the other
 * source (e.g. a web rebinding) does not release an unresolved App write. Different local refs
 * that happen to hold the same secret are left to the backend's authoritative `busy` refusal. A
 * dismissed entry no longer blocks: the next write is the user's explicit choice.
 */
export function blocksNewWrite(
  operation: SubscriptionOperation,
  target: { source: SubscriptionSource; objectRef: string | null; threadId: ThreadId }
): boolean {
  return (
    operation.state !== 'settled' &&
    operation.dismissedAt === undefined &&
    operation.source === target.source &&
    operation.threadId === target.threadId &&
    sourceObjectRef(operation.context, operation.source) === target.objectRef
  )
}

type ActiveChange = Pick<ActiveWrite, 'kind' | 'source' | 'threadId' | 'action' | 'generation'> | null

/**
 * Whether the active write or 核对 is about this thread in this collection: same source, thread and
 * identity generation. Its object is frozen at its start, so after an identity change it no longer
 * shows as running for the collection now shown.
 */
export function activeFor(
  active: ActiveChange,
  target: { source: SubscriptionSource; threadId: ThreadId; generation: number }
): boolean {
  return active !== null && active.source === target.source && active.threadId === target.threadId && active.generation === target.generation
}

/**
 * Whether a persisted `pending` entry is this app's own change that is still running. Once that
 * call has ended (e.g. its result could not be saved) the entry is an orphan intent instead: the
 * write may have gone out, so it is shown as 待核对, never as still running.
 */
export function isRunningChange(operation: SubscriptionOperation, active: ActiveChange): boolean {
  return (
    operation.state === 'pending' &&
    active !== null &&
    active.kind === 'change' &&
    active.source === operation.source &&
    active.threadId === operation.threadId &&
    active.action === operation.action &&
    active.generation === operation.context.generation
  )
}

/**
 * Whether a journal entry offers the read-only 核对 and its ×: unresolved results and orphan pending
 * intents that were not dismissed.
 */
export function isReconcilable(operation: SubscriptionOperation, active: ActiveChange): boolean {
  if (operation.dismissedAt !== undefined) return false
  if (operation.state === 'pending') return !isRunningChange(operation, active)
  return needsReconcile(operation)
}

export type ThreadMembership =
  /** Nothing known yet, and the stored list or a read of it is still on its way. */
  | { kind: 'loading' }
  /** No evidence either way: no complete list and no read that listed the thread. `failed`: the last attempt failed. */
  | { kind: 'unread'; failed: boolean }
  /** Evidence from a list read or a confirmed write, as of `at`. */
  | { kind: 'in' | 'out'; at: string }
  | { kind: 'unknown'; operation: SubscriptionOperation }

/**
 * Whether a thread is in one remote collection. `operations` are that collection's journal entries
 * for the thread, newest first. An unresolved entry after the latest confirmed write wins whatever
 * was observed later (a failed readback proves nothing), so only the read-only 核对 or its × follow;
 * a dismissed entry proves nothing either way. Otherwise the newest evidence decides: a confirmed
 * write, a read that listed the thread (even if it stopped early), or a complete read without it.
 * A partial, failed or cancelled read without the thread, or no read at all, is unknown, never "not
 * subscribed".
 */
export function threadMembership(
  threadId: ThreadId,
  collection: CollectionState | null,
  operations: readonly SubscriptionOperation[],
  active: ActiveChange
): ThreadMembership {
  let confirmed: SubscriptionOperation | undefined
  for (const operation of operations) {
    if (isReconcilable(operation, active)) return { kind: 'unknown', operation }
    if (operation.state === 'settled' && operation.report !== 'rejected') {
      confirmed = operation
      break
    }
  }
  // Candidates in order of precedence on equal times: a confirmed write first.
  const evidence: { kind: 'in' | 'out'; at: string }[] = []
  if (confirmed?.verification === 'present') evidence.push({ kind: 'in', at: confirmed.createdAt })
  else if (confirmed?.verification === 'absent-supported') evidence.push({ kind: 'out', at: confirmed.createdAt })
  // The newest read with pages keeps a thread it listed when a newer read stopped before any page.
  for (const observation of [collection?.latest ?? null, collection?.partial ?? null, collection?.snapshot ?? null]) {
    if (observation === null) continue
    if (observation.ids.includes(threadId)) evidence.push({ kind: 'in', at: observation.startedAt })
    else if (completeSubscriptionObservation(observation)) evidence.push({ kind: 'out', at: observation.startedAt })
  }
  const newest = evidence.reduce<{ kind: 'in' | 'out'; at: string } | null>((best, item) => (best === null || item.at > best.at ? item : best), null)
  if (newest !== null) return newest
  if (collection === null || collection.local === 'idle' || collection.local === 'loading' || collection.reading) return { kind: 'loading' }
  const failed =
    collection.local === 'failed' || collection.refusal !== null || collection.internalError || (collection.latest?.error ?? null) !== null
  return { kind: 'unread', failed }
}

/** What a press of 订阅／已订阅／取消订阅／加入 does now: the one write itself, or why it cannot start. */
export type ChangeDecision = { kind: 'write'; request: ChangeRequest } | { kind: 'blocked'; reason: string }

/**
 * A press writes at once, with no confirmation step. The request targets `source` (given by the
 * caller, never derived from the source the list shows) with the identity generation known at the
 * press; it is sent once and never retried. Reminders of an unsubscribed thread stay as they are
 * (nothing is asked). Blocked presses keep their reasons.
 */
export function decideChange({
  overview,
  source,
  operations,
  busy,
  action,
  threadId,
  label,
  unresolved
}: {
  overview: SubscriptionOverview
  /** The remote collection this press writes to. */
  source: SubscriptionSource
  operations: readonly SubscriptionOperation[] | null
  /** A write, 核对, preview read or plan is running. */
  busy: boolean
  action: SubscriptionAction
  threadId: ThreadId
  label: string
  /** Wording for an unresolved earlier write of this thread, which only 核对 may follow. */
  unresolved: string
}): ChangeDecision {
  const blocker = sourceBlocker(overview, source)
  if (blocker !== null) return { kind: 'blocked', reason: blocker }
  if (!overview.writable) return { kind: 'blocked', reason: '本地存储不可写' }
  if (busy) return { kind: 'blocked', reason: '另一项订阅操作正在进行' }
  const objectRef = sourceObjectRef(overview.context, source)
  if (operations?.some((item) => blocksNewWrite(item, { source, objectRef, threadId })) === true) {
    return { kind: 'blocked', reason: unresolved }
  }
  return {
    kind: 'write',
    request: { source, threadId, action, expectedGeneration: overview.context.generation, label }
  }
}
