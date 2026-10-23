import type { StorageStatus } from '../../shared/api'
import type {
  BoardDirectory,
  FeedPage,
  FeedRef,
  PostId,
  PostImage,
  ReadingMode,
  ThreadCoverage,
  ThreadId,
  ThreadPage
} from '../../shared/forum'
import type { ImageFormat, ImageKind } from '../../shared/images'
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
 * Who keeps a managed image from cleanup. `reading`: a reader view of the running app (cleared at
 * startup). Drafts and offline copies add their own kinds when they start holding images.
 */
export interface ImageHolder {
  kind: 'reading'
  id: string
}

/** One stored image file: what it is, where it came from, when it was fetched. */
export interface ImageResourceRecord {
  id: number
  kind: ImageKind
  /** Absolute URL the bytes were fetched from. */
  sourceUrl: string
  /** Managed file name inside the app's image directory. */
  fileName: string
  format: ImageFormat
  bytes: number
  width: number
  height: number
  fetchedAt: string
}

export type NewImageResource = Omit<ImageResourceRecord, 'id'>

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

  /** Image location of a stored post; null when the post is not stored or has no image. */
  getPostImage(postId: PostId): Promise<PostImage | null>
  /** The stored resource for `kind` + `sourceUrl`; when found and `holder` is given, it is held too. */
  findImageResource(kind: ImageKind, sourceUrl: string, holder: ImageHolder | null): Promise<ImageResourceRecord | null>
  /**
   * Records a file already renamed into the image directory and holds it for `holders`, in one
   * transaction. An existing resource for the same kind + source keeps its ID and holders and now
   * points at the new file; `replacedFileName` is its previous file, which nothing references any more.
   */
  commitImageResource(
    resource: NewImageResource,
    holders: ImageHolder[]
  ): Promise<{ resource: ImageResourceRecord; replacedFileName: string | null }>
  /** Drops holders of `kind` whose ID starts with `idPrefix` (`''`: all of that kind). */
  releaseImageHolders(kind: ImageHolder['kind'], idPrefix: string): Promise<void>
  /**
   * Deletes the records of those `resourceIds` that no holder references, in one transaction, and
   * returns their file names for removal. Held resources are left untouched.
   */
  deleteUnheldImages(resourceIds: number[]): Promise<string[]>
  /** Every managed file name that a resource record points at. */
  listImageFileNames(): Promise<string[]>
  close(): Promise<void>
}
