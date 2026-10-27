import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ReadError, ThreadEndResult, ThreadPageResult } from '../../../../shared/api'
import type { Post, ReadingMode, ThreadId } from '../../../../shared/forum'
import { threadTotalPages } from '../../../../shared/threadPages'
import { OperationScope } from '../../lib/operations'
import { canPrependPrevious, initialThreadState, refreshThread, threadReducer, type ThreadTask } from './threadState'

type PageTask = Exclude<ThreadTask, { type: 'locate' } | { type: 'refresh' }>

/**
 * Continuous reading of one thread in one mode. The owning component is keyed by thread and mode:
 * switching either unmounts this hook and cancels its reads. Within a reader at most one read runs;
 * explicit actions (jump, 开头, 末尾, 刷新) cancel the running read, whose late result is
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

  /** One page of the thread in this reader's mode, read only once the reader's content is held. */
  const readThreadPage = useCallback(
    (page: number) =>
      scope.current.run<ThreadPageResult>(async (operationId) => {
        await holdRef.current()
        if (!scope.current.isActive(operationId)) return { status: 'cancelled' }
        return window.xidao.reading.readThreadPage({ operationId, threadId: threadRef.current, mode: modeRef.current, page })
      }),
    []
  )

  const showCap = useCallback(async (highestReadablePage: number, task: ThreadTask, observed: ReadError['readablePage']) => {
    if (task.type !== 'locate' && task.type !== 'jump' && task.type !== 'initial') {
      dispatch({ type: 'page-cap', highestReadablePage })
      return
    }
    const settled = observed === undefined
      ? await readThreadPage(highestReadablePage)
      : { type: 'ok' as const, data: observed.data, source: { status: 'fresh' as const, fetchedAt: observed.fetchedAt, saved: observed.saved } }
    switch (settled.type) {
      case 'stale':
        return
      case 'cancelled':
        dispatch({ type: 'cancelled' })
        return
      case 'failed':
        dispatch({ type: 'page-cap', highestReadablePage })
        dispatch({ type: 'failed', task, failure: settled.failure })
        return
      case 'ok':
        dispatch({ type: 'cap-loaded', highestReadablePage, page: settled.data.page, coverage: settled.data.coverage, source: settled.source })
    }
  }, [readThreadPage])

  const readPage = useCallback(async (task: PageTask) => {
    const page = task.type === 'initial' ? (task.page ?? 1) : task.page
    dispatch({ type: 'start', task })
    const settled = await readThreadPage(page)
    switch (settled.type) {
      case 'stale':
        return
      case 'cancelled':
        dispatch({ type: 'cancelled' })
        return
      case 'failed':
        if (settled.failure.type === 'read' && settled.failure.error.kind === 'page-cap' && settled.failure.error.highestReadablePage !== undefined) {
          await showCap(settled.failure.error.highestReadablePage, task, settled.failure.error.readablePage)
          return
        }
        dispatch({ type: 'failed', task, failure: settled.failure })
        return
      case 'ok':
        dispatch({ type: 'page-loaded', task, page: settled.data.page, coverage: settled.data.coverage, source: settled.source })
    }
  }, [showCap, readThreadPage])

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
        if (settled.failure.type === 'read' && settled.failure.error.kind === 'page-cap' && settled.failure.error.highestReadablePage !== undefined) {
          await showCap(settled.failure.error.highestReadablePage, task, settled.failure.error.readablePage)
          return
        }
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
  }, [showCap])

  /** Explicit action: supersede whatever is running, then read. */
  const supersede = useCallback(
    (task: ThreadTask) => {
      scope.current.cancelAll()
      if (task.type === 'locate') void locate()
      else if (task.type === 'refresh') void refreshThread(stateRef.current, readThreadPage, dispatch)
      else void readPage(task)
    },
    [locate, readPage, readThreadPage]
  )

  useEffect(() => {
    const current = scope.current
    void readPage({ type: 'initial', page: firstPageRef.current })
    return () => current.cancelAll()
  }, [readPage])

  const lastPage = state.pages.at(-1)
  const loadedFirst = state.pages[0]
  const canAppend =
    state.task === null && state.pageCap === null && state.error?.task.type !== 'append' && lastPage !== undefined && !lastPage.endCandidate

  /** Automatic next page; never interrupts another read. */
  const appendNext = useCallback(() => {
    const current = stateRef.current
    const last = current.pages.at(-1)
    if (scope.current.busy || current.task !== null || current.pageCap !== null || current.error?.task.type === 'append') return
    if (last === undefined || last.endCandidate) return
    void readPage({ type: 'append', page: last.page + 1 })
  }, [readPage])

  /** Automatic previous page (scrolling up near the top); never interrupts another read. */
  const prependAuto = useCallback(() => {
    const current = stateRef.current
    const first = current.pages[0]
    if (scope.current.busy || !canPrependPrevious(current) || first === undefined) return
    void readPage({ type: 'prepend', page: first.page - 1 })
  }, [readPage])

  /**
   * 刷新 (end of the thread, 更多 › 刷新, Ctrl/Cmd+R); an empty reader loads its first page again.
   * A refresh already running is left alone: the entries never start a second one.
   */
  const refresh = useCallback(() => {
    const state = stateRef.current
    if (state.task?.type === 'refresh') return
    supersede(state.pages.length === 0 ? { type: 'initial', page: firstPageRef.current } : { type: 'refresh' })
  }, [supersede])

  const jump = useCallback((page: number) => {
    const total = threadTotalPages(stateRef.current.coverage?.reportedReplyCount ?? null)
    if (!Number.isSafeInteger(page) || page < 1 || (total !== null && page > total)) return
    supersede({ type: 'jump', page })
  }, [supersede])
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
    canPrepend: canPrependPrevious(state),
    appendNext,
    prependAuto,
    refresh,
    jump,
    locateEnd,
    cancel,
    retry
  }
}
