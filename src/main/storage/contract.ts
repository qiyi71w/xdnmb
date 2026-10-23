import type { StorageStatus } from '../../shared/api'
import type {
  BoardDirectory,
  FeedPage,
  FeedRef,
  ReadingMode,
  ThreadCoverage,
  ThreadId,
  ThreadPage
} from '../../shared/forum'

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
  close(): Promise<void>
}
