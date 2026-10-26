import type { ReadError } from '../../shared/api'
import type { BoardDirectory, FeedPage, FeedRef, Post, PostId, ReadingMode, ThreadId, ThreadPage } from '../../shared/forum'

/** A classified failure; an optional verified lower page is normalized content, never a raw response. */
export class ForumReadError extends Error {
  override readonly name = 'ForumReadError'
  constructor(readonly error: ReadError, readonly readablePage?: ThreadPage) {
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

/** Internal per-call lane/budget seam: invoked once for each actual transport request. */
export type ForumRequestRunner = <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) => Promise<T>

/** Public JSON read API of the forum, returning normalized content only. */
export interface ForumClient {
  /** getForumList + getTimelineList. */
  getDirectory(signal: AbortSignal, options?: { requestRunner?: ForumRequestRunner }): Promise<BoardDirectory>
  /** showf (forum) or timeline list page. */
  getFeedPage(feed: FeedRef, page: number, signal: AbortSignal): Promise<FeedPage>
  /**
   * One thread page: `all` reads `thread`, `po` reads the PO-only `po` pages (own page numbering).
   * `anonymous` sends this read without the browse cookie. `requestRunner` also wraps the
   * page-100 probe when one is needed, so callers can account and space every HTTP request.
   */
  getThreadPage(threadId: ThreadId, mode: ReadingMode, page: number, signal: AbortSignal, options?: { anonymous?: boolean; requestRunner?: ForumRequestRunner }): Promise<ThreadPage>
  /**
   * One quoted post (`ref`). The response carries no owning thread or page; a missing post is the
   * forum's business error `该串不存在`, classified `not-found`.
   */
  getRef(postId: PostId, signal: AbortSignal, options?: { requestRunner?: ForumRequestRunner }): Promise<Post>
}
