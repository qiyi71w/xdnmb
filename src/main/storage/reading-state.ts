import { comparePostIds, type PostId, type ReadingMode, type ThreadCoverage, type ThreadId } from '../../shared/forum'
import type { AttentionSource, SavedPosition, ThreadReadingState, UnreadPost } from '../../shared/reading'
import { computeCoverage } from './coverage'

export interface AttentionRecord {
  startedAt: string
  source: AttentionSource
  watermarkPostId: PostId | null
  boundaryPostId: PostId | null
}

/**
 * Boundary for replies provably posted after `startedAt`: the thread's highest reply ID when its
 * end was first seen after the start. Needs the lowest end-candidate page and the page before it
 * (or page 1 itself being empty) to be observed no earlier than the start; every reply existing at
 * that time sat on those pages, so anything above the returned ID came later. `null` otherwise.
 */
export function boundaryFromCoverage(threadId: ThreadId, coverage: ThreadCoverage, startedAt: string): PostId | null {
  const end = coverage.endCandidatePage
  if (end === null) return null
  const after = (fetchedAt: string) => Date.parse(fetchedAt) >= Date.parse(startedAt)
  const endPage = coverage.pages.find((page) => page.page === end)
  if (endPage === undefined || !after(endPage.fetchedAt)) return null
  if (end === 1) return threadId
  const last = coverage.pages.find((page) => page.page === end - 1)
  if (last === undefined || !after(last.fetchedAt) || last.skippedItems > 0 || last.replyIds.length === 0) return null
  return [...last.replyIds].sort(comparePostIds).at(-1) ?? null
}

const MODES: readonly ReadingMode[] = ['all', 'po']

/**
 * Derives the confirmed unread set from what was actually observed. Only posts on stored pages count
 * (the main post on the lowest observed page of each mode); never ReplyCount, page arithmetic or the
 * highest read ID. A post observed in either mode is one post: reading it in one mode reads it.
 */
export function buildReadingState(input: {
  threadId: ThreadId
  mode: ReadingMode
  positions: Record<ReadingMode, SavedPosition | null>
  readPostIds: PostId[]
  attention: AttentionRecord | null
  coverage: Record<ReadingMode, ThreadCoverage>
}): ThreadReadingState {
  const { threadId, coverage, attention } = input
  const read = new Set(input.readPostIds)
  const observed = new Map<PostId, UnreadPost['pages']>()
  const pagesOf = (postId: PostId) => {
    let pages = observed.get(postId)
    if (pages === undefined) {
      pages = { all: null, po: null }
      observed.set(postId, pages)
    }
    return pages
  }
  for (const mode of MODES) {
    const pages = coverage[mode].pages
    const first = pages[0]
    if (first === undefined) continue
    pagesOf(threadId)[mode] = first.page
    for (const page of pages) {
      for (const replyId of page.replyIds) {
        const entry = pagesOf(replyId)
        if (entry[mode] === null) entry[mode] = page.page
      }
    }
  }
  const unread: UnreadPost[] = [...observed]
    .filter(([postId]) => !read.has(postId))
    .map(([postId, pages]) => ({ postId, pages }))
    .sort((a, b) => comparePostIds(a.postId, b.postId))
  let attentionState: ThreadReadingState['attention'] = null
  if (attention !== null) {
    const { watermarkPostId: watermark, boundaryPostId: boundary } = attention
    const newUnreadIds: PostId[] = []
    const uncertainUnreadIds: PostId[] = []
    for (const { postId } of unread) {
      if (postId === threadId || (watermark !== null && comparePostIds(postId, watermark) <= 0)) continue
      if (boundary !== null && comparePostIds(postId, boundary) > 0) newUnreadIds.push(postId)
      else uncertainUnreadIds.push(postId)
    }
    attentionState = { ...attention, newUnreadIds, uncertainUnreadIds }
  }
  return {
    threadId,
    mode: input.mode,
    positions: input.positions,
    readPostIds: [...read].sort(comparePostIds),
    unread,
    attention: attentionState,
    coverage
  }
}

/** Reading state when storage is unavailable: nothing saved, nothing observed, nothing read. */
export function emptyReadingState(threadId: ThreadId): ThreadReadingState {
  return buildReadingState({
    threadId,
    mode: 'all',
    positions: { all: null, po: null },
    readPostIds: [],
    attention: null,
    coverage: { all: computeCoverage(threadId, 'all', [], null), po: computeCoverage(threadId, 'po', [], null) }
  })
}
