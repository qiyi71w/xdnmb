import type { OperationId, ReadError } from './api'
import type { PostId, ReadingMode, ThreadCoverage, ThreadId } from './forum'

export interface ContentFilters {
  forumId: string | null
  /** Inclusive server-calendar date bounds YYYY-MM-DD, not inferred UTC instants. */
  fromDate: string | null
  toDate: string | null
  image: 'any' | 'with' | 'without'
}
export type SearchScope = { kind: 'local' } | { kind: 'thread'; threadId: ThreadId; mode: ReadingMode }
export interface SearchHit {
  retention: 'cache' | 'offline' | 'subscription'
  postId: PostId
  threadId: ThreadId | null
  threadTitle: string | null
  title: string | null
  excerpt: string
  forumId: string | null
  createdAt: string | null
  hasImage: boolean | null
  /** Metadata relevant to applied filters was unknown; never a definite negative. */
  uncertainFilters: boolean
  location: { page: number; mode: ReadingMode; fetchedAt: string; source: 'page' | 'offline' | 'list' } | null
}
export interface SearchCoverage {
  retainedPosts: number
  retainedThreads: number
  thread: ThreadCoverage | null
}
export type SearchResult<T> = { ok: true; value: T } | { ok: false; reason: 'storage' | 'index-unavailable' | 'cancelled' | 'busy' | 'expired' }
export interface SearchBatch {
  hits: SearchHit[]
  done: boolean
  coverage: SearchCoverage
}
export interface SearchFetch {
  operationId: OperationId
  threadId: ThreadId
  state: 'running' | 'stopped' | 'cancelled' | 'failed'
  pages: number[]
  failedPage: number | null
  error: ReadError | 'storage' | 'page-limit' | null
  coverage: ThreadCoverage
}
export interface ThreadFilterMetadata {
  threadId: ThreadId
  forumId: string | null
  createdAt: string | null
  hasImage: boolean | null
  /** Actual retained/observed unread content, not a total-reply-count estimate. */
  unreadCount: number | null
  coverageUnknown: boolean
}
export interface SearchApi {
  /** Starts a session and returns one bounded worker batch, even if the batch has no hits. No network. */
  start(input: { operationId: OperationId; query: string; scope: SearchScope; filters: ContentFilters }): Promise<SearchResult<SearchBatch>>
  /** Advances this fixed query/filter/scope session; parallel next calls return busy. */
  next(input: { operationId: OperationId }): Promise<SearchResult<SearchBatch>>
  /** Cancels search, fetch or rebuild; preserves already saved contents. */
  cancel(input: { operationId: OperationId }): Promise<void>
  /** Explicit only. Ordinary cached text, never offline ownership or read marking. */
  fetchThread(input: { operationId: OperationId; threadId: ThreadId }): Promise<SearchResult<SearchFetch>>
  fetchStatus(input: { operationId: OperationId }): Promise<SearchResult<SearchFetch>>
  /** Bounded batches yield to worker foreground persistence; user can cancel with operationId. */
  rebuild(input: { operationId: OperationId }): Promise<SearchResult<{ rebuilt: boolean }>>
  /** Local metadata for <=200 IDs; no download or read-state writes. */
  threadMetadata(input: { threadIds: ThreadId[] }): Promise<SearchResult<ThreadFilterMetadata[]>>
}
