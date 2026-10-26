import { comparePostIds, type PostId, type ThreadCoverage, type ThreadId } from '../../shared/forum'
import type { ThreadReadingState } from '../../shared/reading'
import { computeCoverage } from './coverage'

export interface EndObservation {
  /** Earlier fetch time of the two pages that show the end. */
  observedAt: string
  /** Highest reply ID then (the main post ID when page 1 was empty). */
  boundPostId: PostId
}

/**
 * The thread's end as shown by stored all-mode pages: the lowest end-candidate page and the page
 * before it (or page 1 itself being empty). Whichever of the two was fetched first, every reply
 * existing at that time sat on those pages, so its ID is at most the returned bound. `null` when the
 * pages do not show an end.
 */
export function endObservation(threadId: ThreadId, coverage: ThreadCoverage): EndObservation | null {
  const end = coverage.endCandidatePage
  if (end === null) return null
  const endPage = coverage.pages.find((page) => page.page === end)
  if (endPage === undefined) return null
  if (end === 1) return { observedAt: endPage.fetchedAt, boundPostId: threadId }
  const last = coverage.pages.find((page) => page.page === end - 1)
  if (last === undefined || last.skippedItems > 0 || last.replyIds.length === 0) return null
  const observedAt = Date.parse(last.fetchedAt) <= Date.parse(endPage.fetchedAt) ? last.fetchedAt : endPage.fetchedAt
  return { observedAt, boundPostId: [...last.replyIds].sort(comparePostIds).at(-1) as PostId }
}

/** Reading state when storage is unavailable: nothing saved, nothing observed. */
export function emptyReadingState(threadId: ThreadId): ThreadReadingState {
  return {
    threadId,
    mode: 'all',
    positions: { all: null, po: null },
    coverage: { all: computeCoverage(threadId, 'all', [], null), po: computeCoverage(threadId, 'po', [], null) }
  }
}
