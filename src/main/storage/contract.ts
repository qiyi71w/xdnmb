import type { StorageStatus } from '../../shared/api'
import type {
  BoardDirectory,
  FeedPage,
  FeedRef,
  PostId,
  ReadingMode,
  ThreadCoverage,
  ThreadId,
  ThreadPage
} from '../../shared/forum'
import type { AppSettings, AttentionSource, AttentionState, ReadingAnchor, ThreadReadingState } from '../../shared/reading'

/** A write was refused because the database is read-only (newer schema) or unavailable. */
export class StorageWriteRefusedError extends Error {
  override readonly name = 'StorageWriteRefusedError'
  constructor(readonly status: StorageStatus) {
    super(`storage write refused: ${status.state}`)
  }
}

export interface Stored<T> {
  value: T
  /** ISO-8601 time the content was fetched from the forum. */
  fetchedAt: string
}

/**
 * Persistence used by reading. Implemented by a single database worker owned by the main process;
 * every call is one short transaction executed serially in that worker.
 */
export interface ReadingStore {
  readonly status: StorageStatus
  saveDirectory(directory: BoardDirectory, fetchedAt: string): Promise<void>
  loadDirectory(): Promise<Stored<BoardDirectory> | null>
  saveFeedPage(page: FeedPage, fetchedAt: string): Promise<void>
  loadFeedPage(feed: FeedRef, page: number): Promise<Stored<FeedPage> | null>
  /** Saves posts, post→thread relations and the page observation; returns coverage from the same transaction. */
  saveThreadPage(page: ThreadPage, fetchedAt: string): Promise<ThreadCoverage>
  loadThreadPage(threadId: ThreadId, mode: ReadingMode, page: number): Promise<Stored<ThreadPage> | null>
  getThreadCoverage(threadId: ThreadId, mode: ReadingMode): Promise<ThreadCoverage>

  /** Mode preference, positions, read/unread posts, attention and both coverages of one thread. */
  getReadingState(threadId: ThreadId): Promise<ThreadReadingState>
  setReadingMode(threadId: ThreadId, mode: ReadingMode, at: string): Promise<void>
  saveReadingPosition(threadId: ThreadId, mode: ReadingMode, anchor: ReadingAnchor, at: string): Promise<void>
  /** Records posts observed in this thread as read; returns the ones newly recorded. */
  markPostsRead(threadId: ThreadId, postIds: PostId[], at: string): Promise<PostId[]>
  recordVisit(threadId: ThreadId, at: string): Promise<void>
  /**
   * Establishes the local attention start the first time attention begins (subscription, favorite,
   * reminder or import). Later calls, whatever their source, keep the original start and return it.
   * Never marks anything read.
   */
  establishAttention(threadId: ThreadId, source: AttentionSource, at: string): Promise<AttentionState>
  loadSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<void>
  close(): Promise<void>
}
