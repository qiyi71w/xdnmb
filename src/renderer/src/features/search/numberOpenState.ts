import type { LocateHint, QuoteLocation, ReadError } from '../../../../shared/api'
import type { Post, PostId, ThreadId } from '../../../../shared/forum'
import { parseNumberTarget } from '../../../../shared/online-search'

/** What 按串号打开 was asked to open: the post, a verified link's clue, and where it opens. */
export interface NumberTarget {
  postId: PostId
  hint: LocateHint | null
  /** Ctrl/Cmd + Enter or click: a located target opens in a new active tab. */
  newTab: boolean
}

type Located = Extract<QuoteLocation, { status: 'located' }>

/** A thread known from this machine's records or the link, without the post being located in it. */
export interface KnownThread {
  threadId: ThreadId
  /** Main post when the forum gave it; null when only the number is known. */
  head: Post | null
}

/**
 * Settled state of the form. None of these moved anything: navigation and history change only once
 * a target is located (or 打开原串 obtained its page), and then the state is cleared.
 */
export type NumberSettled =
  | { kind: 'invalid' }
  /** Located while the page was not on screen: 打开 is offered instead of jumping from out of sight. */
  | { kind: 'located'; target: NumberTarget; location: Located }
  | { kind: 'thread-known'; target: NumberTarget; known: KnownThread }
  /** No local record and no clue: its thread cannot be named. */
  | { kind: 'unknown-thread'; target: NumberTarget }
  /** Reading what locating needed failed; `threadId` when the owner is known. */
  | { kind: 'failed'; target: NumberTarget; error: ReadError; threadId: ThreadId | null }
  /** 打开原串 failed: `error` null = the app's own request failed. */
  | { kind: 'open-failed'; target: NumberTarget; known: KnownThread; error: ReadError | null }
  /** The app's own locate request (IPC) failed; nothing is known about the forum. */
  | { kind: 'internal'; target: NumberTarget }

/** A running step; `back` is what a cancellation returns to. */
export type NumberRunning =
  | { kind: 'locating'; seq: number; target: NumberTarget; back: NumberSettled | null }
  | { kind: 'opening'; seq: number; target: NumberTarget; known: KnownThread; back: NumberSettled }

export type NumberStatus = NumberSettled | NumberRunning

export interface NumberOpenState {
  /** Advanced by every start and cancellation: only the running step's `seq` may settle. */
  seq: number
  status: NumberStatus | null
}

export type NumberOpenAction =
  | { type: 'submit'; raw: string; newTab: boolean }
  | { type: 'locate-done'; seq: number; result: QuoteLocation }
  /** 重试 after a locate failed here (network, rate limit, internal): locates the same target again. */
  | { type: 'retry' }
  /** 打开原串 of a known thread. */
  | { type: 'open-thread-start' }
  | { type: 'open-thread-failed'; seq: number; error: ReadError | null }
  /** The located target or the thread was opened: the form is done. */
  | { type: 'opened'; seq: number }
  /** The running locate call itself rejected. */
  | { type: 'internal'; seq: number }
  /** Esc / 取消: the running step stops; what was known before it stays. */
  | { type: 'cancel' }

export const initialNumberOpenState: NumberOpenState = { seq: 0, status: null }

export function isRunning(status: NumberStatus | null): status is NumberRunning {
  return status !== null && (status.kind === 'locating' || status.kind === 'opening')
}

/** True while `seq` is the running step: only then may its result be applied or followed. */
export function isCurrentStep(state: NumberOpenState, seq: number): boolean {
  return isRunning(state.status) && state.status.seq === seq
}

/** The thread 打开原串 would open from this state, if it offers that. */
export function openableThread(status: NumberStatus | null): KnownThread | null {
  if (status === null) return null
  switch (status.kind) {
    case 'thread-known':
    case 'open-failed':
      return status.known
    default:
      return null
  }
}

function targetOf(status: NumberStatus | null): NumberTarget | null {
  return status === null || status.kind === 'invalid' ? null : status.target
}

/**
 * Explicit 按串号打开 on the 搜索 page. A busy form takes no new step (a submit or 打开原串
 * while one runs is dropped synchronously, before any re-render), late or cancelled results are
 * dropped by `seq`, and nothing here navigates: the caller follows `located` / opened page results.
 */
export function numberOpenReducer(state: NumberOpenState, action: NumberOpenAction): NumberOpenState {
  const status = state.status
  switch (action.type) {
    case 'submit': {
      if (isRunning(status)) return state
      const parsed = parseNumberTarget(action.raw)
      if (parsed === null) return { ...state, status: { kind: 'invalid' } }
      const seq = state.seq + 1
      const target: NumberTarget = { postId: parsed.postId, hint: parsed.hint, newTab: action.newTab }
      return { seq, status: { kind: 'locating', seq, target, back: null } }
    }
    case 'locate-done': {
      if (!isCurrentStep(state, action.seq) || status?.kind !== 'locating') return state
      const { target } = status
      const result = action.result
      switch (result.status) {
        case 'cancelled':
          return state
        case 'located':
          return { ...state, status: { kind: 'located', target, location: result } }
        case 'thread-known':
          return { ...state, status: { kind: 'thread-known', target, known: { threadId: result.threadId, head: result.head } } }
        case 'unknown-thread':
          return { ...state, status: { kind: 'unknown-thread', target } }
        case 'failed':
          return { ...state, status: { kind: 'failed', target, error: result.error, threadId: result.threadId } }
      }
      return state
    }
    case 'retry': {
      if (status === null || isRunning(status)) return state
      // Missing or forbidden would only repeat; network, rate limit and internal failures may recover.
      const retryable =
        (status.kind === 'failed' && status.error.kind !== 'not-found' && status.error.kind !== 'permission') || status.kind === 'internal'
      if (!retryable) return state
      const seq = state.seq + 1
      return { seq, status: { kind: 'locating', seq, target: status.target, back: status } }
    }
    case 'open-thread-start': {
      const known = openableThread(status)
      const target = targetOf(status)
      if (status === null || known === null || target === null || isRunning(status)) return state
      const seq = state.seq + 1
      return { seq, status: { kind: 'opening', seq, target, known, back: status.kind === 'open-failed' ? { kind: 'thread-known', target, known } : status } }
    }
    case 'open-thread-failed':
      if (!isCurrentStep(state, action.seq) || status?.kind !== 'opening') return state
      return { ...state, status: { kind: 'open-failed', target: status.target, known: status.known, error: action.error } }
    case 'opened':
      return isCurrentStep(state, action.seq) || (status?.kind === 'located' && action.seq === state.seq) ? { ...state, status: null } : state
    case 'internal':
      if (!isCurrentStep(state, action.seq) || status?.kind !== 'locating') return state
      return { ...state, status: { kind: 'internal', target: status.target } }
    case 'cancel':
      if (!isRunning(status)) return state
      return { seq: state.seq + 1, status: status.back }
  }
}
