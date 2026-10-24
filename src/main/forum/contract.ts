import type { ReadError } from '../../shared/api'
import type { BoardDirectory, FeedPage, FeedRef, Post, PostId, ReadingMode, ThreadId, ThreadPage } from '../../shared/forum'

/** A classified forum read failure. Never carries raw bodies, URLs with secrets or full server pages. */
export class ForumReadError extends Error {
  override readonly name = 'ForumReadError'
  constructor(readonly error: ReadError) {
    super(`forum read failed: ${error.kind}/${error.detail}`)
  }
}

/** The caller's AbortSignal fired. Distinct from timeout, which is a ForumReadError(network/timeout). */
export class ReadCancelledError extends Error {
  override readonly name = 'ReadCancelledError'
  constructor() {
    super('read cancelled')
  }
}

export interface TransportResponse {
  /** Lower-cased media type without parameters, e.g. `application/json`; `null` if absent. */
  mediaType: string | null
  /** Body decoded per Content-Encoding and charset. */
  text: string
}

/**
 * GET to an allow-listed origin. Resolves only for HTTP 200; every other outcome throws
 * ForumReadError (or ReadCancelledError when `signal` aborts). No retries, no redirects followed.
 * `credential` is sent as `Cookie: userhash=…` and only to a configured credential origin; any other
 * target with a credential is refused before connecting.
 */
export interface ForumTransport {
  get(url: URL, signal: AbortSignal, credential?: { userhash: string }): Promise<TransportResponse>
}

/** Public JSON read API of the forum, returning normalized content only. */
export interface ForumClient {
  /** getForumList + getTimelineList. */
  getDirectory(signal: AbortSignal): Promise<BoardDirectory>
  /** showf (forum) or timeline list page. */
  getFeedPage(feed: FeedRef, page: number, signal: AbortSignal): Promise<FeedPage>
  /** One thread page: `all` reads `thread`, `po` reads the PO-only `po` pages (own page numbering). */
  getThreadPage(threadId: ThreadId, mode: ReadingMode, page: number, signal: AbortSignal): Promise<ThreadPage>
  /**
   * One quoted post (`ref`). The response carries no owning thread or page; a missing post is the
   * forum's business error `该串不存在`, classified `not-found`.
   */
  getRef(postId: PostId, signal: AbortSignal): Promise<Post>
}
