import type { FeedPage, ThreadSummary } from '../../../../shared/forum'
import type { Failure, Source } from '../../lib/operations'

export interface FeedPageRecord {
  page: number
  source: Source
  skippedItems: number
  /** Index in `threads` where this page's new threads begin. */
  startIndex: number
}

export type FeedActivity = 'idle' | 'initial' | 'append' | 'refresh'

export interface FeedState {
  threads: ThreadSummary[]
  pages: FeedPageRecord[]
  activity: FeedActivity
  /** Failure of the last action; `initial` failures have nothing else to show. */
  error: { action: Exclude<FeedActivity, 'idle'>; page: number; failure: Failure } | null
  /** The last read page held no threads at all: stop loading more. */
  reachedEmptyPage: number | null
}

export type FeedAction =
  | { type: 'start'; activity: Exclude<FeedActivity, 'idle'> }
  | { type: 'loaded'; mode: 'replace' | 'append'; page: FeedPage; source: Source }
  | { type: 'failed'; action: Exclude<FeedActivity, 'idle'>; page: number; failure: Failure }
  | { type: 'idle' }

export const initialFeedState: FeedState = {
  threads: [],
  pages: [],
  activity: 'initial',
  error: null,
  reachedEmptyPage: null
}

function dedupe(threads: readonly ThreadSummary[], seen: Set<string>): ThreadSummary[] {
  const result: ThreadSummary[] = []
  for (const thread of threads) {
    if (seen.has(thread.head.id)) continue
    seen.add(thread.head.id)
    result.push(thread)
  }
  return result
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'start':
      return { ...state, activity: action.activity, error: null }
    case 'idle':
      return { ...state, activity: 'idle' }
    case 'failed':
      return { ...state, activity: 'idle', error: { action: action.action, page: action.page, failure: action.failure } }
    case 'loaded': {
      const empty = action.page.threads.length === 0 && action.page.skippedItems === 0
      if (action.mode === 'replace') {
        return {
          threads: dedupe(action.page.threads, new Set()),
          pages: [{ page: action.page.page, source: action.source, skippedItems: action.page.skippedItems, startIndex: 0 }],
          activity: 'idle',
          error: null,
          reachedEmptyPage: empty ? action.page.page : null
        }
      }
      const seen = new Set(state.threads.map((thread) => thread.head.id))
      return {
        threads: [...state.threads, ...dedupe(action.page.threads, seen)],
        pages: [
          ...state.pages.filter((item) => item.page !== action.page.page),
          {
            page: action.page.page,
            source: action.source,
            skippedItems: action.page.skippedItems,
            startIndex: state.threads.length
          }
        ],
        activity: 'idle',
        error: null,
        reachedEmptyPage: empty ? action.page.page : null
      }
    }
  }
}
