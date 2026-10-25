import type { CoveragePage, ReadingMode, ThreadCoverage, ThreadId, ThreadPage } from '../../shared/forum'
import { pageCapFor } from '../../shared/threadPages'
import { ForumReadError } from '../forum/contract'

/** Check before writing posts, page relations or end observations (including unsaved UI fallbacks). */
export function assertReadablePage(page: ThreadPage, coverage: ThreadCoverage): void {
  const highestReadablePage = pageCapFor(page, coverage.pages)
  if (highestReadablePage !== null) {
    throw new ForumReadError({ kind: 'page-cap', detail: 'shape', highestReadablePage })
  }
}

export function computeCoverage(
  threadId: ThreadId,
  mode: ReadingMode,
  pages: readonly CoveragePage[],
  reportedReplyCount: number | null
): ThreadCoverage {
  const sortedPages = [...pages].sort((left, right) => left.page - right.page)
  const observed = new Map(sortedPages.map((page) => [page.page, page]))
  const gaps: number[] = []
  const maxObserved = sortedPages.at(-1)?.page ?? 0
  for (let page = 1; page <= maxObserved; page += 1) {
    if (!observed.has(page)) gaps.push(page)
  }
  const endCandidatePage = sortedPages.find((page) => page.endCandidate)?.page ?? null
  const obtainedReplyCount = new Set(sortedPages.flatMap((page) => page.replyIds)).size
  let countMismatch: boolean | null = null
  if (endCandidatePage !== null && reportedReplyCount !== null) {
    let contiguous = true
    for (let page = 1; page <= endCandidatePage; page += 1) {
      if (observed.get(page)?.skippedItems !== 0) {
        contiguous = false
        break
      }
    }
    if (contiguous) countMismatch = reportedReplyCount !== obtainedReplyCount
  }
  return {
    threadId,
    mode,
    pages: sortedPages,
    gaps,
    endCandidatePage,
    reportedReplyCount,
    obtainedReplyCount,
    countMismatch
  }
}
