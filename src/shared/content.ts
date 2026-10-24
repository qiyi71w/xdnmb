import type { ReadError } from './api'
import type { PostId, ThreadId } from './forum'
import type { ImageError } from './images'

export const DEFAULT_CACHE_LIMIT = 2_000_000_000
export type RetainedList = 'favorites' | 'history' | 'offline'
export type ContentResult<T> = { ok: true; value: T } | { ok: false; reason: 'storage' | 'busy' }
export interface OfflineImageFailure { postId: PostId; error: ImageError }
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
export interface RetainedEntry {
  threadId: ThreadId
  title: string | null
  at: string
  offline: OfflineCopy | null
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
  list(input: { kind: RetainedList }): Promise<ContentResult<RetainedEntry[]>>
  favorite(input: { threadId: ThreadId; favorite: boolean }): Promise<ContentResult<boolean>>
  isFavorite(input: { threadId: ThreadId }): Promise<ContentResult<boolean>>
  /** Value: threads whose reading position and read records were cleared; empty when `clearReading` is false. */
  clearHistory(input: { threadId: ThreadId | null; clearReading: boolean }): Promise<ContentResult<ThreadId[]>>
  usage(): Promise<ContentResult<ContentUsage>>
  setCacheLimit(input: { bytes: number }): Promise<ContentResult<ContentUsage>>
  clearCache(): Promise<ContentResult<ContentUsage>>
  /** Returns promptly. Subsequent progress is persisted and read using offlineStatus/list. */
  saveOffline(input: { threadId: ThreadId; includeImages: boolean }): Promise<ContentResult<OfflineCopy>>
  offlineStatus(input: { threadId: ThreadId }): Promise<ContentResult<OfflineCopy | null>>
  cancelOffline(input: { threadId: ThreadId }): Promise<ContentResult<OfflineCopy | null>>
  /** Hold before fetching a mounted reader; release on unmount. No download or read marking. */
  holdReader(input: { viewId: string; threadId: ThreadId }): Promise<void>
  releaseReader(input: { viewId: string }): Promise<void>
}
