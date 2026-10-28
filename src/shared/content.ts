import type { ReadError } from './api'
import type { Post, PostId, ThreadId } from './forum'
import type { ImageError } from './images'

export const DEFAULT_CACHE_LIMIT = 2_000_000_000
export type ContentResult<T> = { ok: true; value: T } | { ok: false; reason: 'storage' | 'busy' }
export interface OfflineImageFailure { postId: PostId; error: ImageError }
/** Deletion is committed even when the following cache maintenance fails. */
export interface OfflineDeletion { cacheCleanup: 'complete' | 'failed' }
export const OFFLINE_CHANGED_CHANNEL = 'content:offline-changed'
/** Coverage is an observation, never a complete or consistent server snapshot. */
export interface OfflineCopy {
  threadId: ThreadId
  createdAt: string
  updatedAt: string
  includeImages: boolean
  state: 'saving' | 'stopped' | 'cancelled' | 'interrupted'
  pages: number[]
  endCandidatePage: number | null
  postCount: number
  imageCount: number
  savedImages: number
  imageFailures: OfflineImageFailure[]
  failedPage: number | null
  error: ReadError | 'storage' | 'page-limit' | null
}
/** One 浏览记录 row: the thread's retained head fields at its last visit. */
export interface RetainedEntry {
  threadId: ThreadId
  title: string | null
  /** Complete cached head for the shared preview rules; null once evicted or never fetched. */
  head: Post | null
  /** Latest locally observed all-replies count; unknown is never presented as zero. */
  replyCount: number | null
  /** Last visit. */
  at: string
  offline: OfflineCopy | null
}
/** One 离线 row: the thread as held on this machine, and its copy. Nothing is fetched to fill it. */
export interface OfflineEntry {
  threadId: ThreadId
  /** Main post as held locally; null when it was never saved or cached. Unprovided fields stay unknown. */
  head: Post | null
  /** Last title seen for the thread; kept when its head is not held. */
  title: string | null
  /** Reply count reported by the copy's most recently saved page that had one; null when none did. */
  replyCount: number | null
  copy: OfflineCopy
}
export interface ContentUsage {
  limitBytes: number
  /** UTF-8 payload and derived search bytes of unprotected cached content. */
  cacheTextBytes: number
  /** Actual bytes of image files without holders. */
  cacheImageBytes: number
  protectedTextBytes: number
  protectedImageBytes: number
  /** Logical personal records, separate from cached content. */
  personalDataBytes: number
  /** Database + WAL physical allocation; not a promise of immediate shrinking. */
  databaseBytes: number
  overLimit: boolean
  protectedOverLimit: boolean
}
export interface ContentApi {
  /** 浏览记录, most recently visited first. */
  listHistory(): Promise<ContentResult<RetainedEntry[]>>
  /** Offline copies, most recently first saved first; updating a copy keeps its place. */
  listOffline(): Promise<ContentResult<OfflineEntry[]>>
  /** Value: threads whose reading positions were cleared; empty when `clearReading` is false. */
  clearHistory(input: { threadId: ThreadId | null; clearReading: boolean }): Promise<ContentResult<ThreadId[]>>
  usage(): Promise<ContentResult<ContentUsage>>
  setCacheLimit(input: { bytes: number }): Promise<ContentResult<ContentUsage>>
  clearCache(): Promise<ContentResult<ContentUsage>>
  /** Returns promptly. Subsequent progress is persisted and read using offlineStatus/list. */
  saveOffline(input: { threadId: ThreadId; includeImages: boolean }): Promise<ContentResult<OfflineCopy>>
  offlineStatus(input: { threadId: ThreadId }): Promise<ContentResult<OfflineCopy | null>>
  cancelOffline(input: { threadId: ThreadId }): Promise<ContentResult<OfflineCopy | null>>
  deleteOffline(input: { threadId: ThreadId }): Promise<ContentResult<OfflineDeletion>>
  /** Main-process invalidation after a copy is deleted; reread to avoid stale snapshots. */
  onOfflineChanged(listener: (threadId: ThreadId) => void): () => void
  /** Hold before fetching a mounted reader; release on unmount. No download. */
  holdReader(input: { viewId: string; threadId: ThreadId }): Promise<void>
  releaseReader(input: { viewId: string }): Promise<void>
}
