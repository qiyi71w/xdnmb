import type { ReadError } from '../../../../shared/api'
import { comparePostIds, type Post, type ThreadCoverage, type ThreadPage } from '../../../../shared/forum'
import type { Failure, Source } from '../../lib/operations'

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
  | { type: 'refresh'; page: number }
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
  | { type: 'page-loaded'; task: Exclude<ThreadTask, { type: 'locate' }>; page: ThreadPage; coverage: ThreadCoverage; source: Source }
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
        task: null,
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
