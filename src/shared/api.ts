import type { BoardDirectory, FeedPage, FeedRef, ThreadCoverage, ThreadId, ThreadPage } from './forum'

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

export interface AppStatus {
  storage: StorageStatus
}

/** The only surface exposed to the renderer (window.xidao). */
export interface XidaoApi {
  reading: {
    loadDirectory(input: { operationId: OperationId; strategy: DirectoryStrategy }): Promise<ReadOutcome<BoardDirectory>>
    /** Foreground read; falls back to the stored page when the network read fails. */
    readFeedPage(input: { operationId: OperationId; feed: FeedRef; page: number }): Promise<ReadOutcome<FeedPage>>
    /** Foreground read of one `all`-mode thread page; falls back to the stored page on failure. */
    readThreadPage(input: { operationId: OperationId; threadId: ThreadId; page: number }): Promise<ReadOutcome<ThreadPageResult>>
    /** Bounded tail probe in the foreground lane; cancellable between and during page reads. */
    locateThreadEnd(input: { operationId: OperationId; threadId: ThreadId }): Promise<ReadOutcome<ThreadEndResult>>
    /** Cancels queued and in-flight reads of the operation. Unknown IDs are ignored. */
    cancel(input: { operationId: OperationId }): Promise<void>
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
  openExternal: 'links:open-external',
  getStatus: 'app:get-status'
} as const
