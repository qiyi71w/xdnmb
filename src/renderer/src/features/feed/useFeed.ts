import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { FeedPage, FeedRef } from '../../../../shared/forum'
import { OperationScope, type Failure, type Source } from '../../lib/operations'
import { feedReducer, initialFeedState, type FeedActivity, type FeedState } from './feedState'

/** A remembered list with loaded pages resumes as it was (reads in flight were cancelled). */
function resumeState(remembered: FeedState | null): FeedState {
  return remembered !== null && remembered.pages.length > 0 ? { ...remembered, activity: 'idle' } : initialFeedState
}

/**
 * Thread list of one feed. The owning component is keyed by feed, so the feed is fixed for the
 * hook's lifetime; switching feeds unmounts it and cancels its reads, and late results are
 * discarded by the operation scope. `remembered` (the same entry's list before it was unmounted)
 * is resumed without reading page 1 again. Otherwise `restorePages` (a list restored from the last
 * quit) reads pages 1..n again, stopping at an empty page or a failure, and shows them at once.
 */
export function useFeed(feed: FeedRef, maxPage: number | null, remembered: FeedState | null, restorePages: number | null) {
  const [state, dispatch] = useReducer(feedReducer, remembered, resumeState)
  const resumed = useRef(state !== initialFeedState)
  /** Pages still to restore: until a restore shows pages, or a refresh replaces it. */
  const restoring = useRef(state === initialFeedState ? restorePages : null)
  /** Token of the restore in flight; a refresh or a newer restore supersedes it. */
  const restoreRun = useRef<object | null>(null)
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

  const restore = useCallback(async (pages: number) => {
    const run = {}
    restoreRun.current = run
    dispatch({ type: 'start', activity: 'initial' })
    const loaded: Array<{ page: FeedPage; source: Source }> = []
    let failure: { page: number; failure: Failure } | null = null
    for (let page = 1; page <= pages; page++) {
      const settled = await scope.current.run((operationId) =>
        window.xidao.reading.readFeedPage({ operationId, feed: feedRef.current, page })
      )
      if (settled.type === 'stale' || restoreRun.current !== run) return
      if (settled.type === 'cancelled') break
      if (settled.type === 'failed') {
        failure = { page, failure: settled.failure }
        break
      }
      loaded.push({ page: settled.data, source: settled.source })
      if (settled.data.threads.length === 0 && settled.data.skippedItems === 0) break
    }
    restoreRun.current = null
    if (loaded.length > 0) restoring.current = null
    dispatch({ type: 'restored', pages: loaded, failure })
  }, [])

  useEffect(() => {
    const current = scope.current
    if (!resumed.current) {
      if (restoring.current !== null) void restore(restoring.current)
      else void read('initial', 1)
    }
    return () => current.cancelAll()
  }, [read, restore])

  const lastPage = state.pages.at(-1)?.page ?? 0
  const hasMore = state.pages.length > 0 && state.reachedEmptyPage === null && (maxPage === null || lastPage < maxPage)
  const canAppend = hasMore && state.activity === 'idle' && state.error?.action !== 'append'

  const loadMore = useCallback(() => {
    const current = stateRef.current
    const nextPage = (current.pages.at(-1)?.page ?? 0) + 1
    if (scope.current.busy || current.activity !== 'idle' || current.error?.action === 'append' || current.pages.length === 0) return
    void read('append', nextPage)
  }, [read])

  /**
   * Reloads page 1 and replaces the list; anything else still loading (a restore too) is
   * superseded. A refresh already running is left alone, so no entry starts a second one.
   */
  const refresh = useCallback(() => {
    if (stateRef.current.activity === 'refresh') return
    restoring.current = null
    restoreRun.current = null
    scope.current.cancelAll()
    void read('refresh', 1)
  }, [read])

  /** A restore that could not read page 1 is tried again whole. */
  const retry = useCallback(() => {
    const error = stateRef.current.error
    if (error === null) return
    scope.current.cancelAll()
    if (error.action === 'initial' && restoring.current !== null) void restore(restoring.current)
    else void read(error.action, error.page)
  }, [read, restore])

  return { state, hasMore, canAppend, loadMore, refresh, retry }
}
