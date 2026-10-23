import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { FeedRef } from '../../../../shared/forum'
import { OperationScope } from '../../lib/operations'
import { feedReducer, initialFeedState, type FeedActivity } from './feedState'

/**
 * Thread list of one feed. The owning component is keyed by feed, so the feed is fixed for the
 * hook's lifetime; switching feeds unmounts it and cancels its reads, and late results are
 * discarded by the operation scope.
 */
export function useFeed(feed: FeedRef, maxPage: number | null) {
  const [state, dispatch] = useReducer(feedReducer, initialFeedState)
  const scope = useRef(new OperationScope())
  const feedRef = useRef(feed)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const read = useCallback(
    async (activity: Exclude<FeedActivity, 'idle'>, page: number) => {
      dispatch({ type: 'start', activity })
      const settled = await scope.current.run((operationId) =>
        window.xidao.reading.readFeedPage({ operationId, feed: feedRef.current, page })
      )
      switch (settled.type) {
        case 'stale':
          return
        case 'cancelled':
          dispatch({ type: 'idle' })
          return
        case 'failed':
          dispatch({ type: 'failed', action: activity, page, failure: settled.failure })
          return
        case 'ok':
          dispatch({ type: 'loaded', mode: activity === 'append' ? 'append' : 'replace', page: settled.data, source: settled.source })
      }
    },
    []
  )

  useEffect(() => {
    const current = scope.current
    void read('initial', 1)
    return () => current.cancelAll()
  }, [read])

  const lastPage = state.pages.at(-1)?.page ?? 0
  const hasMore = state.pages.length > 0 && state.reachedEmptyPage === null && (maxPage === null || lastPage < maxPage)
  const canAppend = hasMore && state.activity === 'idle' && state.error?.action !== 'append'

  const loadMore = useCallback(() => {
    const current = stateRef.current
    const nextPage = (current.pages.at(-1)?.page ?? 0) + 1
    if (scope.current.busy || current.activity !== 'idle' || current.error?.action === 'append' || current.pages.length === 0) return
    void read('append', nextPage)
  }, [read])

  /** Reloads page 1 and replaces the list; anything still loading is superseded. */
  const refresh = useCallback(() => {
    scope.current.cancelAll()
    void read('refresh', 1)
  }, [read])

  const retry = useCallback(() => {
    const error = stateRef.current.error
    if (error === null) return
    scope.current.cancelAll()
    void read(error.action, error.page)
  }, [read])

  return { state, hasMore, canAppend, loadMore, refresh, retry }
}
