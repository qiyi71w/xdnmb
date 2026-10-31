import type { OperationId, QuoteLocation, ReadError } from '../../../../shared/api'
import type { Post, PostId, ThreadId } from '../../../../shared/forum'
import type { SearchError } from '../../../../shared/online-search'

/**
 * Result of an explicit 向 XDS 查询所属串. XDS only names a thread (a clue); the reader then checks
 * it with the forum, so only `located` is a verified target:
 * - `located`: the forum shows the post at that place now (or on its stored copy);
 * - `thread-known`: the forum thread is readable, but the post was not seen where it was looked for;
 *   opening the thread (打开原串) stays a separate choice and is no located target;
 * - `unconfirmed`: the forum could not confirm the named thread at all;
 * - `read-failed`: reading the named thread failed;
 * - `not-indexed`: XDS has no record of the post (this says nothing about the post being deleted);
 * - `search-failed`: the XDS request failed (network, rate limit, verification, …);
 * - `cancelled`: cancelled or no longer wanted; ignore it.
 */
export type ThreadLookup =
  | { status: 'located'; location: Extract<QuoteLocation, { status: 'located' }> }
  | { status: 'thread-known'; threadId: ThreadId; head: Post }
  | { status: 'unconfirmed'; threadId: ThreadId }
  | { status: 'read-failed'; threadId: ThreadId; error: ReadError }
  | { status: 'not-indexed' }
  | { status: 'search-failed'; error: SearchError }
  | { status: 'cancelled' }

/**
 * Asks XDS which thread `postId` belongs to, then lets the existing locate verify that thread
 * (its first page, as no page is known). Both steps run under `operationId`, so `reading.cancel`
 * stops whichever is running. `current` is checked between them: nothing is read once the lookup is
 * no longer wanted. A rejected IPC call rejects.
 */
export async function lookUpThread(operationId: OperationId, postId: PostId, current: () => boolean): Promise<ThreadLookup> {
  const clue = await window.xidao.onlineSearch.threadOf({ operationId, postId })
  if (!current()) return { status: 'cancelled' }
  switch (clue.status) {
    case 'cancelled':
    case 'not-indexed':
      return clue
    case 'failed':
      return { status: 'search-failed', error: clue.error }
    case 'found':
      break
  }
  const threadId = clue.threadId
  const location = await window.xidao.quotes.locate({ operationId, postId, hint: { threadId, page: null } })
  switch (location.status) {
    case 'located':
      return { status: 'located', location }
    case 'thread-known':
      return { status: 'thread-known', threadId: location.threadId, head: location.head }
    case 'unknown-thread':
      return { status: 'unconfirmed', threadId }
    case 'failed':
      return { status: 'read-failed', threadId: location.threadId ?? threadId, error: location.error }
    case 'cancelled':
      return location
  }
}
