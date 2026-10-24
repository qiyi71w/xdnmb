// Reading context shared by the main process and the renderer: per-thread mode preference,
// per-mode positions, per-post read records and the local attention start. These are separate
// records; none of them is derived from another, from ReplyCount or from the highest post ID.
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

/** Why the local attention start was first established. Later enables never move it. */
export type AttentionSource = 'subscription' | 'favorite' | 'reminder' | 'import'

/**
 * Local attention start and the classification of observed unread replies against it. `startedAt`
 * is the time boundary. Forum post times are not a verified clock, so which side of it a reply falls
 * on is proven only from local observations and the increasing order of forum post IDs:
 * - history: at or below `watermarkPostId` (existed before the start);
 * - new: at or above `firstProvenNewPostId` (posted after the start);
 * - uncertain: neither proven yet — never counted as new and never treated as read.
 */
export interface AttentionState {
  /** ISO-8601 local time attention first began on this machine. Never reset by source changes. */
  startedAt: string
  source: AttentionSource
  /**
   * Highest post ID this machine had observed anywhere when attention began, or `null` when nothing
   * had been observed. Posts at or below it existed before the start.
   */
  watermarkPostId: PostId | null
  /**
   * Lowest observed post ID proven to be posted after the start, or `null` while there is no such
   * evidence. Proof: the end of some thread (any thread, this one included) was observed at or after
   * the start, and this reply of that thread appeared above the highest reply ID seen then. Recomputed
   * from stored observations, so it can only move down as evidence accumulates.
   */
  firstProvenNewPostId: PostId | null
  /** Observed, unread replies provably posted after the start. */
  newUnreadIds: PostId[]
  /** Observed, unread replies that are neither provably history nor provably new. */
  uncertainUnreadIds: PostId[]
}

/** An observed post that has not been read, with the page it was observed on in each mode. */
export interface UnreadPost {
  postId: PostId
  pages: Record<ReadingMode, number | null>
}

export interface ThreadReadingState {
  threadId: ThreadId
  /** Saved mode preference for this thread; `all` until the reader chooses otherwise. */
  mode: ReadingMode
  positions: Record<ReadingMode, SavedPosition | null>
  /** Posts of this thread actually read in the foreground reader. */
  readPostIds: PostId[]
  /**
   * Confirmed unread: posts observed in stored pages of either mode (the main post included) that
   * are not read, ascending by ID. Posts on pages never observed are unknown, not listed here; see
   * `coverage` for gaps and end candidates.
   */
  unread: UnreadPost[]
  attention: AttentionState | null
  coverage: Record<ReadingMode, ThreadCoverage>
}


/** Result of a reading-state write. `saved` is false when local storage refused or failed it. */
export interface WriteResult {
  saved: boolean
}

export interface MarkReadResult extends WriteResult {
  /** Posts newly recorded as read by this call (already-read and unknown posts excluded). */
  marked: PostId[]
}
