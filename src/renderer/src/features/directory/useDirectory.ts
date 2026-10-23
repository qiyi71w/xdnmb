import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { BoardDirectory } from '../../../../shared/forum'
import type { DirectoryStrategy } from '../../../../shared/api'
import { OperationScope, type Failure, type Source } from '../../lib/operations'

export interface DirectoryState {
  directory: BoardDirectory | null
  source: Source | null
  /** Foreground load with nothing shown yet. */
  loading: boolean
  /** Foreground failure with nothing to show. */
  failure: Failure | null
  /** Background refresh of a cached directory is running. */
  refreshing: boolean
  /** Background refresh failed; the cached directory stays. */
  refreshFailure: Failure | null
}

type Action =
  | { type: 'load-start' }
  | { type: 'loaded'; directory: BoardDirectory; source: Source }
  | { type: 'load-failed'; failure: Failure }
  | { type: 'load-cancelled' }
  | { type: 'refresh-start' }
  | { type: 'refreshed'; directory: BoardDirectory; source: Source }
  | { type: 'refresh-failed'; failure: Failure }
  | { type: 'refresh-done' }

const initialState: DirectoryState = {
  directory: null,
  source: null,
  loading: false,
  failure: null,
  refreshing: false,
  refreshFailure: null
}

function reducer(state: DirectoryState, action: Action): DirectoryState {
  switch (action.type) {
    case 'load-start':
      return { ...state, loading: true, failure: null }
    case 'loaded':
      return { ...state, loading: false, failure: null, directory: action.directory, source: action.source }
    case 'load-failed':
      return { ...state, loading: false, failure: state.directory === null ? action.failure : null }
    case 'load-cancelled':
      return { ...state, loading: false }
    case 'refresh-start':
      return { ...state, refreshing: true, refreshFailure: null }
    case 'refreshed':
      return { ...state, refreshing: false, directory: action.directory, source: action.source }
    case 'refresh-failed':
      return { ...state, refreshing: false, refreshFailure: action.failure }
    case 'refresh-done':
      return { ...state, refreshing: false }
  }
}

/**
 * Cache-first directory: show the stored directory at once, then refresh it in the background
 * lane and swap in the fresh copy when it arrives.
 */
export function useDirectory() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const scope = useRef(new OperationScope())

  useEffect(() => {
    const current = scope.current
    return () => current.cancelAll()
  }, [])

  const backgroundRefresh = useCallback(async () => {
    dispatch({ type: 'refresh-start' })
    const settled = await scope.current.run((operationId) =>
      window.xidao.reading.loadDirectory({ operationId, strategy: 'background-refresh' })
    )
    if (settled.type === 'stale') return
    if (settled.type === 'ok') {
      // Background refresh falls back to the stored copy; only fresh data is a real update.
      if (settled.source.status === 'fresh') dispatch({ type: 'refreshed', directory: settled.data, source: settled.source })
      else if (settled.source.networkError !== null)
        dispatch({ type: 'refresh-failed', failure: { type: 'read', error: settled.source.networkError } })
      else dispatch({ type: 'refresh-done' })
    } else if (settled.type === 'failed') dispatch({ type: 'refresh-failed', failure: settled.failure })
    else dispatch({ type: 'refresh-done' })
  }, [])

  const load = useCallback(
    async (strategy: DirectoryStrategy) => {
      scope.current.cancelAll()
      dispatch({ type: 'load-start' })
      const settled = await scope.current.run((operationId) => window.xidao.reading.loadDirectory({ operationId, strategy }))
      switch (settled.type) {
        case 'stale':
          return
        case 'cancelled':
          dispatch({ type: 'load-cancelled' })
          return
        case 'failed':
          dispatch({ type: 'load-failed', failure: settled.failure })
          return
        case 'ok':
          dispatch({ type: 'loaded', directory: settled.data, source: settled.source })
          if (strategy === 'cache-first' && settled.source.status === 'cached') void backgroundRefresh()
      }
    },
    [backgroundRefresh]
  )

  const start = useCallback(() => void load('cache-first'), [load])
  const retry = useCallback(() => void load('refresh'), [load])

  return { state, start, retry }
}
