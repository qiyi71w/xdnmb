import type { Post } from '../../shared/forum'
import type { PublicationAttempt } from '../../shared/publication'
import type { ForumClient } from '../forum/contract'
import { carriesText } from './adapter'

/** Replies per thread page: the forum splits `ReplyCount` into pages of 19. */
const PAGE_SIZE = 19
/** Thread pages read back from the end, at most. */
const THREAD_PAGES = 3
/** Forum list pages read for a new thread. */
const FORUM_PAGES = 2
/** Allowance for the forum clock running behind this computer's. */
export const CLOCK_SLACK_MS = 2 * 60_000

const FORUM_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:\([^()]*\)| )(\d{2}):(\d{2}):(\d{2})$/

/** Forum `now` text is Beijing time (UTC+8) without a zone marker; `null` when unparsable. */
export function forumTime(text: string | null): number | null {
  const match = text === null ? null : FORUM_TIME.exec(text)
  if (match === null) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  return Date.UTC(year, month - 1, day, hour - 8, minute, second)
}

export type CheckOutcome =
  | { kind: 'found'; postId: string; threadId: string }
  | { kind: 'not-found' | 'ambiguous' }

/**
 * Whether this post is the attempt's own: same 饼干 ID, the same text by the publication check's
 * comparison, the given title and name, the same presence of an image, posted no earlier than the
 * send (less clock slack), at the send's target, and not already another send's result.
 */
function matches(post: Post, attempt: PublicationAttempt, since: number, claimed: ReadonlySet<string>): boolean {
  const { fields, attachmentId, target } = attempt.payload
  if (attempt.cookieId === null || post.userHash !== attempt.cookieId || claimed.has(post.id)) return false
  if (!carriesText(post.content, fields.content)) return false
  if ((fields.title !== '' && post.title !== fields.title) || (fields.name !== '' && post.name !== fields.name)) return false
  if ((attachmentId !== null) !== (post.image !== null)) return false
  const time = forumTime(post.createdAt)
  if (time === null || time < since) return false
  return target.kind === 'thread' ? post.forumId === target.forumId : post.id !== target.threadId
}

/**
 * Reads where the attempt's post would be and looks for it. Read-only: never sends. A reply is
 * looked for from the thread's last page backwards until a page starts before the send; a new
 * thread on the first pages of its forum. Read failures throw (`ForumReadError`).
 */
export async function findSentPost(attempt: PublicationAttempt, client: ForumClient, claimed: ReadonlySet<string>, signal: AbortSignal): Promise<CheckOutcome> {
  const since = Date.parse(attempt.createdAt) - CLOCK_SLACK_MS
  const { target } = attempt.payload
  const found = new Map<string, Post>()
  const consider = (posts: Post[]) => { for (const post of posts) if (matches(post, attempt, since, claimed)) found.set(post.id, post) }

  if (target.kind === 'thread') {
    for (let page = 1; page <= FORUM_PAGES; page++) consider((await client.getFeedPage({ kind: 'forum', id: target.forumId }, page, signal)).threads.map(thread => thread.head))
  } else {
    const first = await client.getThreadPage(target.threadId, 'all', 1, signal)
    const read = (number: number) => number === 1 ? Promise.resolve(first) : client.getThreadPage(target.threadId, 'all', number, signal)
    let page = first.replyCount === null ? 1 : Math.max(1, Math.ceil(first.replyCount / PAGE_SIZE))
    let current = await read(page)
    let reads = 1
    // A full last page may already be followed by one the count does not show yet; it counts too.
    if (current.replies.length === PAGE_SIZE) {
      consider((await read(page + 1)).replies)
      reads++
    }
    for (;;) {
      consider(current.replies)
      const opening = forumTime(current.replies[0]?.createdAt ?? null)
      // Earlier pages only hold earlier replies.
      if (page === 1 || reads >= THREAD_PAGES || (opening !== null && opening < since)) break
      current = await read(--page)
      reads++
    }
  }

  if (found.size !== 1) return { kind: found.size === 0 ? 'not-found' : 'ambiguous' }
  const post = [...found.values()][0]!
  return { kind: 'found', postId: post.id, threadId: target.kind === 'thread' ? post.id : target.threadId }
}
