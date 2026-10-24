import type { BoardDirectory, FeedPage, FeedRef, Post, PostId, ReadingMode, ThreadCoverage, ThreadId, ThreadPage } from './forum'
import type { AppSettings, MarkReadResult, ReadingAnchor, ThreadReadingState, WriteResult } from './reading'
import type { SearchOutcome, SearchSessionId } from './search'

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

/**
 * Content of a quoted post (`/api/ref`). `threadId` is the owning thread when this machine has
 * observed the post in a thread page or a list; `null` means not known locally. The ref response
 * itself carries no thread or page, so ownership is never derived from it.
 */
export interface QuotePreview {
  post: Post
  threadId: ThreadId | null
}

/** Where a quote target is shown: a post verified on `page` of `mode` of its thread. */
export interface QuoteTarget {
  postId: PostId
  page: number
  mode: ReadingMode
}

/**
 * Unverified location clue from a search result link: the thread the link names and the page of the
 * full listing it points at (`null` = none). Used only after local records fail to locate the post,
 * and only by reading that one page of the thread; never a stored position.
 */
export interface LocateHint {
  threadId: ThreadId
  page: number | null
}

/**
 * Result of locating a quoted post. Only recorded ownership is used: the post's thread from local
 * observations, then the latest stored page of each mode that contained it, verified by reading
 * that page again; or, with no record at all, whether the post is itself a thread's main post.
 * Never scans a thread, trusts web-ref page numbers or guesses an owner.
 * - `located`: the post was found on `target.page` of `target.mode` now (`fresh`), or on the stored
 *   copy of that page after the network read failed (`cached`, `networkError` set).
 * - `thread-known`: the owning thread is known and was just read (its recorded page, or page 1 of the
 *   preferred mode when no stored page records the post), but the post was not on its recorded page
 *   or no page records it. Opening the thread (打开原串) is a separate user action.
 * - `unknown-thread`: no local record and the post is not a thread's main post.
 * - `failed`: reading what was needed failed; `threadId` when the owner is known.
 * - `cancelled`: superseded or cancelled; must be ignored.
 */
export type QuoteLocation =
  | { status: 'located'; threadId: ThreadId; head: Post; target: QuoteTarget; source: 'fresh' | 'cached'; networkError: ReadError | null }
  | { status: 'thread-known'; threadId: ThreadId; head: Post }
  | { status: 'unknown-thread' }
  | { status: 'failed'; threadId: ThreadId | null; error: ReadError }
  | { status: 'cancelled' }

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
  /**
   * Quote preview and location. Both are foreground reads that never mark anything read and never
   * navigate; the renderer decides what to do with a result.
   */
  quotes: {
    /** Network first (`/api/ref`), falling back to the stored post with the failure reason. */
    preview(input: { operationId: OperationId; postId: PostId }): Promise<ReadOutcome<QuotePreview>>
    /**
     * Resolves owner, page and mode of a quoted post; see QuoteLocation. Cancel with `reading.cancel`.
     * With `hint` (a search result link) the hinted page of the hinted thread is read once when local
     * records do not locate the post; a readable hinted thread that does not show it is `thread-known`.
     */
    locate(input: { operationId: OperationId; postId: PostId; hint?: LocateHint }): Promise<QuoteLocation>
  }
  /**
   * Online search (nmb-search). Requests happen only for `run`, a not-yet-obtained `page` and nothing
   * else; there is no retry, prefetch or background request. Sessions are scoped to the calling page
   * and released by `close` or when the page goes away. No forum identity is ever involved.
   */
  search: {
    /** Starts a new query chain in the session (creating it), superseding any earlier chain; returns page 1. */
    run(input: { sessionId: SearchSessionId; query: string }): Promise<SearchOutcome>
    /**
     * Page `page` of the current chain: an obtained page comes back from the session without a
     * request; the next page is requested with the chain's token at most once (concurrent calls share
     * the same request); anything else is `unavailable`.
     */
    page(input: { sessionId: SearchSessionId; page: number }): Promise<SearchOutcome>
    /** Cancels the session's in-flight request. A cancelled next-page request spends its token. */
    cancel(input: { sessionId: SearchSessionId }): Promise<void>
    /** Releases the session and its pages; an in-flight request is cancelled. */
    close(input: { sessionId: SearchSessionId }): Promise<void>
    /** Opens the search website (fixed URL) in the system browser. */
    openSite(): Promise<{ opened: boolean }>
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
  previewQuote: 'quotes:preview',
  locateQuote: 'quotes:locate',
  getReadingState: 'reading-state:get',
  setReadingMode: 'reading-state:set-mode',
  saveReadingPosition: 'reading-state:save-position',
  markRead: 'reading-state:mark-read',
  recordVisit: 'reading-state:record-visit',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  openExternal: 'links:open-external',
  getStatus: 'app:get-status',
  runSearch: 'search:run',
  searchPage: 'search:page',
  cancelSearch: 'search:cancel',
  closeSearch: 'search:close',
  openSearchSite: 'search:open-site'
} as const
