import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { Post, ThreadId } from '../../../../shared/forum'
import { OperationScope } from '../../lib/operations'
import { initialThreadState, threadReducer, type ThreadTask } from './threadState'

type PageTask = Exclude<ThreadTask, { type: 'locate' }>

/**
 * Continuous reading of one thread. The owning component is keyed by thread ID: switching threads
 * unmounts this hook and cancels its reads. Within a thread at most one read runs; explicit
 * actions (jump, 开头, 末尾, 刷新) cancel the running read, whose late result is then discarded.
 */
export function useThread(threadId: ThreadId, initialHead: Post | null) {
  const [state, dispatch] = useReducer(threadReducer, initialHead, initialThreadState)
  const scope = useRef(new OperationScope())
  const threadRef = useRef(threadId)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const readPage = useCallback(async (task: PageTask) => {
    const page = task.type === 'initial' ? 1 : task.page
    dispatch({ type: 'start', task })
    const settled = await scope.current.run((operationId) =>
      window.xidao.reading.readThreadPage({ operationId, threadId: threadRef.current, page })
    )
    switch (settled.type) {
      case 'stale':
        return
      case 'cancelled':
        dispatch({ type: 'cancelled' })
        return
      case 'failed':
        dispatch({ type: 'failed', task, failure: settled.failure })
        return
      case 'ok':
        dispatch({ type: 'page-loaded', task, page: settled.data.page, coverage: settled.data.coverage, source: settled.source })
    }
  }, [])

  const locate = useCallback(async () => {
    const task: ThreadTask = { type: 'locate' }
    dispatch({ type: 'start', task })
    const settled = await scope.current.run((operationId) =>
      window.xidao.reading.locateThreadEnd({ operationId, threadId: threadRef.current })
    )
    switch (settled.type) {
      case 'stale':
        return
      case 'cancelled':
        dispatch({ type: 'cancelled' })
        return
      case 'failed':
        dispatch({ type: 'failed', task, failure: settled.failure })
        return
      case 'ok': {
        const result = settled.data
        if (result.status === 'located') {
          dispatch({
            type: 'end-located',
            page: result.lastPage.page,
            endCandidatePage: result.endCandidatePage,
            coverage: result.lastPage.coverage,
            probedPages: result.probedPages,
            source: settled.source
          })
        } else if (result.status === 'interrupted') {
          dispatch({
            type: 'end-interrupted',
            coverage: result.coverage,
            probedPages: result.probedPages,
            failedPage: result.failedPage,
            error: result.error
          })
        } else {
          dispatch({ type: 'end-insufficient', coverage: result.coverage, probedPages: result.probedPages })
        }
      }
    }
  }, [])

  /** Explicit action: supersede whatever is running, then read. */
  const supersede = useCallback(
    (task: ThreadTask) => {
      scope.current.cancelAll()
      void (task.type === 'locate' ? locate() : readPage(task))
    },
    [locate, readPage]
  )

  useEffect(() => {
    const current = scope.current
    void readPage({ type: 'initial' })
    return () => current.cancelAll()
  }, [readPage])

  const lastPage = state.pages.at(-1)
  const firstPage = state.pages[0]
  const canAppend =
    state.task === null && state.error?.task.type !== 'append' && lastPage !== undefined && !lastPage.endCandidate

  /** Automatic next page; never interrupts another read. */
  const appendNext = useCallback(() => {
    const current = stateRef.current
    const last = current.pages.at(-1)
    if (scope.current.busy || current.task !== null || current.error?.task.type === 'append') return
    if (last === undefined || last.endCandidate) return
    void readPage({ type: 'append', page: last.page + 1 })
  }, [readPage])

  const prependPrevious = useCallback(() => {
    const first = stateRef.current.pages[0]
    if (first === undefined || first.page <= 1) return
    supersede({ type: 'prepend', page: first.page - 1 })
  }, [supersede])

  /** Re-reads the last loaded page (including an end-candidate page) and merges it. */
  const refresh = useCallback(() => {
    const last = stateRef.current.pages.at(-1)
    supersede(last === undefined ? { type: 'initial' } : { type: 'refresh', page: last.page })
  }, [supersede])

  const jump = useCallback((page: number) => supersede({ type: 'jump', page }), [supersede])
  const locateEnd = useCallback(() => supersede({ type: 'locate' }), [supersede])

  const cancel = useCallback(() => {
    scope.current.cancelAll()
    dispatch({ type: 'cancelled' })
  }, [])

  const retry = useCallback(() => {
    const error = stateRef.current.error
    if (error !== null) supersede(error.task)
  }, [supersede])

  return { state, firstPage, lastPage, canAppend, appendNext, prependPrevious, refresh, jump, locateEnd, cancel, retry }
}
