import type { ReadError, ThreadPageResult } from '../../../../shared/api'
import { comparePostIds, type Post, type ThreadCoverage, type ThreadPage } from '../../../../shared/forum'
import { threadTotalPages } from '../../../../shared/threadPages'
import type { Failure, Settled, Source } from '../../lib/operations'

/** One observed page inside the loaded range. */
export interface LoadedPage {
  page: number
  replies: Post[]
  skippedItems: number
  /** Valid empty page: a candidate for the end of the thread, never proof. */
  endCandidate: boolean
  source: Source
}

export type ThreadTask =
  /** First range of a reader: page 1 unless resuming or targeting another page. */
  | { type: 'initial'; page?: number }
  | { type: 'append'; page: number }
  | { type: 'prepend'; page: number }
  /** 刷新: one run over several pages, see `refreshThread`. */
  | { type: 'refresh' }
  | { type: 'jump'; page: number }
  | { type: 'locate' }

export type EndProbe =
  | { status: 'located' | 'insufficient'; probedPages: number[] }
  /** A probe failed after earlier probes succeeded; what was observed is in `coverage`. */
  | { status: 'interrupted'; probedPages: number[]; failedPage: number; error: ReadError }

export interface ThreadState {
  head: Post | null
  /** Contiguous ascending pages currently shown. */
  pages: LoadedPage[]
  coverage: ThreadCoverage | null
  /** The single read in flight for this thread. */
  task: ThreadTask | null
  error: { task: ThreadTask; failure: Failure } | null
  /** Result of the last 末尾 probe. */
  endProbe: EndProbe | null
  /** A lower page was returned; retain the real mode-specific total and show the readable limit. */
  pageCap: number | null
  /**
   * Bumped whenever the loaded range is replaced (first load, jump, located end), so the reader
   * positions its reading line for the new range.
   */
  rangeVersion: number
}

export type ThreadAction =
  | { type: 'start'; task: ThreadTask }
  | {
      type: 'page-loaded'
      task: Exclude<ThreadTask, { type: 'locate' }>
      page: ThreadPage
      coverage: ThreadCoverage
      source: Source
      /** A refresh reads on after this page: its task keeps running. */
      continues?: boolean
    }
  | {
      type: 'end-located'
      page: ThreadPage
      endCandidatePage: number | null
      coverage: ThreadCoverage
      probedPages: number[]
      source: Source
    }
  | { type: 'end-insufficient'; coverage: ThreadCoverage; probedPages: number[] }
  | { type: 'end-interrupted'; coverage: ThreadCoverage; probedPages: number[]; failedPage: number; error: ReadError }
  | { type: 'failed'; task: ThreadTask; failure: Failure }
  | { type: 'page-cap'; highestReadablePage: number }
  | { type: 'cap-loaded'; highestReadablePage: number; page: ThreadPage; coverage: ThreadCoverage; source: Source }
  | { type: 'cancelled' }
  /** Restore the loaded range retained for a send's temporary reading mode. */
  | { type: 'restore-mode'; state: ThreadState }

export function initialThreadState(head: Post | null): ThreadState {
  return { head, pages: [], coverage: null, task: null, error: null, endProbe: null, pageCap: null, rangeVersion: 0 }
}

/**
 * The main post belongs to page 1: a range opened further in (末尾, a page jump, a resumed page)
 * shows it only once page 1 has been loaded into the range.
 */
export function showsHead(state: ThreadState): boolean {
  return state.head !== null && state.pages[0]?.page === 1
}

/**
 * An automatic read of the page before the range may start: the range starts after page 1, nothing
 * is running and the last such read did not fail (a failure waits for an explicit 重试).
 */
export function canPrependPrevious(state: ThreadState): boolean {
  const first = state.pages[0]
  return first !== undefined && first.page > 1 && state.task === null && state.error?.task.type !== 'prepend'
}

/**
 * The loaded range reaches the end of the thread as far as it is known: its last page is an empty
 * end candidate, or the mode's reported reply count puts no page after it.
 */
export function reachesEnd(state: ThreadState): boolean {
  const last = state.pages.at(-1)
  if (last === undefined) return false
  const total = threadTotalPages(state.coverage?.reportedReplyCount ?? null)
  return last.endCandidate || (total !== null && last.page >= total)
}

function toLoaded(page: ThreadPage, source: Source): LoadedPage {
  return { page: page.page, replies: page.replies, skippedItems: page.skippedItems, endCandidate: page.endCandidate, source }
}

/** Re-read of an already shown page: keep every reply seen so far, ordered by post ID. */
function mergePage(previous: LoadedPage, next: LoadedPage): LoadedPage {
  const byId = new Map<string, Post>()
  for (const reply of previous.replies) byId.set(reply.id, reply)
  for (const reply of next.replies) byId.set(reply.id, reply)
  const replies = [...byId.values()].sort((a, b) => comparePostIds(a.id, b.id))
  return { ...next, replies, endCandidate: next.endCandidate && replies.length === 0 }
}

function placePage(pages: LoadedPage[], task: Exclude<ThreadTask, { type: 'locate' }>, loaded: LoadedPage): LoadedPage[] {
  switch (task.type) {
    case 'initial':
    case 'jump':
      return [loaded]
    case 'append':
      return pages.some((item) => item.page === loaded.page) ? pages : [...pages, loaded]
    case 'prepend':
      return pages.some((item) => item.page === loaded.page) ? pages : [loaded, ...pages]
    case 'refresh': {
      const index = pages.findIndex((item) => item.page === loaded.page)
      if (index < 0) return [...pages, loaded]
      const merged = pages.slice()
      merged[index] = mergePage(pages[index] as LoadedPage, loaded)
      return merged
    }
  }
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'restore-mode':
      return { ...action.state, task: null, rangeVersion: state.rangeVersion + 1 }
    case 'start':
      return {
        ...state,
        task: action.task,
        error: null,
        endProbe: action.task.type === 'locate' || action.task.type === 'jump' ? null : state.endProbe
      }
    case 'cancelled':
      return { ...state, task: null }
    case 'failed':
      return { ...state, task: null, error: { task: action.task, failure: action.failure } }
    case 'page-cap':
      return { ...state, task: null, error: null, pageCap: action.highestReadablePage }
    case 'cap-loaded':
      return {
        ...state,
        head: action.page.head,
        pages: [toLoaded(action.page, action.source)],
        coverage: action.coverage,
        task: null,
        error: null,
        endProbe: null,
        pageCap: action.highestReadablePage,
        rangeVersion: state.rangeVersion + 1
      }
    case 'page-loaded': {
      const replaces = action.task.type === 'initial' || action.task.type === 'jump'
      return {
        ...state,
        head: action.page.head,
        coverage: action.coverage,
        pages: placePage(state.pages, action.task, toLoaded(action.page, action.source)),
        task: action.continues === true ? state.task : null,
        error: null,
        pageCap: null,
        rangeVersion: replaces ? state.rangeVersion + 1 : state.rangeVersion
      }
    }
    case 'end-located': {
      // The last page with replies (or an empty page 1, which is itself the end candidate) and,
      // when it lies beyond that page, the observed empty end-candidate page.
      const pages = [toLoaded(action.page, action.source)]
      if (action.endCandidatePage !== null && action.endCandidatePage > action.page.page) {
        pages.push({ page: action.endCandidatePage, replies: [], skippedItems: 0, endCandidate: true, source: action.source })
      }
      return {
        ...state,
        head: action.page.head,
        coverage: action.coverage,
        pages,
        task: null,
        error: null,
        pageCap: null,
        endProbe: { status: 'located', probedPages: action.probedPages },
        rangeVersion: state.rangeVersion + 1
      }
    }
    case 'end-insufficient':
      return {
        ...state,
        coverage: action.coverage,
        task: null,
        endProbe: { status: 'insufficient', probedPages: action.probedPages }
      }
    case 'end-interrupted':
      return {
        ...state,
        coverage: action.coverage,
        task: null,
        endProbe: { status: 'interrupted', probedPages: action.probedPages, failedPage: action.failedPage, error: action.error }
      }
  }
}

/** Reads one page of the thread for a refresh, through the reader's operation scope. */
export type RefreshRead = (page: number) => Promise<Settled<ThreadPageResult>>

/**
 * 刷新 of a non-empty range, as one `refresh` task: re-reads from the last page with replies (an
 * empty end candidate seen earlier never starts it, a reply may since have landed on the page
 * before) and, when the range reaches the end of the thread, the pages after it until an empty one
 * (a reply may have opened a new page). A range that stops before the end re-reads only its last
 * page; the automatic next page still follows the reader down, so the rest is never prefetched.
 * A page served from the cache ends the run: the network read failed, and that page shows why.
 */
export async function refreshThread(state: ThreadState, read: RefreshRead, dispatch: (action: ThreadAction) => void): Promise<void> {
  const start = state.pages.findLast((page) => page.replies.length > 0) ?? state.pages[0]
  if (start === undefined) return
  const onward = reachesEnd(state)
  const task: ThreadTask = { type: 'refresh' }
  dispatch({ type: 'start', task })
  for (let page = start.page; ; page += 1) {
    const settled = await read(page)
    switch (settled.type) {
      case 'stale':
        return
      case 'cancelled':
        dispatch({ type: 'cancelled' })
        return
      case 'failed': {
        const error = settled.failure.type === 'read' ? settled.failure.error : null
        if (error?.kind === 'page-cap' && error.highestReadablePage !== undefined) dispatch({ type: 'page-cap', highestReadablePage: error.highestReadablePage })
        else dispatch({ type: 'failed', task, failure: settled.failure })
        return
      }
      case 'ok': {
        const { page: loaded, coverage } = settled.data
        const continues = onward && settled.source.status === 'fresh' && !loaded.endCandidate
        dispatch({ type: 'page-loaded', task, page: loaded, coverage, source: settled.source, continues })
        if (!continues) return
      }
    }
  }
}
