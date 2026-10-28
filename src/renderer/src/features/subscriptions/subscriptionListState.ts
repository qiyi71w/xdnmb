import type {
  SubscriptionAction,
  SubscriptionContext,
  SubscriptionFailure,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import type { ThreadId } from '../../../../shared/forum'
import { needsReconcile, sourceBlocker } from './subscriptionText'
import type { ActiveWrite, ChangeRequest, WriteNotice } from './useSubscriptions'

export type ListActivity = 'idle' | 'stored' | 'first' | 'next'

/**
 * One subscription list view. Observations are never cleared by a failed, refused, cancelled or
 * partial read: a newer observation without any page keeps the previous one on screen as `earlier`
 * (labelled as older), and only a selection change (source, UUID or binding) starts over.
 */
export interface SubscriptionListState {
  /** Source + identity references + generation the observations below belong to. */
  selection: string | null
  /** Latest observation for this selection: read here, or the stored one. */
  shown: SubscriptionObservation | null
  /** `shown` came from local storage, not from a read made in this view. */
  shownStored: boolean
  /** Previous observation kept on screen while `shown` has no page. */
  earlier: SubscriptionObservation | null
  activity: ListActivity
  /** 停止 was requested for the running read; its (cancelled) observation is still applied. */
  stopRequested: boolean
  /** The last read was refused before any request (unconfigured, locked, busy…). */
  refusal: SubscriptionFailure | null
  /** The last local call rejected (IPC failure). */
  internalError: 'stored' | 'read' | null
}

export type SubscriptionListAction =
  | { type: 'reset'; selection: string }
  | { type: 'start'; activity: Exclude<ListActivity, 'idle'> }
  | { type: 'stored'; observation: SubscriptionObservation | null }
  | { type: 'stop-requested' }
  | { type: 'observed'; observation: SubscriptionObservation }
  | { type: 'refused'; reason: SubscriptionFailure }
  | { type: 'internal'; where: 'stored' | 'read' }
  | { type: 'idle' }

export const initialSubscriptionListState: SubscriptionListState = {
  selection: null,
  shown: null,
  shownStored: false,
  earlier: null,
  activity: 'idle',
  stopRequested: false,
  refusal: null,
  internalError: null
}

/** Leaving a result's page clears only that same successful notice, never an unsettled or newer write. */
export function clearSuccessfulWriteOnLeave(current: WriteNotice | null, displayed: WriteNotice | null): WriteNotice | null {
  if (current === null || current !== displayed || current.outcome.type !== 'done') return current
  const operation = current.outcome.operation
  return operation.reportError?.kind !== 'rate-limited' && !needsReconcile(operation) ? null : current
}

/** Identity of what the list shows; any change drops results still arriving for the old one. */
export function selectionKey(overview: SubscriptionOverview): string {
  const { context } = overview
  return [overview.source, context.generation, context.appCredentialId ?? '-', context.webCredentialId ?? '-'].join('|')
}

/** The observation whose threads are on screen: the latest with any page, else the earlier one. */
export function displayedObservation(state: SubscriptionListState): SubscriptionObservation | null {
  if (state.shown !== null && state.shown.pages.length > 0) return state.shown
  return state.earlier
}

/** Local reference of the remote collection a source writes to: the App UUID ref or the web sync credential. */
export function sourceObjectRef(context: SubscriptionContext, source: SubscriptionSource): string | null {
  return source === 'app' ? context.appCredentialId : context.webCredentialId
}

/**
 * Whether an unresolved journal entry blocks a new write to the same thread of the same remote
 * collection. Only the source's own reference counts: a generation bump caused by the other
 * source (e.g. a web rebinding) does not release an unresolved App write. Different local refs
 * that happen to hold the same secret are left to the backend's authoritative `busy` refusal.
 */
export function blocksNewWrite(
  operation: SubscriptionOperation,
  target: { source: SubscriptionSource; objectRef: string | null; threadId: ThreadId }
): boolean {
  return (
    operation.state !== 'settled' &&
    operation.source === target.source &&
    operation.threadId === target.threadId &&
    sourceObjectRef(operation.context, operation.source) === target.objectRef
  )
}

type ActiveChange = Pick<ActiveWrite, 'kind' | 'source' | 'threadId' | 'action' | 'generation'> | null

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

/** Whether a journal entry offers the read-only 核对: unresolved results and orphan pending intents. */
export function isReconcilable(operation: SubscriptionOperation, active: ActiveChange): boolean {
  if (operation.state === 'pending') return !isRunningChange(operation, active)
  return needsReconcile(operation)
}

/** What a press of 订阅／已订阅／取消订阅／加入 does now: the one write itself, or why it cannot start. */
export type ChangeDecision = { kind: 'write'; request: ChangeRequest } | { kind: 'blocked'; reason: string }

/**
 * A press writes at once, with no confirmation step. The request targets the source and identity
 * combination shown at the press; it is sent once and never retried. Reminders of an unsubscribed
 * thread stay as they are (nothing is asked). Blocked presses keep their reasons.
 */
export function decideChange({
  overview,
  operations,
  busy,
  action,
  threadId,
  label,
  unresolved
}: {
  overview: SubscriptionOverview | null
  operations: readonly SubscriptionOperation[] | null
  /** A write, 核对, preview read or plan is running. */
  busy: boolean
  action: SubscriptionAction
  threadId: ThreadId
  label: string
  /** Wording for an unresolved earlier write of this thread, which only 核对 may follow. */
  unresolved: string
}): ChangeDecision {
  if (overview === null) return { kind: 'blocked', reason: '订阅设置尚未读取' }
  const blocker = sourceBlocker(overview, overview.source)
  if (blocker !== null) return { kind: 'blocked', reason: blocker }
  if (!overview.writable) return { kind: 'blocked', reason: '本地存储不可写' }
  if (busy) return { kind: 'blocked', reason: '另一项订阅操作正在进行' }
  const objectRef = sourceObjectRef(overview.context, overview.source)
  if (operations?.some((item) => blocksNewWrite(item, { source: overview.source, objectRef, threadId })) === true) {
    return { kind: 'blocked', reason: unresolved }
  }
  return {
    kind: 'write',
    request: { source: overview.source, threadId, action, expectedGeneration: overview.context.generation, label }
  }
}

export function subscriptionListReducer(state: SubscriptionListState, action: SubscriptionListAction): SubscriptionListState {
  switch (action.type) {
    case 'reset':
      return { ...initialSubscriptionListState, selection: action.selection }
    case 'start':
      return { ...state, activity: action.activity, stopRequested: false, refusal: null, internalError: null }
    case 'stored':
      // A read that already landed is newer than whatever storage returns.
      if (state.shown !== null && !state.shownStored) return { ...state, activity: state.activity === 'stored' ? 'idle' : state.activity }
      return {
        ...state,
        shown: action.observation,
        shownStored: action.observation !== null,
        activity: state.activity === 'stored' ? 'idle' : state.activity
      }
    case 'stop-requested':
      return state.activity === 'first' || state.activity === 'next' ? { ...state, stopRequested: true } : state
    case 'observed': {
      const { observation } = action
      const keepPrevious = observation.pages.length === 0
      const previous = state.shown !== null && state.shown.pages.length > 0 ? state.shown : state.earlier
      return {
        ...state,
        shown: observation,
        shownStored: false,
        earlier: keepPrevious ? previous : null,
        activity: 'idle',
        stopRequested: false,
        refusal: null,
        internalError: null
      }
    }
    case 'refused':
      return { ...state, activity: 'idle', stopRequested: false, refusal: action.reason }
    case 'internal':
      return { ...state, activity: 'idle', stopRequested: false, internalError: action.where }
    case 'idle':
      return { ...state, activity: 'idle', stopRequested: false }
  }
}
