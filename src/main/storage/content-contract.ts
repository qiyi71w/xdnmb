import type { ContentUsage, OfflineCopy, RetainedEntry, RetainedList } from '../../shared/content'
import type { ThreadId, ThreadPage } from '../../shared/forum'

export interface ContentStore {
  listRetained(kind: RetainedList): Promise<RetainedEntry[]>
  /** Threads whose reading positions the same transaction cleared; empty when `clearReading` is false. */
  clearHistory(threadId: ThreadId | null, clearReading: boolean): Promise<ThreadId[]>
  getContentUsage(): Promise<ContentUsage>
  setCacheLimit(bytes: number): Promise<void>
  /** One bounded batch. Rechecks holders transactionally; file names have no remaining references. */
  evictContentBatch(clearAll: boolean): Promise<{ fileNames: string[]; more: boolean }>
  holdContentReader(holder: string, threadId: ThreadId): Promise<void>
  releaseContentReaders(prefix: string): Promise<void>
  getOfflineCopy(threadId: ThreadId): Promise<OfflineCopy | null>
  /** Keeps saved pages/posts/images on update. Resets only this attempt's errors and end candidate. */
  beginOfflineCopy(threadId: ThreadId, includeImages: boolean, at: string): Promise<OfflineCopy>
  /** Atomic page + union of offline post/page references. Never deletes old missing posts. */
  saveOfflinePage(page: ThreadPage, at: string): Promise<OfflineCopy>
  updateOfflineCopy(threadId: ThreadId, patch: Pick<OfflineCopy, 'state' | 'failedPage' | 'error' | 'imageFailures'>, at: string): Promise<OfflineCopy>
  /** Link a loaded original to this copy before releasing its temporary image reading holder. */
  holdOfflineImage(threadId: ThreadId, postId: string): Promise<void>
  /** Bounded cursor over retained image-bearing posts, including older pages omitted by the server. */
  listOfflineImagePosts(threadId: ThreadId, after: string | null, limit: number): Promise<string[]>
  /** Clear transient readers; mark interrupted saves while preserving completed parts. */
  recoverContent(): Promise<void>
}
