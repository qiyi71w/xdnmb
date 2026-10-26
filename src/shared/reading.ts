// Reading context shared by the main process and the renderer: per-thread mode preference and
// per-mode positions. These are separate records; neither is derived from the other, from
// ReplyCount or from the highest post ID.
import type { PostId, ReadingMode, ThreadCoverage, ThreadId } from './forum'

/**
 * Stable reading anchor. The post ID identifies the content; `page` is auxiliary (where the post
 * was observed in this mode when the anchor was taken) and only used to load the right page.
 */
export interface ReadingAnchor {
  postId: PostId
  /** Page of the post in the anchor's mode; auxiliary, never the identity of the position. */
  page: number
  /** Where the reading line falls inside the post: 0 = its top edge, 1 = its bottom edge. */
  offsetRatio: number
  /** Distance in CSS pixels from the top of the reading viewport to the reading line. */
  viewportOffset: number
}

export interface SavedPosition {
  anchor: ReadingAnchor
  /** ISO-8601 time the position was saved. */
  savedAt: string
}

export interface ThreadReadingState {
  threadId: ThreadId
  /** Saved mode preference for this thread; `all` until the reader chooses otherwise. */
  mode: ReadingMode
  positions: Record<ReadingMode, SavedPosition | null>
  coverage: Record<ReadingMode, ThreadCoverage>
}

/** Result of a reading-state write. `saved` is false when local storage refused or failed it. */
export interface WriteResult {
  saved: boolean
}
