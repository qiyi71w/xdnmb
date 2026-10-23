import type { BoardDirectory, FeedPage, FeedRef, PostId, ReadingMode, ThreadCoverage, ThreadId, ThreadPage } from './forum'
import type { ImageLoadOutcome, ImageLoadRequest, ImageSaveOutcome, ImageViewId } from './images'
import type { AppSettings, MarkReadResult, ReadingAnchor, ThreadReadingState, WriteResult } from './reading'

/**
 * Classified read failure. Server/body text is never included except a short
 * business message the forum itself returned (e.g. "该串不存在").
 */
export type ReadErrorKind =
  | 'not-found'
  | 'permission'
  | 'rate-limited'
  | 'network'
  | 'unknown-structure'

export type ReadErrorDetail =
  | 'timeout'
  | 'connection'
  | 'http-status'
  | 'redirect'
  | 'too-large'
  | 'decode'
  | 'html'
  | 'json'
  | 'shape'
  | 'business'

export interface ReadError {
  kind: ReadErrorKind
  detail: ReadErrorDetail
  httpStatus?: number
  /** Short forum-provided business message, at most 200 characters. */
  serverMessage?: string
}

/**
 * Result of a named read operation.
 * - `fresh`: obtained from the forum now. `saved` is false when local storage refused/failed the write.
 * - `cached`: served from local storage. `networkError` is the failure that caused the fallback,
 *   or `null` when the cache was explicitly preferred.
 * - `failed`: nothing to show. `cancelled`: the caller cancelled; the result must be ignored.
 */
export type ReadOutcome<T> =
  | { status: 'fresh'; data: T; fetchedAt: string; saved: boolean }
  | { status: 'cached'; data: T; fetchedAt: string; networkError: ReadError | null }
  | { status: 'failed'; error: ReadError }
  | { status: 'cancelled' }

export interface ThreadPageResult {
  page: ThreadPage
  coverage: ThreadCoverage
}

/**
 * Bounded tail probe: estimate from ReplyCount, then verify by probing at most two pages forward
 * and two backward.
 * - `located`: `lastPage` is the last page with replies (or an empty page 1) and `endCandidatePage`
 *   is the observed end-candidate page that proves it (equal to `lastPage` for an empty page 1).
 * - `insufficient`: the bound was exhausted without a verifiable end.
 * - `interrupted`: a probe failed after earlier probes succeeded; carries what was observed.
 */
export type ThreadEndResult =
  | { status: 'located'; lastPage: ThreadPageResult; endCandidatePage: number; probedPages: number[] }
  | { status: 'insufficient'; probedPages: number[]; coverage: ThreadCoverage }
  | { status: 'interrupted'; probedPages: number[]; coverage: ThreadCoverage; failedPage: number; error: ReadError }

export type DirectoryStrategy =
  /** Use stored directory if any; otherwise fetch in the foreground lane. */
  | 'cache-first'
  /** Fetch in the background lane (yields to foreground reads); fall back to stored directory. */
  | 'background-refresh'
  /** Fetch in the foreground lane; fall back to stored directory. */
  | 'refresh'

/** Caller-generated ID used to cancel an operation; 1–64 chars of [A-Za-z0-9_-]. */
export type OperationId = string

export type StorageStatus =
  | { state: 'ready'; schemaVersion: number }
  /** Database written by a newer app version: reads allowed, all writes refused. */
  | { state: 'read-only'; reason: 'newer-schema'; schemaVersion: number; supportedVersion: number }
  /** Database could not be opened or migrated; the original file is left untouched. */
  | { state: 'unavailable'; reason: 'open-failed' | 'migration-failed' }

/** Desktop platform of the running app; decides which modifier keys the shortcuts use. */
export type AppPlatform = 'darwin' | 'win32' | 'linux'

export interface AppStatus {
  storage: StorageStatus
  platform: AppPlatform
}

/** Upper bound of post IDs per `markRead` call. */
export const MAX_MARK_READ_IDS = 2000

/** The only surface exposed to the renderer (window.xidao). */
export interface XidaoApi {
  reading: {
    loadDirectory(input: { operationId: OperationId; strategy: DirectoryStrategy }): Promise<ReadOutcome<BoardDirectory>>
    /** Foreground read; falls back to the stored page when the network read fails. */
    readFeedPage(input: { operationId: OperationId; feed: FeedRef; page: number }): Promise<ReadOutcome<FeedPage>>
    /**
     * Foreground read of one thread page in the given mode (`po` reads the forum's PO-only pages);
     * falls back to the stored page of the same mode on failure. Modes never stand in for each other.
     */
    readThreadPage(input: { operationId: OperationId; threadId: ThreadId; mode: ReadingMode; page: number }): Promise<ReadOutcome<ThreadPageResult>>
    /** Bounded tail probe of one mode in the foreground lane; cancellable between and during page reads. */
    locateThreadEnd(input: { operationId: OperationId; threadId: ThreadId; mode: ReadingMode }): Promise<ReadOutcome<ThreadEndResult>>
    /** Cancels queued and in-flight reads of the operation. Unknown IDs are ignored. */
    cancel(input: { operationId: OperationId }): Promise<void>
  }
  /** Local reading context. Never touches the network; downloads and previews never call it. */
  readingState: {
    /** Mode preference, per-mode positions, read/unread posts, attention and coverage of one thread. */
    get(input: { threadId: ThreadId }): Promise<ThreadReadingState>
    /** Saves the thread's mode preference. Temporary target display must not call this. */
    setMode(input: { threadId: ThreadId; mode: ReadingMode }): Promise<WriteResult>
    /** Saves the position of one mode; the other mode's position is untouched. */
    savePosition(input: { threadId: ThreadId; mode: ReadingMode; anchor: ReadingAnchor }): Promise<WriteResult>
    /**
     * Records posts as read. Called only by the foreground reader's dwell judgement and by the explicit
     * “全部标为已读” with the confirmed unread IDs it showed. Posts not observed in this thread are ignored.
     */
    markRead(input: { threadId: ThreadId; postIds: PostId[] }): Promise<MarkReadResult>
    /** Records a visit to the thread (browsing history). Not a navigation step and not a read. */
    recordVisit(input: { threadId: ThreadId }): Promise<WriteResult>
  }
  settings: {
    get(): Promise<AppSettings>
    update(input: Partial<AppSettings>): Promise<WriteResult & { settings: AppSettings }>
  }
  /**
   * Post images. The caller names a stored post, never a URL or path; requests go only to the
   * forum image server, without cookies or credentials, and never follow redirects.
   */
  images: {
    /**
     * Fetches (or reuses) the post's thumbnail or original as a managed file, judged by its actual
     * bytes, and protects it from cleanup while `viewId` is held. Originals are queued before thumbnails.
     */
    load(input: ImageLoadRequest): Promise<ImageLoadOutcome>
    /** Cancels a queued or running `load` of this caller. Unknown IDs are ignored. */
    cancel(input: { operationId: OperationId }): Promise<void>
    /** The view closed: its images are no longer protected by reading. */
    releaseView(input: { viewId: ImageViewId }): Promise<void>
    /**
     * Asks where to save with the system dialog and writes a copy of the post's stored original,
     * named by its detected format. Never saves a thumbnail instead.
     */
    saveOriginal(input: { postId: PostId }): Promise<ImageSaveOutcome>
  }
  links: {
    /** Opens an absolute http(s) URL in the system browser; anything else is refused. */
    openExternal(input: { url: string }): Promise<{ opened: boolean }>
  }
  app: {
    getStatus(): Promise<AppStatus>
  }
}

/** IPC channel names. Each maps 1:1 to an XidaoApi method; there is no generic channel. */
export const IpcChannel = {
  loadDirectory: 'reading:load-directory',
  readFeedPage: 'reading:read-feed-page',
  readThreadPage: 'reading:read-thread-page',
  locateThreadEnd: 'reading:locate-thread-end',
  cancel: 'reading:cancel',
  getReadingState: 'reading-state:get',
  setReadingMode: 'reading-state:set-mode',
  saveReadingPosition: 'reading-state:save-position',
  markRead: 'reading-state:mark-read',
  recordVisit: 'reading-state:record-visit',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  openExternal: 'links:open-external',
  loadImage: 'images:load',
  cancelImage: 'images:cancel',
  releaseImageView: 'images:release-view',
  saveOriginalImage: 'images:save-original',
  getStatus: 'app:get-status'
} as const
