import type { QuoteLocation, QuotePreview, ReadError, ReadOutcome } from '../../../../shared/api'
import type { PostId } from '../../../../shared/forum'
import { quoteHostId, type QuoteAnchor } from './QuoteContext'

/**
 * What a locate request is for. `navigate` (click / Enter) and `background` (Ctrl/Cmd + click or
 * Ctrl/Cmd + Enter) act on success; `resolve` only finds out whether the quote can be located
 * (manual retry), so a retry never performs an earlier failed jump. `open-thread` (打开原串) reads the
 * page the thread would resume at and commits only once it was obtained; a failure stays on the card.
 */
export type LocateIntent = 'navigate' | 'background' | 'resolve' | 'open-thread'

/**
 * How a quote was chosen. `hover` opens an unpinned preview and never replaces a pinned card;
 * `preview` (Space on a focused quote) is an explicit choice: unpinned, but it replaces any card;
 * `activate` (click / Enter / Ctrl·Cmd variants) pins the card and replaces any card.
 */
export type QuoteTrigger = 'hover' | 'preview' | 'activate'

/** The quote reference a card belongs to. */
export interface QuoteSource {
  tabId: number
  /** History entry whose reader shows the quote; navigation is committed only while it is current. */
  entryKey: number
  /** The quoted post. */
  postId: PostId
  /** Where the quote reference sits, for returning focus to it. */
  focus: QuoteAnchor
  /** Selected reference inside a preview; `focus` remains the original, persistent trigger. */
  reference?: QuoteAnchor
}

/**
 * One quote card. Every request carries the card `id` and its own `seq`; a result is applied only
 * while both are still the current ones, so results of closed cards, of other quotes, of cancelled
 * locates and of superseded retries are dropped.
 */
export interface QuoteCard {
  id: number
  source: QuoteSource
  /** Opened or taken over by click / Enter (or 打开原串): moving the mouse away does not close it. */
  pinned: boolean
  /** `outcome` null while loading. A cancelled outcome is never stored. */
  preview: { seq: number; outcome: ReadOutcome<QuotePreview> | null }
  /**
   * `result` null while running; `locate` null when no locate was asked for or it was cancelled.
   * `known` is set while 打开原串 runs: the `thread-known` result it started from. A failure to read
   * the resume page is stored as a `failed` result with the thread's ID.
   */
  locate: {
    seq: number
    intent: LocateIntent
    result: QuoteLocation | null
    known?: Extract<QuoteLocation, { status: 'thread-known' }>
  } | null
}

export interface QuoteState {
  card: QuoteCard | null
  nextId: number
  nextSeq: number
}

export type QuoteAction =
  /** The same quote keeps its card (activation pins it); another quote replaces it per QuoteTrigger. */
  | { type: 'open'; source: QuoteSource; trigger: QuoteTrigger }
  | { type: 'preview-done'; cardId: number; seq: number; outcome: ReadOutcome<QuotePreview> }
  /** Starts a locate on the current card; activation pins the card. */
  | { type: 'locate-start'; cardId: number; intent: Exclude<LocateIntent, 'open-thread'> }
  /** 打开原串 after a `thread-known` result: starts reading the resume page. */
  | { type: 'open-thread-start'; cardId: number }
  /** A locate result that is not acted on (failures, `resolve`); success with a jump closes instead. */
  | { type: 'locate-done'; cardId: number; seq: number; result: QuoteLocation }
  /** Esc while locating: drops the running locate; the card and the reading position stay. */
  | { type: 'cancel-locate'; cardId: number }
  /** Manual 重试: reloads the preview and, after a failed locate, resolves again without jumping. */
  | { type: 'retry'; cardId: number }
  /** Pointer left both the quote and the card: closes an unpinned card. */
  | { type: 'leave'; cardId: number }
  /** 关闭, Esc on an idle card, outside click, or a committed navigation. */
  | { type: 'close'; cardId: number }

export const initialQuoteState: QuoteState = { card: null, nextId: 1, nextSeq: 1 }

function sameSource(a: QuoteSource, b: QuoteSource): boolean {
  return (
    a.tabId === b.tabId &&
    a.entryKey === b.entryKey &&
    a.postId === b.postId &&
    quoteHostId(a.reference ?? a.focus) === quoteHostId(b.reference ?? b.focus) &&
    (a.reference ?? a.focus).quoteIndex === (b.reference ?? b.focus).quoteIndex
  )
}

function current(state: QuoteState, cardId: number): QuoteCard | null {
  return state.card !== null && state.card.id === cardId ? state.card : null
}

/** True while `seq` is the running locate of card `cardId`: only then may its result be acted on. */
export function isCurrentLocate(state: QuoteState, cardId: number, seq: number): boolean {
  const locate = current(state, cardId)?.locate ?? null
  return locate !== null && locate.seq === seq && locate.result === null
}

/**
 * Whether the card may start a locate (跳转 / 在新标签打开). Not while one is running, and not after
 * a result that another attempt would only repeat: owner unknown, only the thread known (打开原串 is
 * the separate action), or the server reported the post or thread missing / inaccessible.
 */
export function canLocate(card: QuoteCard): boolean {
  const result = card.locate?.result
  if (card.locate !== null && result === null) return false
  if (result?.status === 'unknown-thread' || result?.status === 'thread-known') return false
  if (result?.status === 'failed' && unavailable(result.error)) return false
  const outcome = card.preview.outcome
  if (outcome?.status === 'failed' && unavailable(outcome.error)) return false
  if (outcome?.status === 'cached' && outcome.networkError !== null && unavailable(outcome.networkError)) return false
  return true
}

function unavailable(error: ReadError): boolean {
  return error.kind === 'not-found' || error.kind === 'permission'
}

/** True while `seq` is the loading preview of card `cardId`. */
export function isCurrentPreview(state: QuoteState, cardId: number, seq: number): boolean {
  const preview = current(state, cardId)?.preview ?? null
  return preview !== null && preview.seq === seq && preview.outcome === null
}

export function quoteReducer(state: QuoteState, action: QuoteAction): QuoteState {
  switch (action.type) {
    case 'open': {
      const card = state.card
      const pinned = action.trigger === 'activate'
      if (card !== null && sameSource(card.source, action.source)) {
        return pinned && !card.pinned ? { ...state, card: { ...card, pinned: true } } : state
      }
      if (card !== null && card.pinned && action.trigger === 'hover') return state
      return {
        card: {
          id: state.nextId,
          source: action.source,
          pinned,
          preview: { seq: state.nextSeq, outcome: null },
          locate: null
        },
        nextId: state.nextId + 1,
        nextSeq: state.nextSeq + 1
      }
    }
    case 'preview-done': {
      if (!isCurrentPreview(state, action.cardId, action.seq) || action.outcome.status === 'cancelled') return state
      const card = state.card as QuoteCard
      return { ...state, card: { ...card, preview: { seq: action.seq, outcome: action.outcome } } }
    }
    case 'locate-start': {
      const card = current(state, action.cardId)
      if (card === null || !canLocate(card)) return state
      return {
        ...state,
        card: {
          ...card,
          pinned: card.pinned || action.intent !== 'resolve',
          locate: { seq: state.nextSeq, intent: action.intent, result: null }
        },
        nextSeq: state.nextSeq + 1
      }
    }
    case 'open-thread-start': {
      const card = current(state, action.cardId)
      const known = card?.locate?.result
      if (card === null || known?.status !== 'thread-known') return state
      return {
        ...state,
        card: { ...card, pinned: true, locate: { seq: state.nextSeq, intent: 'open-thread', result: null, known } },
        nextSeq: state.nextSeq + 1
      }
    }
    case 'locate-done': {
      if (!isCurrentLocate(state, action.cardId, action.seq) || action.result.status === 'cancelled') return state
      const card = state.card as QuoteCard
      return { ...state, card: { ...card, locate: { ...(card.locate as NonNullable<QuoteCard['locate']>), result: action.result } } }
    }
    case 'cancel-locate': {
      const card = current(state, action.cardId)
      if (card === null || card.locate === null || card.locate.result !== null) return state
      // Cancelling 打开原串 goes back to what was known before it, so it can be chosen again.
      const known = card.locate.known
      const locate = known === undefined ? null : { seq: card.locate.seq, intent: 'resolve' as const, result: known }
      return { ...state, card: { ...card, locate } }
    }
    case 'retry': {
      const card = current(state, action.cardId)
      if (card === null) return state
      const relocate = card.locate?.result?.status === 'failed'
      return {
        ...state,
        card: {
          ...card,
          preview: { seq: state.nextSeq, outcome: null },
          locate: relocate ? { seq: state.nextSeq + 1, intent: 'resolve', result: null } : card.locate
        },
        nextSeq: state.nextSeq + 2
      }
    }
    case 'leave': {
      const card = current(state, action.cardId)
      return card === null || card.pinned ? state : { ...state, card: null }
    }
    case 'close':
      return current(state, action.cardId) === null ? state : { ...state, card: null }
  }
}
