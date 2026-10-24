import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ThreadEndResult, ThreadPageResult } from '../../../../shared/api'
import type { Post, ReadingMode, ThreadId } from '../../../../shared/forum'
import { OperationScope } from '../../lib/operations'
import { initialThreadState, threadReducer, type ThreadTask } from './threadState'

type PageTask = Exclude<ThreadTask, { type: 'locate' }>

/**
 * Continuous reading of one thread in one mode. The owning component is keyed by thread and mode:
 * switching either unmounts this hook and cancels its reads. Within a reader at most one read runs;
 * explicit actions (jump, 开头, 末尾, 首条未读, 刷新) cancel the running read, whose late result is
 * then discarded. `firstPage` is the page loaded first (resume, target or page 1).
 *
 * `hold` protects the reader's content from cache eviction; every read waits for it first, so a
 * page is never fetched for an unheld reader (a cache limit of 0 would evict it at once).
 */
export function useThread(threadId: ThreadId, mode: ReadingMode, initialHead: Post | null, firstPage: number, hold: () => Promise<void>) {
  const [state, dispatch] = useReducer(threadReducer, initialHead, initialThreadState)
  const scope = useRef(new OperationScope())
  const threadRef = useRef(threadId)
  const modeRef = useRef(mode)
  const firstPageRef = useRef(firstPage)
  const stateRef = useRef(state)
  const holdRef = useRef(hold)
  useEffect(() => {
    stateRef.current = state
    holdRef.current = hold
  })

  const readPage = useCallback(async (task: PageTask) => {
    const page = task.type === 'initial' ? (task.page ?? 1) : task.page
    dispatch({ type: 'start', task })
    const settled = await scope.current.run<ThreadPageResult>(async (operationId) => {
      await holdRef.current()
      if (!scope.current.isActive(operationId)) return { status: 'cancelled' }
      return window.xidao.reading.readThreadPage({ operationId, threadId: threadRef.current, mode: modeRef.current, page })
    })
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
    const settled = await scope.current.run<ThreadEndResult>(async (operationId) => {
      await holdRef.current()
      if (!scope.current.isActive(operationId)) return { status: 'cancelled' }
      return window.xidao.reading.locateThreadEnd({ operationId, threadId: threadRef.current, mode: modeRef.current })
    })
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
    void readPage({ type: 'initial', page: firstPageRef.current })
    return () => current.cancelAll()
  }, [readPage])

  const lastPage = state.pages.at(-1)
  const loadedFirst = state.pages[0]
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
    supersede(last === undefined ? { type: 'initial', page: firstPageRef.current } : { type: 'refresh', page: last.page })
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

  return {
    state,
    firstPage: loadedFirst,
    lastPage,
    canAppend,
    appendNext,
    prependPrevious,
    refresh,
    jump,
    locateEnd,
    cancel,
    retry
  }
}
